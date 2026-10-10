/*
  corrections.html — what a person sees when a signed-off report is wrong.

  Reported 2026-10-10: a CPP officer filed 8 Oct with every figure at zero, it
  was approved, and nobody could find a way to correct it. The correction-
  request machinery existed (report-amendment.spec.js) but was reachable only
  from inside the entry form, after first changing its date to the wrong day.
  This file holds the front door built for it:

    - the review page offers "Correct this report" on a signed-off day
    - the Corrections page opens on that day, flags it as all-zero, and asks
    - several bad days are asked for — and granted — in one go
    - the approver sees a number on Approvals; the requester sees one on
      Corrections once a window is open for them
    - "Fix it now" lands on the entry form AT that day, unlocked
    - the self-certifying department login is told who will decide
    - a submitted KPI month: the HOD asks, admin reopens, the figures are kept

  The rules underneath are held by backend/scripts/accept-corrections.js and
  accept-amendments.js; this file holds what only a browser can show.
  Sandboxes: Nov 1999 daily reports, 2001 KPI months — cleaned before and after.
*/
const { test, expect } = require('@playwright/test');
const { loginAs, collectErrors } = require('../fixtures/auth');
const { setReportDate } = require('../fixtures/forms');
const { pool } = require('../fixtures/db');

const D1 = '1999-11-08';
const D2 = '1999-11-09';
const KY = 2001, KM = 6;
const REASON = 'Every CPP figure for this day was typed as zero — the log sheet has the readings';

async function cleanup() {
  await pool.query("DELETE FROM report_amendments WHERE record_date BETWEEN '1999-11-01' AND '1999-11-30'");
  await pool.query("DELETE FROM report_revisions  WHERE record_date BETWEEN '1999-11-01' AND '1999-11-30'");
  await pool.query("DELETE FROM daily_reports     WHERE record_date BETWEEN '1999-11-01' AND '1999-11-30'");
  await pool.query('DELETE FROM kpi_reopen_requests WHERE year = $1', [KY]);
  await pool.query('DELETE FROM kpi_submissions     WHERE year = $1', [KY]);
  await pool.query("DELETE FROM kpi_monthly WHERE year = $1 AND department = 'powerplant'", [KY]);
}
test.beforeEach(cleanup);
test.afterAll(cleanup);

const uid = name => pool.query('SELECT id FROM users WHERE username = $1', [name]).then(r => r.rows[0].id);

/* An approved CPP day signed by the department's HOD login — the shape of the
   report that was reported. */
async function seedZeroDay(date) {
  const hod = await uid('e2e_cpp');
  await pool.query(
    `INSERT INTO daily_reports (form_type, record_date, shift, data, submitted_by, submitted_at, status, approved_by, approved_at)
     VALUES ('cpp', $1, 'day', $2, $3, NOW(), 'approved', $3, NOW())`,
    [date, JSON.stringify({ date, cpp_gross_gen: 0, cpp_net_export: 0, cpp_coal_consumed: 0 }), hod]);
}
const requests = () => pool.query(
  `SELECT * FROM report_amendments WHERE form_type = 'cpp' AND record_date BETWEEN '1999-11-01' AND '1999-11-30' ORDER BY record_date`
).then(r => r.rows);

function acceptDialogs(page, promptValue) {
  page.on('dialog', d => (d.type() === 'prompt' ? d.accept(promptValue) : d.accept()));
}

/* ════════════════════════════════════════════════════════════════════════ */

