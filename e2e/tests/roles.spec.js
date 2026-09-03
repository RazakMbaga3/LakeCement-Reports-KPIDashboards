/*
  S6 — the role matrix, driven through a real browser.

  backend/test/access-consistency.test.js already proves auth.js and
  forms/access-registry.js agree with each other. This proves the RUNNING UI
  honours them: that sidebar.js renders exactly the permitted departments,
  that the Fill button appears only where a save would actually succeed, and
  that switchDept() refuses a department the role cannot view even when
  called directly.
*/
const { test, expect } = require('@playwright/test');
const { loginAs, loginViaForm, collectErrors } = require('../fixtures/auth');
const { pool } = require('../fixtures/db');
const { ROLES, expandView, expandEdit, username, E2E_PASSWORD } = require('../fixtures/roles');

/* Exposed to page.evaluate() by name in the lockout test below. */
const E2E_PASSWORD_FOR_TEST = E2E_PASSWORD;

test('the real login form works end to end', async ({ page }) => {
  await loginViaForm(page, 'admin');
  await page.waitForURL(/portal\.html|index\.html/, { timeout: 15_000 });
  const session = await page.evaluate(() => sessionStorage.getItem('lcl_mis_session'));
  expect(session, 'a session must be stored after a form login').toBeTruthy();
  expect(JSON.parse(session).role).toBe('admin');
});

test('a wrong password is refused', async ({ page }) => {
  await page.goto('/login.html');
  const r = await page.evaluate(u => window.login(u, 'definitely-not-the-password'),
                                username('admin'));
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/invalid|password/i);
});

test('repeated wrong passwords lock the account', async ({ page }) => {
  /* LOCKOUT_MAX_ATTEMPTS = 5 → 423 with a countdown (routes/auth.js). This is
     the control that actually stops password guessing; the IP rate limit is
     raised for the harness (see playwright.config.js) and would otherwise
     mask it. Uses 'packing', whose other assertions have already run. */
  await page.goto('/login.html');
  const user = username('packing');
  let last;
  for (let i = 0; i < 6; i++) {
    last = await page.evaluate(u => window.login(u, 'wrong-password-' + Math.random()), user);
  }
  expect(last.ok).toBe(false);
  expect(last.error, 'the account must lock, not keep accepting attempts').toMatch(/lock|wait|minute/i);

  // …and the CORRECT password is refused while the lock holds.
  const stillLocked = await page.evaluate(
    ([u, p]) => window.login(u, p), [user, E2E_PASSWORD_FOR_TEST]);
  expect(stillLocked.ok).toBe(false);

  /* Release it: the lockout runs 15 minutes, and the per-role assertions
     below log in as this same account. The harness must not leave a trap for
     its own later tests (or for a re-run). */
  await pool.query(
    'UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username = $1', [user]);
  const recovered = await page.evaluate(
    ([u, p]) => window.login(u, p), [user, E2E_PASSWORD_FOR_TEST]);
  expect(recovered.ok, 'clearing the lock must restore access').toBe(true);
});

for (const r of ROLES) {
  test(`role ${r.role}: sidebar, sections and Fill button match the matrix`, async ({ page }) => {
    const errors = collectErrors(page);
    const canView = expandView(r);
    const canEdit = expandEdit(r);

    await loginAs(page, r.role);
    await page.goto('/index.html');
    await page.waitForLoadState('networkidle');

    // 1. The sidebar offers exactly the departments this role may view.
    const shown = await page.evaluate(() =>
      [...document.querySelectorAll('.sb-item[data-dept]')].map(el => el.dataset.dept));
    expect(shown.sort(), `sidebar departments for ${r.role}`).toEqual([...canView].sort());

    // 2. Fill Monthly Data appears on exactly the fillable departments.
    for (const dept of canView) {
      await page.evaluate(d => switchDept(d), dept);
      /* #fill-monthly-btn, not .fill-monthly-btn: the Submit Month control
         added alongside the monthly submit-lock reuses that class for its
         styling, so the bare class selector matches two buttons and trips
         Playwright's strict mode for every role. */
      const visible = await page.locator('#fill-monthly-btn').isVisible();
      expect(visible, `${r.role} on ${dept}: Fill button visibility`).toBe(canEdit.includes(dept));
    }

    // 3. switchDept() refuses a department outside the matrix, even when
    //    called directly — the buttons are filtered, but a stale DOM or a
    //    console call must not get past it.
    const forbidden = ['ei', 'production', 'mines', 'mechanical', 'powerplant', 'packing', 'stores']
      .find(d => !canView.includes(d));
    if (forbidden) {
      const landed = await page.evaluate(d => { switchDept(d); return currentDept; }, forbidden);
      expect(landed, `${r.role} must not reach ${forbidden}`).toBe('summary');
    }

    expect(errors(), `console errors for ${r.role}`).toEqual([]);
  });
}

