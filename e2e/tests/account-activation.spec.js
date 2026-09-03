/*
  S8 — account activation and password reset through the emailed link.

  backend/test/auth-tokens.test.js already proves the token store's rules.
  This proves the flow a real person walks: arrive on set-password.html with
  a link, choose a password nobody else knows, and sign in with it — plus
  the failure modes they will actually hit, which are a link used twice and
  a link that has expired.

  The token is issued directly rather than scraped out of an email: mail
  delivery is covered by backend/test/auth-mail.test.js, and going through
  a real mailbox here would make the suite depend on SMTP being configured.
*/
const { test, expect } = require('@playwright/test');
const { pool } = require('../fixtures/db');
const authTokens = require('../../backend/services/authTokens');

const USERNAME = 'e2e_activate';
const EMAIL    = 'e2e.activate@lakecement.co.tz';
const NEW_PW   = 'ChosenByMe2026';

async function makeUser({ mustChange = true } = {}) {
  /* Order matters, exactly as global-teardown.js documents: audit_log.user_id
     is a plain REFERENCES with no ON DELETE clause, so once a previous test
     has activated this account (writing ACCOUNT_ACTIVATED) the user row can
     only be dropped after its audit rows. auth_tokens does cascade, but is
     cleared explicitly so the intent is not left to the schema. */
  const { rows: prior } = await pool.query('SELECT id FROM users WHERE username = $1', [USERNAME]);
  if (prior[0]) {
    await pool.query('DELETE FROM auth_tokens WHERE user_id = $1', [prior[0].id]);
    await pool.query('DELETE FROM audit_log WHERE user_id = $1 OR username = $2', [prior[0].id, USERNAME]);
  }
  await pool.query('DELETE FROM users WHERE username = $1', [USERNAME]);
  const { rows } = await pool.query(
    `INSERT INTO users (username, password_hash, full_name, role, department, level,
                        email, active, must_change_password, email_verified)
     VALUES ($1,'x','E2E Activate','production','E2E','senior',$2,true,$3,false) RETURNING id`,
    [USERNAME, EMAIL, mustChange]);
  return rows[0].id;
}

test('an invited user sets their own password and can then sign in', async ({ page }) => {
  const id = await makeUser();
  const token = await authTokens.issue({ userId: id, email: EMAIL, purpose: 'invite' });

  await page.goto(`/set-password.html?t=${encodeURIComponent(token)}&p=invite`);

  // The page greets them by name — proof it validated the link before
  // asking for anything.
  await expect(page.locator('.who')).toContainText('E2E Activate', { timeout: 10_000 });
  await expect(page.locator('.who')).toContainText(USERNAME);

  // The submit button stays disabled until the rules pass AND the
  // confirmation matches.
  await expect(page.locator('#go')).toBeDisabled();
  await page.fill('#pw1', 'short');
  await expect(page.locator('#go')).toBeDisabled();
  await page.fill('#pw1', NEW_PW);
  await expect(page.locator('#go')).toBeDisabled();          // confirmation still empty
  await page.fill('#pw2', 'ChosenByMe2027');                  // mismatched
  await expect(page.locator('#go')).toBeDisabled();
  await page.fill('#pw2', NEW_PW);
  await expect(page.locator('#go')).toBeEnabled();

  await page.click('#go');
  await expect(page.locator('.msg-ok')).toBeVisible({ timeout: 10_000 });

  // The account is activated: password set, no forced change, and following
  // the link counted as proving the mailbox reaches them.
  const { rows: [u] } = await pool.query(
    'SELECT must_change_password, email_verified FROM users WHERE id = $1', [id]);
  expect(u.must_change_password).toBe(false);
  expect(u.email_verified, 'following an emailed link proves the address works').toBe(true);

  // And the password they chose actually signs them in.
  await page.goto('/login.html');
  const r = await page.evaluate(([un, pw]) => window.login(un, pw), [USERNAME, NEW_PW]);
  expect(r.ok).toBe(true);
  expect(r.mustChangePassword).toBe(false);
});

test('the same link cannot be used twice', async ({ page }) => {
  const id = await makeUser();
  const token = await authTokens.issue({ userId: id, email: EMAIL, purpose: 'invite' });

  await page.goto(`/set-password.html?t=${encodeURIComponent(token)}&p=invite`);
  await page.fill('#pw1', NEW_PW);
  await page.fill('#pw2', NEW_PW);
  await page.click('#go');
  await expect(page.locator('.msg-ok')).toBeVisible({ timeout: 10_000 });

  // Second visit with the same link: refused, and told why.
  await page.goto(`/set-password.html?t=${encodeURIComponent(token)}&p=invite`);
  await expect(page.locator('.msg-err')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.msg-err')).toContainText(/already been used/i);
  await expect(page.locator('#pw1')).toHaveCount(0, { timeout: 5_000 });
});

test('an expired link is refused before the form is shown', async ({ page }) => {
  const id = await makeUser();
  const token = await authTokens.issue({ userId: id, email: EMAIL, purpose: 'reset' });
  await pool.query(
    "UPDATE auth_tokens SET expires_at = NOW() - interval '1 hour' WHERE user_id = $1 AND used_at IS NULL", [id]);

  await page.goto(`/set-password.html?t=${encodeURIComponent(token)}&p=reset`);
  await expect(page.locator('.msg-err')).toContainText(/expired/i, { timeout: 10_000 });
  await expect(page.locator('#pw1'), 'no password field on a dead link').toHaveCount(0);
});

test('a tampered token is refused', async ({ page }) => {
  await page.goto('/set-password.html?t=totally-made-up-token&p=invite');
  await expect(page.locator('.msg-err')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#pw1')).toHaveCount(0);
});

test('forgot-password answers the same for a known and an unknown address', async ({ page }) => {
  await makeUser();
  await page.goto('/forgot-password.html');

  const ask = (email) => page.evaluate(async (e) => {
    const r = await fetch('http://localhost:5000/api/auth/forgot-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: e }),
    });
    return { status: r.status, body: await r.json() };
  }, email);

  const known   = await ask(EMAIL);
  const unknown = await ask('nobody.at.all@lakecement.co.tz');

  expect(known.status).toBe(unknown.status);
  expect(known.body.message, 'the response must not reveal whether an account exists')
    .toBe(unknown.body.message);
});

test('the login page offers a way in for someone who has forgotten', async ({ page }) => {
  await page.goto('/login.html');
  const link = page.locator('a[href="forgot-password.html"]');
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.locator('#email')).toBeVisible({ timeout: 10_000 });
});

test.afterAll(async () => {
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [USERNAME]);
  if (rows[0]) {
    await pool.query('DELETE FROM auth_tokens WHERE user_id = $1', [rows[0].id]);
    await pool.query('DELETE FROM audit_log WHERE user_id = $1 OR username = $2', [rows[0].id, USERNAME]);
    await pool.query('DELETE FROM users WHERE id = $1', [rows[0].id]);
  }
});
