/*
  forms/quality-form.html — Blocks 3-5 (Raw Mill / Kiln Feed / Clinker).

  These three blocks held six 4-hour sample columns per parameter until
  2026-09-22 and now hold ONE day-average figure each, at the QC
  manager's request. The plant's QC DAILY REPORT workbook still records
  four-hourly; averaging those six rows moved into forms/excel-import.js,
  which is where the four-hourly data actually is. So the property this
  suite used to guard — "MTD must average each day's own Day Avg, not
  every individual hourly reading" — is now structurally impossible to
  get wrong on this page, because a day only ever has one reading.

  What remains worth guarding, and what this suite now covers:

    • the day-average fields are real, editable, persisted inputs;
    • MTD Avg is a plain mean of the days that HAVE a reading — not a
      mean that counts an empty day as zero, and not a sum;
    • it updates live from a typed, unsaved value.
*/
const { test, expect } = require('@playwright/test');
const { loginAs, collectErrors } = require('../fixtures/auth');
const { setReportDate } = require('../fixtures/forms');
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
  await setReportDate(page, D);
  await page.waitForTimeout(400);
}

test.beforeEach(cleanup);
test.afterAll(cleanup);

test('Raw Mill LSF MTD Avg is a live mean of the days that have a reading, unsaved', async ({ page }) => {
  const errors = collectErrors(page);
  /* Seed day: 90. Live day (typed, unsaved): 99. A sum would read 189;
     counting the month's other empty days as zero would drag it far
     below 90; the correct figure is (90 + 99) / 2 = 94.5. */
  await seedMtdHistory({ lsf_rm: 90 });
  await openForm(page);

  await expect(page.locator('[data-kpi="lsf_rm_mtd"]').first()).toHaveText('90.0');

  await page.fill('input[data-field="lsf_rm"]', '99');
  await page.locator('input[data-field="lsf_rm"]').blur();
  await page.waitForTimeout(300);

  const rows = await pool.query(
    "SELECT 1 FROM daily_reports WHERE form_type = 'quality' AND record_date = $1", [D]);
  expect(rows.rowCount, 'nothing should be persisted yet').toBe(0);

  await expect(page.locator('[data-kpi="lsf_rm_mtd"]').first()).toHaveText('94.5');

  expect(errors(), 'uncaught errors while typing').toEqual([]);
});

test('every Raw Mill / Kiln Feed / Clinker day-average field is a real, editable input', async ({ page }) => {
  await openForm(page);
  const fields = [
    /* Raw Mill — moduli, plus fineness split by mill (RM-1 / RM-2), which
       the workbook reports separately and the form did not carry at all
       before 2026-09-22. */
    'lsf_rm', 'sm_rm', 'am_rm', 'r90_rm1', 'r212_rm1', 'r90_rm2', 'r212_rm2',
    'moisture_rm', 'caco3_rm',
    /* Kiln Feed */
    'lsf_kf', 'sm_kf', 'am_kf', 'r90_kf', 'r212_kf', 'freecao_kf',
    /* Clinker — litre weight, F.CaO (the `free_lime` registry fact, which
       lives here and nowhere else now), moduli and all five Bogue phases. */
    'ltrwt_ck', 'free_lime', 'lsf_ck', 'sm_ck', 'am_ck',
    'c3s_ck', 'c2s_ck', 'c3a_ck', 'c4af_ck', 'liquid_ck',
  ];
  for (const field of fields) {
    await expect(page.locator(`input[data-field="${field}"]`), `${field} must be editable`).toBeEditable();
  }
});

/* The four-hourly fields are gone, not renamed. A page that still shipped
   any of them would mean the rebuild was applied on top of the old table
   instead of replacing it — which would leave two inputs writing the same
   measurement and only one of them feeding the KPIs. */
test('the six 4-hour sample inputs no longer exist anywhere on the page', async ({ page }) => {
  await openForm(page);
  for (const prefix of ['lsf_rm', 'sm_rm', 'am_rm', 'r90_rm', 'lsf_kf', 'freecao_kf',
                        'c3s_ck', 'freelime_ck', 'lsf_ck']) {
    for (let i = 1; i <= 6; i++) {
      await expect(page.locator(`input[data-field="${prefix}_h${i}"]`),
        `${prefix}_h${i} should have been replaced by a day average`).toHaveCount(0);
    }
  }
});