test('a signed-off zero day: the review page leads to the request, filed in words', async ({ page }) => {
  await seedZeroDay(D1);
  const errors = collectErrors(page);
  await loginAs(page, 'cpp_officer');

  await page.goto('/power-plant.html');
  await page.waitForLoadState('networkidle');
  await setReportDate(page, D1);
  const link = page.locator('#pp-correct');
  await expect(link, 'a signed-off day offers the way to fix it, beside its status').toBeVisible();
  await expect(link).toHaveAttribute('href', `corrections.html?form=cpp&date=${D1}&ask=1`);

  await link.click();
  await expect(page).toHaveURL(/corrections\.html/);
  const dialog = page.getByRole('dialog');
  await expect(dialog, 'arriving from the report opens the request straight away').toBeVisible();
  await expect(dialog).toContainText('Power Plant (CPP)');
  await expect(dialog.locator('.cr-who'), 'the officer is told who decides').toContainText('HOD');

  const row = page.locator(`#cr-days tr[data-date="${D1}"]`);
  await expect(row, 'the day is flagged for what it is').toContainText('All zero');
  await expect(row).toHaveClass(/cr-hl/);

  await dialog.getByRole('button', { name: 'Send request' }).click();
  await expect(dialog.locator('#cr-dlg-err'), 'a blank reason is refused before anything is sent').toBeVisible();
  expect(await requests()).toHaveLength(0);

  await dialog.locator('#cr-dlg-reason').fill(REASON);
  await dialog.locator('#cr-dlg-fields').fill('Gross generation, net export');
  await dialog.getByRole('button', { name: 'Send request' }).click();
  await expect(page.locator('#cr-flash')).toContainText('Correction requested for 1 day');
  await expect(row).toContainText('Waiting for approver');
  await expect(page.locator('#cr-mine'), 'the request is listed under the officer’s own').toContainText(REASON);

  const rows = await requests();
  expect(rows).toHaveLength(1);
  expect(rows[0].reason).toBe(REASON);
  expect(rows[0].fields_flagged).toEqual(['Gross generation', 'net export']);
  expect(errors(), 'uncaught errors').toEqual([]);
});

test('a run of bad days is asked for and granted in one go, and "Fix it now" opens the day unlocked', async ({ page, context }) => {
  await seedZeroDay(D1);
  await seedZeroDay(D2);
  await loginAs(page, 'cpp_officer');
  await page.goto('/corrections.html?form=cpp&month=1999-11');
  await page.waitForLoadState('networkidle');

  await page.locator(`input[data-pick="${D1}"]`).check();
  await page.locator(`input[data-pick="${D2}"]`).check();
  await expect(page.locator('#cr-bulk-n')).toHaveText('2 days selected');
  await page.locator('#cr-bulk-go').click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('[data-quick]').first().click();       // the "entered as zero" reason
  await dialog.getByRole('button', { name: 'Send 2 requests' }).click();
  await expect(page.locator('#cr-flash')).toContainText('Correction requested for 2 days');
  expect((await requests()).map(r => r.status)).toEqual(['requested', 'requested']);

  // ── the HOD sees how much is waiting, and grants both at once ──
  const hod = await context.newPage();
  acceptDialogs(hod, '24');
  await loginAs(hod, 'cpp');
  await hod.goto('/approvals.html');
  await hod.waitForLoadState('networkidle');
  const count = hod.locator('[data-sb-count="approvals"]');
  await expect(count, 'Approvals carries a number').toBeVisible();
  expect(+(await count.textContent())).toBeGreaterThanOrEqual(2);
  await hod.locator(`#amd-table tr[data-date="${D1}"] input[data-pick]`).check();
  await hod.locator(`#amd-table tr[data-date="${D2}"] input[data-pick]`).check();
  await expect(hod.locator('#amd-bulk-n')).toHaveText('2 requests selected');
  await hod.locator('#amd-bulk-grant').click();
  await expect(hod.locator(`#amd-table tr[data-date="${D1}"]`)).toContainText('Window open');
  await expect(hod.locator(`#amd-table tr[data-date="${D2}"]`)).toContainText('Window open');
  expect((await requests()).map(r => r.status)).toEqual(['granted', 'granted']);

  // ── back to the officer: a number on Corrections, and the way in ──
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[data-sb-count="windows"]'), 'the requester sees windows open for them').toBeVisible();
  const fix = page.locator(`#cr-days tr[data-date="${D1}"]`).getByRole('link', { name: 'Fix it now' });
  await expect(fix).toBeVisible();
  await fix.click();
  await expect(page).toHaveURL(new RegExp(`power-plant-report\\.html\\?date=${D1}`));
  await page.waitForLoadState('networkidle');
  await expect(page.locator('input[type="date"]').first(), 'the form opened ON the day being corrected').toHaveValue(D1);
  await expect(page.locator('.rpt-pill')).toHaveText('CORRECTION OPEN');
  await expect(page.locator('.btn-sub').first()).toBeEnabled();
});

