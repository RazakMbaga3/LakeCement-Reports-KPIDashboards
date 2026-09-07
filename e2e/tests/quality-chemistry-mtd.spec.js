/*
  forms/quality-form.html — Blocks 3-5 (Raw Mill / Kiln Feed / Clinker
  4-hour chemistry). Each parameter is 6 hourly samples that need
  averaging into a Day Avg before an MTD Avg on top of that means
  anything. Before this change none of these fields (beyond Raw Mill
  LSF's 6 samples, which fed a dead `lsf_avg` kpi-live rule painted
  nowhere) were captured, and every Day Avg / MTD Avg cell was static.

  The key correctness property this suite exists to catch: MTD Avg must
  be the mean of each day's OWN Day Avg (itself a mean of that day's
  samples), not a flat mean of every individual hourly reading in the
  period — a day with more completed samples must not outweigh a day
  with fewer.
*/
const { test, expect } = require('@playwright/test');
const { loginAs, collectErrors } = require('../fixtures/auth');
const { pool } = require('../fixtures/db');

const D = '1999-06-21';
const MTD_SEED_DATE = '1999-06-01';

async function cleanup() {
  await pool.query("DELETE FROM daily_reports WHERE form_type = 'quality' AND record_date IN ($1, $2)", [D, MTD_SEED_DATE]);
}

async function seedMtdHistory(data) {
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['e2e_production']);
  await pool.query(
    `INSERT INTO daily_reports (form_type, record_date, shift, data, submitted_by, submitted_at, status)
     VALUES ('quality', $1, 'day', $2, $3, NOW(), 'approved')`,
    [MTD_SEED_DATE, JSON.stringify(data), rows[0].id]
  );
}

async function openForm(page) {
  await loginAs(page, 'production');
  await page.goto('/forms/quality-form.html');
  await page.waitForLoadState('networkidle');
  await page.fill('input[type="date"]', D);
  await page.waitForTimeout(400);
}

test.beforeEach(cleanup);
test.afterAll(cleanup);

test('Raw Mill LSF Day Avg and MTD Avg update live from hourly samples, unsaved', async ({ page }) => {
  const errors = collectErrors(page);
  /* Seed day: only 2 of 6 samples entered (90, 90) -> Day Avg 90.
     Live day (typed, unsaved): all 6 samples = 99 -> Day Avg 99.
     Averaging every individual sample (2 + 6 = 8 values: 90,90,99x6)
     gives 96.75 — the correct day-weighted MTD figure is (90+99)/2 = 94.5. */
  await seedMtdHistory({ lsf_rm_h1: 90, lsf_rm_h2: 90 });
  await openForm(page);

  for (let i = 1; i <= 6; i++) {
    await page.fill(`input[data-field="lsf_rm_h${i}"]`, '99');
  }
  await page.locator('input[data-field="lsf_rm_h6"]').blur();
  await page.waitForTimeout(300);

  const rows = await pool.query(
    "SELECT 1 FROM daily_reports WHERE form_type = 'quality' AND record_date = $1", [D]);
  expect(rows.rowCount, 'nothing should be persisted yet').toBe(0);

  await expect(page.locator('[data-kpi="lsf_rm_avg"]').first()).toHaveText('99.0');
  await expect(page.locator('[data-kpi="lsf_rm_avg_mtd"]').first()).toHaveText('94.5');

  expect(errors(), 'uncaught errors while typing').toEqual([]);
});

test('Clinker C3S and Kiln Feed Free CaO hourly samples are real, editable inputs', async ({ page }) => {
  await openForm(page);
  const fields = [
    'c3s_ck_h1', 'c3s_ck_h6', 'freelime_ck_h1', 'lsf_ck_h1',
    'lsf_kf_h1', 'freecao_kf_h1', 'sm_rm_h1', 'am_rm_h1', 'r90_rm_h1', 'moisture_rm_h1', 'caco3_rm_h1',
  ];
  for (const field of fields) {
    await expect(page.locator(`input[data-field="${field}"]`), `${field} must be editable`).toBeEditable();
  }
});
