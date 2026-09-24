/*
  forms/dispatch-form.html — what the entry form still owns.

  HISTORY, because two tests used to live here and were removed on purpose.

  This file once held three specs for the dispatch matrix's MTD/YTD layer: that
  its [data-roll-mtd] / [data-roll-ytd] cells folded in the live, unsaved day
  without waiting for a save, and that "MTD Target Achievement %"
  (dispatch_mtd_pct) recomputed from the report-rollup MTD sum. They were real
  and they passed.

  Then d1bffe4 split Dispatch & SO into a review page and a slimmed entry form,
  and moved that whole layer OFF the entry form — deliberately. The form's own
  comment says why: the KPI strip "answered a reviewer's question, not an entry
  one, and it computed those answers from whatever was in the cells rather than
  from anything submitted". The form now carries zero data-roll-* cells and no
  report-rollup at all; MTD/YTD lives on dispatch.html, driven by the server
  and the formula registry.

  The two specs kept asserting the removed UI, so they failed with "element(s)
  not found" from that commit onward — and sat in the suite as "pre-existing
  failures" for weeks. A red test for a feature that was intentionally deleted
  carries no signal and teaches people to ignore the suite, so they are gone
  rather than skipped. (Confirmed, not assumed: grep finds no data-roll-mtd on
  either page, and report-rollup only on dispatch.html.)

  KNOWN GAP: dispatch.html's own MTD/YTD context switch has no e2e coverage.
  It is the natural home for the replacement of those two specs.

  What remains is the one thing the entry form must always do.
*/
const { test, expect } = require('@playwright/test');
const { loginAs } = require('../fixtures/auth');
const { setReportDate } = require('../fixtures/forms');
const { pool } = require('../fixtures/db');

const D = '1999-06-18';

async function cleanup() {
  await pool.query("DELETE FROM daily_reports WHERE form_type = 'dispatch' AND record_date = $1", [D]);
}

async function openForm(page) {
  await loginAs(page, 'logistics');
  await page.goto('/forms/dispatch-form.html');
  await page.waitForLoadState('networkidle');
  await setReportDate(page, D);
  await page.waitForTimeout(400);
}

test.beforeEach(cleanup);
test.afterAll(cleanup);

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