test('the entry form now says where the way out is', async ({ page }) => {
  await seedZeroDay(D1);
  await loginAs(page, 'cpp_officer');
  await page.goto(`/power-plant-report.html?date=${D1}`);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('input[type="date"]').first(), '?date= opens the form on that day').toHaveValue(D1);
  await expect(page.locator('.rpt-pill')).toHaveText('APPROVED');
  await expect(page.locator('#_nyb')).toContainText('Request a correction');
  await expect(page.locator('#_ny-amend-btn')).toBeVisible();
});

test('the self-certifying department login is told an administrator or the MD decides', async ({ page }) => {
  await seedZeroDay(D1);
  await loginAs(page, 'cpp');
  await page.goto(`/corrections.html?form=cpp&date=${D1}&ask=1`);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.cr-who')).toContainText('administrator or the MD');
});

test('a submitted KPI month: the HOD asks, admin reopens, and the old figures are kept', async ({ page, context }) => {
  const hodId = await uid('e2e_cpp');
  await pool.query(
    `INSERT INTO kpi_monthly (department, year, month, kpi_key, target, actual, unit, updated_by)
     VALUES ('powerplant', $1, $2, 'e2e_gen', 9000, 12, 'MWh', $3)`, [KY, KM, hodId]);
  await pool.query(
    `INSERT INTO kpi_submissions (department, year, month, status, submitted_by) VALUES ('powerplant', $1, $2, 'submitted', $3)`,
    [KY, KM, hodId]);

  await loginAs(page, 'cpp');
  await page.goto(`/corrections.html?tab=kpi&dept=powerplant&kto=${KY}-12`);
  await page.waitForLoadState('networkidle');
  const row = page.locator('#cr-months tr', { hasText: 'Jun 2001' });
  await expect(row).toContainText('Submitted — locked');
  await row.getByRole('button', { name: 'Request reopen' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#cr-dlg-reason').fill('Generation actual was entered in GWh instead of MWh');
  await dialog.getByRole('button', { name: 'Send request' }).click();
  await expect(row).toContainText('Waiting for admin / MD');

  const admin = await context.newPage();
  acceptDialogs(admin, 'Granting the HOD request: unit error on generation');
  await loginAs(admin, 'admin');
  await admin.goto('/approvals.html');
  await admin.waitForLoadState('networkidle');
  const kpiRow = admin.locator('#kpi-table tbody tr', { hasText: 'Jun 2001' });
  await expect(kpiRow).toContainText('GWh instead of MWh');
  await kpiRow.getByRole('button', { name: 'Reopen' }).click();
  await expect(admin.locator('#kpi-table tbody tr', { hasText: 'Jun 2001' })).toHaveCount(0);

  const sub = (await pool.query('SELECT status FROM kpi_submissions WHERE department = $1 AND year = $2 AND month = $3',
    ['powerplant', KY, KM])).rows[0];
  expect(sub.status).toBe('reopened');
  const req = (await pool.query('SELECT status, snapshot FROM kpi_reopen_requests WHERE year = $1', [KY])).rows[0];
  expect(req.status).toBe('granted');
  expect(Number(req.snapshot.find(x => x.kpi_key === 'e2e_gen').actual)).toBe(12);

  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#cr-months tr', { hasText: 'Jun 2001' })).toContainText('Reopened — editable');
});

test('Corrections is in the menu for whoever files a report — and not for a role that files none', async ({ page, context }) => {
  await loginAs(page, 'cpp_officer');
  await page.goto('/portal.html');
  await expect(page.locator('#app-sidebar a[href$="corrections.html"]')).toBeVisible();

  const hr = await context.newPage();
  await loginAs(hr, 'hr');
  await hr.goto('/portal.html');
  await expect(hr.locator('#app-sidebar a[href$="corrections.html"]')).toHaveCount(0);
});
