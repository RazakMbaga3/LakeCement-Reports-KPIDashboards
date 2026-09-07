/*
  power-plant-report.html as a DATA ENTRY form.

  Until 2026-09-04 this page rendered all 22 CPP metrics as read-only
  data-kpi cells while still carrying a date picker, Save Draft and
  "Submit & Lock" — a form a CPP officer could not type a single reading
  into. Every stored day had arrived through backend/scripts/import-cpp.js.

  These tests hold the two halves of the fix in place:
    1. the raw readings are real inputs the owning role can edit, and
    2. the derived figures recompute AS YOU TYPE, before anything is saved
       (the page feeds one CPP_COMPUTES array to both report-loader, which
       runs it against the saved record, and kpi-live, which re-runs it
       against the live inputs).

  Since 2026-09-05, Heat Rate (TG) and Heat Rate (Plant) moved from that
  editable set into a third category: FRM-LCL-PP-06's own formula cells
  (Boiler/Turbine Steam × (Superheated − Feedwater Enthalpy) [+ DM Water
  term] × 1000 ÷ Gross Generation [÷ Boiler Efficiency]). The source Excel
  hardcoded that day's enthalpy/efficiency readings straight into the
  formula; this page instead collects them as their own daily constants and
  auto-computes the two heat rates from them, so they are still a real
  data-field input (Save Draft/Submit must still persist a number) but are
  no longer one the officer types into directly.

  Entry is asserted as `cpp_officer` — level 'officer' is the person who
  actually fills this in on shift, and their submission needs the HOD's
  signature rather than self-approving.
*/
const { test, expect } = require('@playwright/test');
const { loginAs, collectErrors } = require('../fixtures/auth');
const { pool } = require('../fixtures/db');

const D = '1999-06-17';
/* An earlier day in the same fiscal-year-month as D, seeded as an already-
   saved report — stands in for "history already on the server" so the MTD
   live-blend tests can check it's folded in alongside the still-unsaved,
   currently-typed day. */
const MTD_SEED_DATE = '1999-06-01';

/* Every reading the importer writes, minus the two now-computed heat rate
   fields (see HEAT_RATE_FIELDS below), plus the four constants the heat
   rate formulas are built from — the form must be able to produce the same
   record shape by hand, or UI-entered days stay poorer than imported ones.
   Mirrors ROW_FACT in backend/scripts/import-cpp.js plus the two fly-ash
   quality fields it reads from row 33. */
const READINGS = [
  'cpp_gross_gen_kwh', 'cpp_aux_kwh', 'cpp_run_hrs', 'cpp_feed_water_mt',
  'cpp_boiler_steam_mt', 'cpp_bleed_steam_mt', 'cpp_turbine_steam_mt',
  'cpp_condensate_mt', 'cpp_aux_steam_mt',
  'cpp_superheated_steam_enthalpy', 'cpp_feedwater_enthalpy',
  'cpp_dm_water_enthalpy', 'cpp_boiler_efficiency',
  'cpp_dg_gen_kwh', 'cpp_coal_cons', 'cpp_coal_gcv',
  'cpp_dm_water_gen_m3', 'cpp_dm_water_cons_m3', 'cpp_ct_makeup_m3',
  'cpp_flyash_combustible_pct', 'cpp_flyash_gcv', 'cpp_flyash_to_cm_mt',
  'cpp_flyash_to_coalyard_nos', 'cpp_flyash_to_dumpyard_nos',
];

/* Importer-written fields that are on the page but are no longer meant to
   be typed into — FRM-LCL-PP-06's own formula cells, auto-computed here. */
const HEAT_RATE_FIELDS = ['cpp_heat_rate_tg', 'cpp_heat_rate_plant'];

async function cleanup() {
  await pool.query("DELETE FROM daily_reports WHERE form_type = 'cpp' AND record_date IN ($1, $2)", [D, MTD_SEED_DATE]);
}

async function seedMtdHistory(data) {
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['e2e_cpp_officer']);
  await pool.query(
    `INSERT INTO daily_reports (form_type, record_date, shift, data, submitted_by, submitted_at, status)
     VALUES ('cpp', $1, 'day', $2, $3, NOW(), 'approved')`,
    [MTD_SEED_DATE, JSON.stringify(data), rows[0].id]
  );
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

