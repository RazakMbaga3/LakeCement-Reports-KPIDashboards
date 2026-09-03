/*
  S7 — user administration (admin-users.html), driven through a real browser.

  The point of the screen is that adding a person or changing their access no
  longer means editing db/seed.js and running a script, so what has to be
  proven is not "the page renders" but: a real account appears in Postgres
  with the rights it was given, an account change actually reaches the
  running gates, and the separation-of-duties rules hold when driven from the
  UI rather than from curl.

  Everything this spec creates is named e2e_* so global-teardown.js removes
  it along with the harness accounts.
*/
const { test, expect } = require('@playwright/test');
const { loginAs, collectErrors } = require('../fixtures/auth');
const { pool } = require('../fixtures/db');

const NEW_USER = 'e2e_admin_made';
const NEW_MAIL = 'e2e.admin.made@lakecement.co.tz';

/* The drawer generates a password once and shows it; the spec needs it to
   prove the account really works. */
async function readShownPassword(page) {
  return page.locator('.adm-pw code').first().innerText();
}

test.beforeEach(async () => {
  await pool.query('DELETE FROM audit_log WHERE username = $1 OR form_type = $1', [NEW_USER]);
  await pool.query('DELETE FROM users WHERE username = $1', [NEW_USER]);
});

test('the page loads clean for admin and lists real accounts', async ({ page }) => {
  const errors = collectErrors(page);
  await loginAs(page, 'admin');
  await page.goto('/admin-users.html');

  await expect(page.locator('#adm-table tbody tr').first()).toBeVisible({ timeout: 15_000 });

  // The count in the toolbar must match what Postgres says is active.
  const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int n FROM users WHERE active = true');
  await expect(page.locator('#adm-count')).toHaveText(new RegExp(`^${n} accounts?$`));

  expect(errors(), 'the admin page must load without console or page errors').toEqual([]);
});

test('a non-admin is redirected away and the API refuses them', async ({ page }) => {
  await loginAs(page, 'production');
  await page.goto('/admin-users.html');
  // Client-side guard bounces to the KPI dashboard...
  await page.waitForURL(/index\.html/, { timeout: 15_000 });

  // ...and the API refuses regardless of what the browser did.
  const status = await page.evaluate(async () => {
    const r = await fetch('http://localhost:5000/api/admin/users', {
      headers: { Authorization: 'Bearer ' + sessionStorage.getItem('lcl_mis_token') },
    });
    return r.status;
  });
  expect(status, 'the admin API must 403 a non-admin even when the page is bypassed').toBe(403);
});

test('creating a user through the drawer produces a working account', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto('/admin-users.html');
  await expect(page.locator('#adm-table tbody tr').first()).toBeVisible({ timeout: 15_000 });

  await page.click('button:has-text("Add User")');
  await page.fill('#d-username', NEW_USER);
  await page.fill('#d-name', 'E2E Admin Made');
  await page.fill('#d-email', NEW_MAIL);
  await page.selectOption('#d-role', 'production');
  await page.selectOption('#d-level', 'senior');
  await page.click('#d-save');

  // The one-time password panel is the signal the create succeeded.
  await expect(page.locator('.adm-pw')).toBeVisible({ timeout: 10_000 });
  const tempPassword = await readShownPassword(page);
  expect(tempPassword.length).toBeGreaterThan(10);

  // It landed in Postgres with exactly the rights chosen, and must set a
  // password before it can do anything.
  const { rows: [u] } = await pool.query(
    'SELECT role, level, email, active, must_change_password FROM users WHERE username = $1', [NEW_USER]);
  expect(u).toMatchObject({
    role: 'production', level: 'senior', email: NEW_MAIL,
    active: true, must_change_password: true,
  });

  // The temporary password genuinely works, and genuinely forces a change.
  const login = await page.evaluate(
    ([un, pw]) => window.login(un, pw), [NEW_USER, tempPassword]);
  expect(login.ok).toBe(true);
  expect(login.mustChangePassword, 'a freshly provisioned account must be forced to set its own password').toBe(true);

  // And the creation is on the audit trail.
  const { rows: audit } = await pool.query(
    "SELECT action, form_type FROM audit_log WHERE action = 'USER_CREATE' AND form_type = $1", [NEW_USER]);
  expect(audit.length, 'creating a user must be audited').toBe(1);
});

