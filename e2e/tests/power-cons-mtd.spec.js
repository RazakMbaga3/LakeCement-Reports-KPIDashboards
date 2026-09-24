/*
  forms/power-form.html's Section 1 "Specific Power (kWh/MT)" and "MTD SPC"
  columns.

  Before this change, all 9 equipment rows' On Date and MTD SPC cells were
  hardcoded, and Crusher/RM-1/RM-2/Coal Mill/both Packing lines' Production
  (MT) box was a visible but unbound input — its value was never captured,
  so even a correct on-date ratio couldn't have been computed for them.
  Kiln/CM-1/CM-2 already had both fields wired (they feed the shared
  formula-registry's Specific Power Consumption KPIs), so this test uses
  Kiln to check the actual math without also depending on the newly-added
  Crusher/RM-1/etc. bindings.

  MTD SPC must be a ratio of summed kWh over summed MT for the period —
  not an average of each day's own ratio, which is what the "not
  cumulative" numbers below are designed to catch.
*/
const { test, expect } = require('@playwright/test');
const { loginAs, collectErrors } = require('../fixtures/auth');
const { setReportDate } = require('../fixtures/forms');
const { pool } = require('../fixtures/db');

const D = '1999-06-19';
const MTD_SEED_DATE = '1999-06-01';

async function cleanup() {
  await pool.query("DELETE FROM daily_reports WHERE form_type = 'power-cons' AND record_date IN ($1, $2)", [D, MTD_SEED_DATE]);
}

async function seedMtdHistory(data) {
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['e2e_pm']);
  await pool.query(
    `INSERT INTO daily_reports (form_type, record_date, shift, data, submitted_by, submitted_at, status)
     VALUES ('power-cons', $1, 'day', $2, $3, NOW(), 'approved')`,
    [MTD_SEED_DATE, JSON.stringify(data), rows[0].id]
  );
}

async function openForm(page) {
  await loginAs(page, 'pm');
  await page.goto('/forms/power-form.html');
  await page.waitForLoadState('networkidle');
  await setReportDate(page, D);
  await page.waitForTimeout(400);
}

test.beforeEach(cleanup);
test.afterAll(cleanup);

test('Kiln Specific Power (On Date and MTD) update live from unsaved input', async ({ page }) => {
  const errors = collectErrors(page);
  /* Seed day: 40,000 kWh / 2,000 MT -> SPC 20.00. Live day (typed, unsaved):
     60,000 kWh / 1,000 MT -> SPC 60.00. A naive average of the two days'
     ratios is (20+60)/2 = 40.00 — the correct weighted MTD figure is
     (40,000+60,000)/(2,000+1,000) = 33.33. */
  await seedMtdHistory({ pwr_kiln_kwh: 40000, pwr_kiln_prod_mt: 2000 });
  await openForm(page);

  await page.fill('input[data-field="pwr_kiln_kwh"]', '60000');
  await page.fill('input[data-field="pwr_kiln_prod_mt"]', '1000');
  await page.locator('input[data-field="pwr_kiln_prod_mt"]').blur();
  await page.waitForTimeout(300);

  const rows = await pool.query(
    "SELECT 1 FROM daily_reports WHERE form_type = 'power-cons' AND record_date = $1", [D]);
  expect(rows.rowCount, 'nothing should be persisted yet').toBe(0);

  await expect(page.locator('[data-kpi="pwr_spc_kiln"]').first()).toHaveText('60.00');
  await expect(page.locator('[data-kpi="pwr_spc_kiln_mtd"]').first()).toHaveText('33.33');

  expect(errors(), 'uncaught errors while typing').toEqual([]);
});

test('previously-unbound equipment Production (MT) fields are now real inputs', async ({ page }) => {
  await openForm(page);
  /* pwr_rawmill2_prod_mt and pwr_packing2_prod_mt no longer exist — RM-2
     and Packing Plant-2 share their group's one Production box now (see
     the next test), not a field of their own. */
  const fields = [
    'pwr_crusher_prod_mt', 'pwr_rawmill_prod_mt',
    'pwr_coalmill_prod_mt', 'pwr_packing_prod_mt', 'pwr_utilities_prod_mt',
  ];
  for (const field of fields) {
    await expect(page.locator(`input[data-field="${field}"]`), `${field} must be editable`).toBeEditable();
  }
});

test('Crusher Specific Power computes once both kWh and the newly-bound Production (MT) are entered', async ({ page }) => {
  await openForm(page);

  await page.fill('input[data-field="pwr_crusher_kwh"]', '1600');
  await page.fill('input[data-field="pwr_crusher_prod_mt"]', '3200');
  await page.locator('input[data-field="pwr_crusher_prod_mt"]').blur();
  await page.waitForTimeout(150);

  await expect(page.locator('[data-kpi="pwr_spc_crusher"]').first()).toHaveText('0.50');
});

test('Raw Mill Specific Power divides RM-1 + RM-2 combined kWh by one shared Production value', async ({ page }) => {
  /* 2026-09-22: RM-1 and RM-2 used to be two independent rows, each with
     its own Production box and its own Specific Power — but the real
     report (20.09.2026.xlsx) gives Raw Mill exactly one Production
     figure for both mills combined. Confirms the merge computes
     (RM-1 kWh + RM-2 kWh) / one Production, not RM-1 kWh / Production
     alone. */
  await openForm(page);

  await page.fill('input[data-field="pwr_rawmill_kwh"]', '15000');
  await page.fill('input[data-field="pwr_rawmill2_kwh"]', '5000');
  await page.fill('input[data-field="pwr_rawmill_prod_mt"]', '1000');
  await page.locator('input[data-field="pwr_rawmill_prod_mt"]').blur();
  await page.waitForTimeout(150);

  // (15000 + 5000) / 1000 = 20.00, not 15000/1000 = 15.00
  await expect(page.locator('[data-kpi="pwr_spc_rawmill"]').first()).toHaveText('20.00');
  await expect(page.locator('[data-kpi="pwr_rawmill_total_kwh"]').first()).toHaveText('20,000');
});
