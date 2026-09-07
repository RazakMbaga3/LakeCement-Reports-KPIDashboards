/*
  forms/quality-form.html — Block 1 (Cement Quality by Grade) "MTD Avg"
  columns.

  Lab quality readings are intensive quantities (a % or an MPa figure),
  not stocks or flows — their MTD figure is a plain arithmetic mean of
  days that actually have a reading, not a sum and not production-weighted.
  This matches forms/formula-registry.js's own monthlyAgg:'avg' rule for
  free_lime/blaine_425r/strength_28d, the three of these facts already
  promoted to the shared cross-dashboard KPI registry.

  Before this change, 13 of the 16 fields in this table (both grade
  columns for every parameter except Blaine/Strength-28d/Free-Lime's
  42.5R column) weren't captured as data at all, and all 16 "MTD Avg"
  cells were hardcoded regardless.
*/
const { test, expect } = require('@playwright/test');
const { loginAs, collectErrors } = require('../fixtures/auth');
const { pool } = require('../fixtures/db');

const D = '1999-06-20';
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

test('Free Lime MTD Avg is a plain mean of days with a reading, live, not a sum or weighted figure', async ({ page }) => {
  const errors = collectErrors(page);
  /* Seed day: 2.8%. Live day (typed, unsaved): 3.2%. A sum would read
     6.0%; the correct mean is (2.8+3.2)/2 = 3.0%. */
  await seedMtdHistory({ free_lime: 2.8 });
  await openForm(page);

  await expect(page.locator('[data-kpi="free_lime_mtd"]').first()).toHaveText('2.8');

  await page.fill('input[data-field="free_lime"]', '3.2');
  await page.locator('input[data-field="free_lime"]').blur();
  await page.waitForTimeout(300);

  const rows = await pool.query(
    "SELECT 1 FROM daily_reports WHERE form_type = 'quality' AND record_date = $1", [D]);
  expect(rows.rowCount, 'nothing should be persisted yet').toBe(0);

  await expect(page.locator('[data-kpi="free_lime_mtd"]').first()).toHaveText('3.0');
  expect(errors(), 'uncaught errors while typing').toEqual([]);
});

test('a day with no reading is excluded from the average, not treated as zero', async ({ page }) => {
  /* Seed day: Blaine 425N = 3500. Live day: Blaine 425N left blank. If the
     blank day were zero-filled, the MTD average would collapse toward 0;
     the correct behaviour is to just show the one real reading, 3500. */
  await seedMtdHistory({ blaine_425n: 3500 });
  await openForm(page);

  await page.fill('input[data-field="blaine_425r"]', '3700'); // touch an unrelated field to trigger a repaint
  await page.locator('input[data-field="blaine_425r"]').blur();
  await page.waitForTimeout(300);

  await expect(page.locator('[data-kpi="blaine_425n_mtd"]').first()).toHaveText('3,500.0');
});

test('every Block 1 parameter is now a real, editable input for both grades', async ({ page }) => {
  await openForm(page);
  const fields = [
    'blaine_425r', 'blaine_425n', 'residue_425r', 'residue_425n',
    'setting_initial_425r', 'setting_initial_425n', 'setting_final_425r', 'setting_final_425n',
    'strength_3d_425r', 'strength_3d_425n', 'strength_28d', 'strength_28d_425n',
    'free_lime', 'free_lime_425n', 'soundness_425r', 'soundness_425n',
  ];
  for (const field of fields) {
    await expect(page.locator(`input[data-field="${field}"]`), `${field} must be editable`).toBeEditable();
  }
});