test('heat rate fields exist to hold a value but are no longer typed in by hand', async ({ page }) => {
  await openForm(page);

  for (const field of HEAT_RATE_FIELDS) {
    const input = page.locator(`input[data-field="${field}"]`);
    await expect(input, `${field} must still be a real input so Submit persists it`).toHaveCount(1);
    await expect(input, `${field} should be auto-computed, not hand-typed`).not.toBeEditable();
  }
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
  /* Heat rate constants, read off the lab/DCS each day (FRM-LCL-PP-06). */
  await page.fill('input[data-field="cpp_boiler_steam_mt"]',              '280');
  await page.fill('input[data-field="cpp_superheated_steam_enthalpy"]',   '800');
  await page.fill('input[data-field="cpp_feedwater_enthalpy"]',           '150');
  await page.fill('input[data-field="cpp_dm_water_cons_m3"]',             '10');
  await page.fill('input[data-field="cpp_dm_water_enthalpy"]',            '30');
  await page.fill('input[data-field="cpp_boiler_efficiency"]',            '0.8');
  /* kpi-live listens on input/change; blur the last field so change fires. */
  await page.locator('input[data-field="cpp_boiler_efficiency"]').blur();
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

  /* Heat Rate (Plant) = 280 MT x (800-150) kcal/kg x 1000 / (240,000 kWh x 0.8)
     = 182,000,000 / 192,000 = 947.9 kcal/kWh */
  await expect(page.locator('input[data-field="cpp_heat_rate_plant"]')).toHaveValue('947.9');
  /* Heat Rate (TG) = [300 MT x (800-150) + 10 m³ x 30] x 1000 / 240,000 kWh
     = 195,300,000 / 240,000 = 813.8 kcal/kWh */
  await expect(page.locator('input[data-field="cpp_heat_rate_tg"]')).toHaveValue('813.8');
  /* The top summary strip reads cpp_heat_rate_plant, so it must see the same
     freshly-computed number on this tick, not the previous keystroke's. */
  await expect(page.locator('[data-kpi="cpp_heat_rate"]').first()).toHaveText('948');

  expect(errors(), 'uncaught errors while typing').toEqual([]);
});

test('MTD figures fold in the live, unsaved day without waiting for a save', async ({ page }) => {
  /* MTD_SEED_DATE (already "saved" on the server): gross 100,000 kWh,
     aux 5,000 kWh -> 5% aux. D (typed live, never saved): gross 50,000 kWh,
     aux 10,000 kWh -> 20% aux. A naive average of the two days' percentages
     is 12.5% — the correct generation-weighted MTD figure is
     15,000 / 150,000 = 10%. Only the weighted math tells them apart, so
     this also stands as the "some MTD/YTD figures are not cumulative"
     regression check. */
  await seedMtdHistory({ cpp_gross_gen_kwh: 100000, cpp_aux_kwh: 5000 });
  await openForm(page);

  /* Before any typing, the seeded day alone is the whole MTD/YTD figure. */
  await expect(page.locator('[data-roll-mtd="cpp_gross_gen_kwh"]')).toHaveText('100,000');
  await expect(page.locator('[data-kpi="cpp_aux_pct_mtd"]').first()).toHaveText('5.00%');

  await page.fill('input[data-field="cpp_gross_gen_kwh"]', '50000');
  await page.fill('input[data-field="cpp_aux_kwh"]',       '10000');
  await page.locator('input[data-field="cpp_aux_kwh"]').blur();
  await page.waitForTimeout(300);

  /* Nothing for D has been saved — the update must come from the DOM alone. */
  const rows = await pool.query(
    "SELECT 1 FROM daily_reports WHERE form_type = 'cpp' AND record_date = $1", [D]);
  expect(rows.rowCount, 'nothing should be persisted yet').toBe(0);

  await expect(page.locator('[data-roll-mtd="cpp_gross_gen_kwh"]')).toHaveText('150,000');
  await expect(page.locator('[data-roll-mtd="cpp_aux_kwh"]')).toHaveText('15,000');
  /* Generation-weighted, not (5% + 20%) / 2 = 12.5%. */
  await expect(page.locator('[data-kpi="cpp_aux_pct_mtd"]').first()).toHaveText('10.00%');
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
