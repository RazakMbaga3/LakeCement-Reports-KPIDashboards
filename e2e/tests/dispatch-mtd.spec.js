/*
  forms/dispatch-form.html's MTD/YTD figures.

  Until this change, the dispatch matrix's MTD/YTD cells (other than
  Regular Bags 42.5R/42.5N, which showed plausible-but-static numbers)
  were either hardcoded or an honest em-dash with a note saying the
  rollup hadn't been built. The 15 channel/grade dispatch fields
  themselves were already real data-field inputs (unlike quality-form.html
  or power-form.html, where most of the underlying daily fields aren't
  captured at all) — this only needed the MTD/YTD layer wired on top,
  live, the same way power-plant-report.html and daily-report.html got it.

  "MTD Target Achievement %" is the one figure here that ISN'T a plain
  sum: it's this month's live dispatch total ÷ this month's target (a
  manual figure, not itself summable), so report-rollup.js's live cache is
  read via its public reportRollupLiveSum() helper rather than painted
  directly.
*/
const { test, expect } = require('@playwright/test');
const { loginAs, collectErrors } = require('../fixtures/auth');
const { pool } = require('../fixtures/db');

const D = '1999-06-18';
const MTD_SEED_DATE = '1999-06-01';

async function cleanup() {
  await pool.query("DELETE FROM daily_reports WHERE form_type = 'dispatch' AND record_date IN ($1, $2)", [D, MTD_SEED_DATE]);
}

async function seedMtdHistory(data) {
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', ['e2e_logistics']);
  await pool.query(
    `INSERT INTO daily_reports (form_type, record_date, shift, data, submitted_by, submitted_at, status)
     VALUES ('dispatch', $1, 'day', $2, $3, NOW(), 'approved')`,
    [MTD_SEED_DATE, JSON.stringify(data), rows[0].id]
  );
}

async function openForm(page) {
  await loginAs(page, 'logistics');
  await page.goto('/forms/dispatch-form.html');
  await page.waitForLoadState('networkidle');
  await page.fill('input[type="date"]', D);
  await page.waitForTimeout(400);
}

test.beforeEach(cleanup);
test.afterAll(cleanup);

test('dispatch matrix MTD/YTD fold in the live, unsaved day without waiting for a save', async ({ page }) => {
  await seedMtdHistory({ dispatch_reg_425r: 1000, dispatch_blk_425r: 200 });
  await openForm(page);

  await expect(page.locator('[data-roll-mtd="dispatch_reg_425r"]')).toHaveText('1,000');
  await expect(page.locator('[data-roll-ytd="dispatch_reg_425r"]')).toHaveText('1,000');
  await expect(page.locator('[data-roll-mtd="dispatch_blk_425r"]')).toHaveText('200');

  await page.fill('input[data-field="dispatch_reg_425r"]', '150');
  await page.fill('input[data-field="dispatch_blk_425r"]', '50');
  await page.locator('input[data-field="dispatch_blk_425r"]').blur();
  await page.waitForTimeout(300);

  const rows = await pool.query(
    "SELECT 1 FROM daily_reports WHERE form_type = 'dispatch' AND record_date = $1", [D]);
  expect(rows.rowCount, 'nothing should be persisted yet').toBe(0);

  await expect(page.locator('[data-roll-mtd="dispatch_reg_425r"]')).toHaveText('1,150');
  await expect(page.locator('[data-roll-ytd="dispatch_reg_425r"]')).toHaveText('1,150');
  await expect(page.locator('[data-roll-mtd="dispatch_blk_425r"]')).toHaveText('250');
});

test('MTD Target Achievement % updates live from the report-rollup MTD sum, not a per-day average', async ({ page }) => {
  /* Seed 4,000 MT already dispatched this month; type 1,000 MT more
     (unsaved) against a 10,000 MT monthly target -> 5,000 / 10,000 = 50%.
     This is the one dispatch figure that isn't a plain sum, so it proves
     reportRollupLiveSum() is feeding the ratio, not report-rollup's own
     [data-roll-mtd] painting (which can't divide by another field). */
  await seedMtdHistory({ dispatch_reg_425r: 4000 });
  await openForm(page);

  await page.fill('input[data-field="dispatch_mtd_target"]', '10000');
  await page.fill('input[data-field="dispatch_reg_425r"]', '1000');
  await page.locator('input[data-field="dispatch_reg_425r"]').blur();
  await page.waitForTimeout(300);

  await expect(page.locator('[data-kpi="dispatch_mtd_pct"]').first()).toHaveText('50.0%');
  await expect(page.locator('#dispatch-mtd-pct-lbl')).toHaveText('50.0%');
});

test('every real dispatch field is still editable for the logistics role', async ({ page }) => {
  await openForm(page);
  const fields = [
    'dispatch_reg_425r', 'dispatch_reg_425nbm', 'dispatch_reg_425n', 'dispatch_reg_325n', 'dispatch_reg_opc425n',
    'dispatch_blk_425r', 'dispatch_blk_425nbm', 'dispatch_blk_425n', 'dispatch_blk_325n', 'dispatch_blk_opc425n',
    'dispatch_bag_425r', 'dispatch_bag_425nbm', 'dispatch_bag_425n', 'dispatch_clinker', 'dispatch_mtd_target',
  ];
  for (const field of fields) {
    await expect(page.locator(`input[data-field="${field}"]`), `${field} must be editable`).toBeEditable();
  }
});