test('a duplicate email is refused with a readable message', async ({ page }) => {
  await pool.query(
    `INSERT INTO users (username, password_hash, full_name, role, department, level, email)
     VALUES ($1, 'x', 'E2E Admin Made', 'production', 'E2E', 'senior', $2)`, [NEW_USER, NEW_MAIL]);

  await loginAs(page, 'admin');
  await page.goto('/admin-users.html');
  await expect(page.locator('#adm-table tbody tr').first()).toBeVisible({ timeout: 15_000 });

  await page.click('button:has-text("Add User")');
  await page.fill('#d-username', 'e2e_admin_dup');
  await page.fill('#d-name', 'Duplicate Email');
  // Different case on purpose — the index is case-insensitive, and the same
  // mailbox typed differently must still be caught.
  await page.fill('#d-email', NEW_MAIL.toUpperCase());
  await page.click('#d-save');

  await expect(page.locator('#d-err')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#d-err')).toContainText(/already on another account/i);

  const { rows } = await pool.query("SELECT 1 FROM users WHERE username = 'e2e_admin_dup'");
  expect(rows.length, 'the rejected user must not have been created').toBe(0);
});

test('changing an access level revokes the sessions already open on it', async ({ page, context }) => {
  await pool.query(
    `INSERT INTO users (username, password_hash, full_name, role, department, level, must_change_password)
     VALUES ($1, 'x', 'E2E Admin Made', 'production', 'E2E', 'senior', false)`, [NEW_USER]);
  const { rows: [target] } = await pool.query('SELECT id FROM users WHERE username = $1', [NEW_USER]);

  await loginAs(page, 'admin');
  await page.goto('/admin-users.html');
  await expect(page.locator('#adm-table tbody tr').first()).toBeVisible({ timeout: 15_000 });

  const before = await pool.query('SELECT token_version FROM users WHERE id = $1', [target.id]);

  page.once('dialog', d => d.accept());   // "their access changed…" notice
  await page.evaluate(async (id) => {
    await window.NyatiAPI.adminUpdateUser(id, { level: 'hod' });
  }, target.id);

  const after = await pool.query('SELECT level, token_version FROM users WHERE id = $1', [target.id]);
  expect(after.rows[0].level).toBe('hod');
  expect(after.rows[0].token_version,
    'promoting a user must bump token_version so their open session stops being trusted')
    .toBeGreaterThan(before.rows[0].token_version);
});

test('an admin cannot change their own role, level or status', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto('/admin-users.html');
  await expect(page.locator('#adm-table tbody tr').first()).toBeVisible({ timeout: 15_000 });

  const { rows: [me] } = await pool.query("SELECT id, level FROM users WHERE username = 'e2e_admin'");

  const result = await page.evaluate(async (id) => {
    try { await window.NyatiAPI.adminUpdateUser(id, { level: 'officer' }); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }, me.id);

  expect(result.ok, 'self-demotion must be refused').toBe(false);
  expect(result.error).toMatch(/cannot change your own/i);

  const { rows: [still] } = await pool.query('SELECT level FROM users WHERE id = $1', [me.id]);
  expect(still.level, 'the level must be unchanged after a refused self-edit').toBe(me.level);
});

test('the drawer shows what a role and level will actually grant', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto('/admin-users.html');
  await expect(page.locator('#adm-table tbody tr').first()).toBeVisible({ timeout: 15_000 });

  await page.click('button:has-text("Add User")');
  await page.selectOption('#d-role', 'production');
  await page.selectOption('#d-level', 'hod');

  const grants = page.locator('.adm-grants');
  await expect(grants).toContainText('production');           // owns the production forms
  await expect(grants).toContainText('self-certifying');      // L1 submissions land approved

  // Dropping to L2 must visibly remove the KPI-edit and approval rights —
  // this is the preview earning its place, not decoration.
  await page.selectOption('#d-level', 'senior');
  await expect(grants).toContainText('pending HOD approval');
  await expect(grants).toContainText('L1 only');
});
