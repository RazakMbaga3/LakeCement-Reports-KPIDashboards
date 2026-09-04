/*
  power-plant-report.html as a DATA ENTRY form.

  Until 2026-09-04 this page rendered all 22 CPP metrics as read-only
  data-kpi cells while still carrying a date picker, Save Draft and
  "Submit & Lock" — a form a CPP officer could not type a single reading
  into. Every stored day had arrived through backend/scripts/import-cpp.js.

  These tests hold the two halves of the fix in place:
    1. the 22 readings are real inputs the owning role can edit, and
    2. the derived figures recompute AS YOU TYPE, before anything is saved
       (the page feeds one CPP_COMPUTES array to both report-loader, which
       runs it against the saved record, and kpi-live, which re-runs it
       against the live inputs).

  Entry is asserted as `cpp_officer` — level 'officer' is the person who
  actually fills this in on shift, and their submission needs the HOD's
  signature rather than self-approving.
*/
const { test, expect } = require('@playwright/test');
const { loginAs, collectErrors } = require('../fixtures/auth');
const { pool } = require('../fixtures/db');

const D = '1999-06-17';

/* Every reading the importer writes — the form must be able to produce the
   same record shape by hand, or UI-entered days stay poorer than imported
   ones. Mirrors ROW_FACT in backend/scripts/import-cpp.js plus the two
   fly-ash quality fields it reads from row 33. */
const READINGS = [
  'cpp_gross_gen_kwh', 'cpp_aux_kwh', 'cpp_run_hrs', 'cpp_feed_water_mt',
  'cpp_boiler_steam_mt', 'cpp_bleed_steam_mt', 'cpp_turbine_steam_mt',
  'cpp_condensate_mt', 'cpp_aux_steam_mt', 'cpp_heat_rate_tg',
  'cpp_heat_rate_plant', 'cpp_dg_gen_kwh', 'cpp_coal_cons', 'cpp_coal_gcv',
  'cpp_dm_water_gen_m3', 'cpp_dm_water_cons_m3', 'cpp_ct_makeup_m3',
  'cpp_flyash_combustible_pct', 'cpp_flyash_gcv', 'cpp_flyash_to_cm_mt',
  'cpp_flyash_to_coalyard_nos', 'cpp_flyash_to_dumpyard_nos',
];

async function cleanup() {
  await pool.query("DELETE FROM daily_reports WHERE form_type = 'cpp' AND record_date = $1", [D]);
}

async function openForm(page) {
  await loginAs(page, 'cpp_officer');
  await page.goto('/power-plant-report.html');
  await page.waitForLoadState('networkidle');
  await page.fill('input[type="date"]', D);
  /* form-persist reloads the day on change; give it the same beat the page's
     own listeners use before asserting on what is on screen. */
  await page.waitForTimeout(400);
}

test.beforeEach(cleanup);
test.afterAll(cleanup);

test('every CPP reading the importer writes has an input on the page', async ({ page }) => {
  await openForm(page);

  const missing = [];
  for (const field of READINGS) {
    const input = page.locator(`input[data-field="${field}"]`);
    if (await input.count() === 0) { missing.push(field); continue; }
    await expect(input, `${field} must be editable for the cpp role`).toBeEditable();
  }
  expect(missing, 'CPP readings with no input on power-plant-report.html').toEqual([]);
});

test('derived figures recompute while typing, before anything is saved', async ({ page }) => {
  const errors = collectErrors(page);
  await openForm(page);

  /* A clean 10 MW day: 240,000 kWh gross over 24 h, 10% house load. */
  await page.fill('input[data-field="cpp_gross_gen_kwh"]',   '240000');
  await page.fill('input[data-field="cpp_aux_kwh"]',         '24000');
  await page.fill('input[data-field="cpp_run_hrs"]',         '24');
  await page.fill('input[data-field="cpp_turbine_steam_mt"]', '300');
  await page.fill('input[data-field="cpp_coal_cons"]',       '120');
  /* kpi-live listens on input/change; blur the last field so change fires. */
  await page.locator('input[data-field="cpp_coal_cons"]').blur();
  await page.waitForTimeout(300);

  /* Nothing has been saved — these must come from the live inputs alone. */
  const rows = await pool.query(
    "SELECT 1 FROM daily_reports WHERE form_type = 'cpp' AND record_date = $1", [D]);
  expect(rows.rowCount, 'nothing should be persisted yet').toBe(0);

  await expect(page.locator('[data-kpi="cpp_net_gen"]').first()).toHaveText('216,000');
  await expect(page.locator('[data-kpi="cpp_aux_pct"]').first()).toHaveText('10.0%');
  await expect(page.locator('[data-kpi="cpp_avg_gen"]').first()).toHaveText('10.0');
  await expect(page.locator('[data-kpi="cpp_plf"]').first()).toHaveText('100.0%');
  /* SSC = 300 MT x 1000 / 240,000 kWh = 1.25 kg/kWh, shown to 1 dp */
  await expect(page.locator('[data-kpi="cpp_ssc"]').first()).toHaveText('1.3');
  /* SFC = 120 MT x 1000 / 240,000 kWh = 0.5 kg/kWh */
  await expect(page.locator('[data-kpi="cpp_sfc"]').first()).toHaveText('0.5');

  expect(errors(), 'uncaught errors while typing').toEqual([]);
});

test('coal received total sums the source tiles live', async ({ page }) => {
  await openForm(page);

  /* These five tiles were labelled "Manual Entry" but had no data-field and
     shipped hardcoded 114/10 values, under a hardcoded "124 TONS" total. */
  await page.fill('input[data-field="cpp_coal_recv_stamico"]', '114');
  await page.fill('input[data-field="cpp_coal_recv_ruvuma"]',  '10');
  await page.locator('input[data-field="cpp_coal_recv_ruvuma"]').blur();
  await page.waitForTimeout(200);

  await expect(page.locator('#coal-total')).toHaveText('124 TONS');
  await expect(page.locator('#coal-total-parts')).toHaveText('(STAMICO 114 + Ruvuma 10)');
});

test('an officer submission lands as pending_approval, with the readings intact', async ({ page }) => {
  await openForm(page);

  await page.fill('input[data-field="cpp_gross_gen_kwh"]', '238500');
  await page.fill('input[data-field="cpp_aux_kwh"]',       '23100');
  await page.fill('input[data-field="cpp_coal_cons"]',     '118.4');
  /* Two .btn-sub buttons are wired on this page (the toolbar's "Submit
     Report" and the sign-off card's "Submit & Lock"); form-persist binds
     both to the same handler, so either is a valid thing to click. */
  page.once('dialog', d => d.accept());   // form-persist's "Submit …?" confirm
  await page.getByRole('button', { name: 'Submit & Lock' }).click();
  await page.waitForTimeout(1200);

  const { rows } = await pool.query(
    "SELECT status, data FROM daily_reports WHERE form_type = 'cpp' AND record_date = $1", [D]);
  expect(rows.length, 'the submission should have created a row').toBe(1);

  /* Officer/senior submissions need the HOD's signature — only hod/admin/md
     self-approve (backend/routes/reports.js). */
  expect(rows[0].status).toBe('pending_approval');
  expect(+rows[0].data.cpp_gross_gen_kwh).toBe(238500);
  expect(+rows[0].data.cpp_aux_kwh).toBe(23100);
  expect(+rows[0].data.cpp_coal_cons).toBe(118.4);
});
