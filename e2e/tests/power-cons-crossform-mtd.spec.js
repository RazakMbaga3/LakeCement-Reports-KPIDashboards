/*
  forms/power-form.html — Section 4 (SPC Total/Clinker/Grinding, CPP
  Auxiliary %) and their matching KPI-strip tiles.

  Before this change all 12 table cells (4 rows x On Date/MTD/YTD) plus
  3 of the 4 strip tiles (SPC Total had a "simplified preview" explicitly
  flagged in its own comment as not the authoritative figure) were
  hardcoded. These four figures reuse forms/formula-registry.js's actual
  daily()/monthlyAgg functions rather than a re-derived approximation, so
  this page can't quietly disagree with the Executive Summary.

  Two of the four are entirely self-contained in this form's own fields
  (SPC Clinker, SPC Grinding); the other two need data from OTHER forms
  merged in — SPC Total reads the production form's clinker/cement fields,
  CPP Auxiliary % is entirely CPP-form data. This suite checks one of
  each kind.
*/
const { test, expect } = require('@playwright/test');
const { loginAs, collectErrors } = require('../fixtures/auth');
const { setReportDate } = require('../fixtures/forms');
const { pool } = require('../fixtures/db');

const D = '1999-06-22';
const MTD_SEED_DATE = '1999-06-01';

async function cleanup() {
  await pool.query(
    "DELETE FROM daily_reports WHERE record_date IN ($1, $2) AND form_type IN ('power-cons', 'cpp', 'production')",
    [D, MTD_SEED_DATE]
  );
}

async function seed(formType, date, data, username) {
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  await pool.query(
    `INSERT INTO daily_reports (form_type, record_date, shift, data, submitted_by, submitted_at, status)
     VALUES ($1, $2, 'day', $3, $4, NOW(), 'approved')`,
    [formType, date, JSON.stringify(data), rows[0].id]
  );
}

async function openForm(page) {
  await loginAs(page, 'pm');
  await page.goto('/forms/power-form.html');
  await page.waitForLoadState('networkidle');
  await setReportDate(page, D);
  await page.waitForTimeout(500);
}

test.beforeEach(cleanup);
test.afterAll(cleanup);

test('SPC Clinker (self-contained, no cross-form data) is generation-weighted live, not a naive daily average', async ({ page }) => {
  const errors = collectErrors(page);
  /* Seed day: Kiln 50,000 kWh / 1,000 MT clinker -> SPC 50. Live day
     (typed, unsaved): 180,000 kWh / 2,000 MT -> SPC 90. Naive average of
     the two ratios is 70; the correct clinker-weighted MTD figure is
     (50,000+180,000)/(1,000+2,000) = 76.67. */
  await seed('power-cons', MTD_SEED_DATE, { pwr_kiln_kwh: 50000, pwr_kiln_prod_mt: 1000 }, 'e2e_pm');
  await openForm(page);

  await page.fill('input[data-field="pwr_kiln_kwh"]', '180000');
  await page.fill('input[data-field="pwr_kiln_prod_mt"]', '2000');
  await page.locator('input[data-field="pwr_kiln_prod_mt"]').blur();
  await page.waitForTimeout(700);

  const rows = await pool.query(
    "SELECT 1 FROM daily_reports WHERE form_type = 'power-cons' AND record_date = $1", [D]);
  expect(rows.rowCount, 'nothing should be persisted yet').toBe(0);

  await expect(page.locator('[data-kpi="spc_clinker"]').first()).toHaveText('90.00');
  await expect(page.locator('[data-kpi="spc_clinker_mtd"]').first()).toHaveText('76.67');

  expect(errors(), 'uncaught errors while typing').toEqual([]);
});

test('CPP Auxiliary % pulls the CPP form\'s own saved data across into power-form.html, weighted by generation', async ({ page }) => {
  /* Both days come from the CPP form, not power-cons -- this page has no
     input for them at all, so this is purely a cross-form-merge check.
     Seed day: 5,000/200,000 kWh -> 2.5% aux, weight 200,000.
     Today (also seeded, since power-form.html can't supply CPP readings
     itself): 20,000/100,000 kWh -> 20% aux, weight 100,000.
     A naive average of the two percentages is 11.25%; the correct
     generation-weighted MTD figure is (5,000+20,000)/(200,000+100,000)
     = 8.33%. */
  await seed('cpp', MTD_SEED_DATE, { cpp_aux_kwh: 5000, cpp_gross_gen_kwh: 200000 }, 'e2e_cpp_officer');
  await seed('cpp', D, { cpp_aux_kwh: 20000, cpp_gross_gen_kwh: 100000 }, 'e2e_cpp_officer');
  await openForm(page);
  await page.waitForTimeout(700);

  await expect(page.locator('[data-kpi="cpp_aux_pct_xform"]').first()).toHaveText('20.00%');
  await expect(page.locator('[data-kpi="cpp_aux_pct_xform_mtd"]').first()).toHaveText('8.33%');
});