test('a view-only role cannot open an inline cell editor', async ({ page }) => {
  /* The Fill button is hidden for md (editDepts: []), but every cell in the
     tables is also click-to-edit. Without the same gate there, a view-only
     user could type into any cell and only learn it had not saved from the
     error toast afterwards. */
  await loginAs(page, 'md');
  await page.goto('/index.html?dept=production');
  await page.waitForLoadState('networkidle');

  const cell = page.locator('#dept-production .kpi-table .data-row td').nth(4);
  await cell.click();
  await expect(cell, 'a view-only role must not enter edit mode').not.toHaveClass(/cell-editing/);
  expect(await cell.getAttribute('contenteditable')).not.toBe('true');
});

test('a department HOD can open an inline cell editor on their own department', async ({ page }) => {
  await loginAs(page, 'production');
  await page.goto('/index.html?dept=production');
  await page.waitForLoadState('networkidle');

  /* Pick a MANUAL cell: a formula-driven one is override-gated to admin/md
     and would legitimately refuse. */
  const cell = page.locator('#dept-production .kpi-table .data-row td.actual:not(.auto-cell)').first();
  await cell.click();
  await expect(cell).toHaveClass(/cell-editing/);
  await page.keyboard.press('Escape');
});

test('the override prompt is offered only to admin/md', async ({ page }) => {
  /* setOverride is admin/md only server-side (routes/formula.js). A dept HOD
     who reaches an auto cell must be refused by the API, not just the UI. */
  await loginAs(page, 'production');
  await page.goto('/index.html');
  const status = await page.evaluate(async () => {
    const res = await fetch(`${_API_BASE}/formula/override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getAuthToken() },
      body: JSON.stringify({ kpi_key: 'kiln-output', year: 2001, month: 6, value: 1, reason: 'e2e harness check' }),
    });
    return res.status;
  });
  expect(status, 'a department HOD may not override a formula value').toBe(403);
});

test('an ordinary browsing session is never rate-limited', async ({ page }) => {
  /* GET /api/auth/me fires on EVERY page load, and the credential limiter
     keys on IP — so when it covered the whole /api/auth mount, a plant behind
     one office NAT shared 30 requests per 5 minutes between everyone. Thirty
     page views was a couple of minutes of ordinary use, after which nobody
     could log in. Walk 40 session checks and assert none is refused. */
  await loginAs(page, 'admin');
  await page.goto('/index.html');
  const statuses = await page.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${_API_BASE}/auth/me`, {
        headers: { Authorization: 'Bearer ' + getAuthToken() },
      });
      out.push(res.status);
    }
    return out;
  });
  expect(statuses.filter(s => s === 429), 'session checks must not be rate-limited').toEqual([]);
  expect(new Set(statuses)).toEqual(new Set([200]));
});

test('every KPI page renders for a summary-only role', async ({ page }) => {
  /* hr/it/sales/purchase see only Executive Summary but still reach the five
     standalone pages — an intentional read-open model. Assert it holds rather
     than leaving it undefined. */
  const errors = collectErrors(page);
  await loginAs(page, 'hr');
  for (const url of ['/index.html', '/analytics.html', '/completeness.html',
                     '/balance.html', '/insights.html', '/reliability.html']) {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#app-sidebar')).toBeVisible();
  }
  expect(errors()).toEqual([]);
});
