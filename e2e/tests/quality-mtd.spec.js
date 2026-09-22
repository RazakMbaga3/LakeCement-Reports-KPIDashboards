/*
  forms/quality-form.html — Block 1 (Finished Cement — Physical Tests)
  and its running MTD figures.

  Lab quality readings are intensive quantities (a % or an MPa figure),
  not stocks or flows — their MTD figure is a plain arithmetic mean of
  days that actually have a reading, not a sum and not production-weighted.
  This matches forms/formula-registry.js's own monthlyAgg:'avg' rule for
  free_lime/blaine_425r/strength_28d, the three of these facts already
  promoted to the shared cross-dashboard KPI registry.

  2026-09-22 rebuilt this block around the plant's own QC DAILY REPORT
  workbook: a grade × parameter matrix over three mill sections (Cement
  Mill-1, Cement Mill-2, Loading) with the sheet's own seven columns —
  Blaine, R45, L/C expansion and compressive strength at 1, 2, 7 and 28
  days. Three things moved and are asserted here because a silent
  regression in any of them is invisible on screen:

    • Blaine is in m²/kg, the unit the workbook and the TBS requirement
      it prints ("380 to 410") are both written in. It was declared
      cm²/g while the only figure ever filed under it was a mockup.
    • `blaine_425r` and `strength_28d` keep their names, on Cement
      Mill-1's 42.5R row — they are the shared KPI registry's facts, and
      renaming them into the cem_* scheme would orphan two KPIs.
    • `free_lime` left this block entirely. The workbook has no free-lime
      column in the physical lab table; the importer was filling that
      cement row from the CLINKER F.CaO average. It now sits in the
      clinker block, where it is measured (see quality-chemistry-mtd).

  MTD rides UNDER each input rather than in its own column: at seven
  parameters wide, a parallel MTD column per parameter would double the
  table and push the 28-day result off-screen on a laptop.
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
  /* Seed day: Cement Mill-1 42.5N Blaine = 385 m²/kg. Live day: left
     blank. If the blank day were zero-filled the MTD average would
     collapse toward 0; the correct behaviour is to show the one real
     reading, 385. */
  await seedMtdHistory({ cem_cm1_425n_blaine: 385 });
  await openForm(page);

  await page.fill('input[data-field="blaine_425r"]', '370'); // touch an unrelated field to trigger a repaint
  await page.locator('input[data-field="blaine_425r"]').blur();
  await page.waitForTimeout(300);

  await expect(page.locator('[data-kpi="cem_cm1_425n_blaine_mtd"]').first()).toHaveText('385.0');
});

/* The two names the shared KPI registry depends on. If either is ever
   renamed into the cem_* scheme, forms/formula-registry.js's blaine-425r
   and strength-28d KPIs silently stop resolving — the dashboard keeps
   rendering, it just shows nothing. */
test('the registry facts keep their names, on Cement Mill-1 42.5R', async ({ page }) => {
  await openForm(page);
  await expect(page.locator('input[data-field="blaine_425r"]')).toHaveCount(1);
  await expect(page.locator('input[data-field="strength_28d"]')).toHaveCount(1);
  await expect(page.locator('input[data-field="cem_cm1_425r_blaine"]')).toHaveCount(0);
  await expect(page.locator('input[data-field="cem_cm1_425r_cs28"]')).toHaveCount(0);
});

test('every grade of every mill section is a real, editable input across all seven parameters', async ({ page }) => {
  await openForm(page);
  const SECTIONS = {
    cm1: ['425r', '425n', '325n', 'spot', 'opc', 'bmill'],   // Cement Mill-1 also runs SPOT and B/Mill
    cm2: ['425r', '425n', '325n', 'opc'],
    ld:  ['425r', '425n', '325n', 'opc'],                    // Loading
  };
  const PARAMS = ['blaine', 'r45', 'lce', 'cs1', 'cs2', 'cs7', 'cs28'];
  const LEGACY = { 'cm1.425r.blaine': 'blaine_425r', 'cm1.425r.cs28': 'strength_28d' };

  for (const [sec, grades] of Object.entries(SECTIONS)) {
    for (const grade of grades) {
      for (const param of PARAMS) {
        const field = LEGACY[`${sec}.${grade}.${param}`] || `cem_${sec}_${grade}_${param}`;
        await expect(page.locator(`input[data-field="${field}"]`),
          `${field} must be editable`).toBeEditable();
      }
    }
  }
});

/* Deleted deliberately, not renamed. Setting Time (initial and final),
   3-day strength, soundness and a per-grade free-lime column have no
   column in the QC DAILY REPORT workbook — they came from the mockup the
   page was first built from, and nothing could ever fill them. */
test('the mockup-only Block 1 fields are gone', async ({ page }) => {
  await openForm(page);
  for (const field of ['setting_initial_425r', 'setting_initial_425n',
                       'setting_final_425r', 'setting_final_425n',
                       'strength_3d_425r', 'strength_3d_425n',
                       'free_lime_425n', 'soundness_425r', 'soundness_425n',
                       'residue_425r', 'residue_425n',
                       'blaine_425n', 'strength_28d_425n']) {
    await expect(page.locator(`input[data-field="${field}"]`),
      `${field} has no column in the QC workbook and should be gone`).toHaveCount(0);
  }
});
