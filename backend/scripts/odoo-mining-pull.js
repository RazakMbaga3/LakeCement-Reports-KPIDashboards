/*
  scripts/odoo-mining-pull.js — manual mining_report pull for an explicit
  date range: backfilling the Quarry ticket log, catching up after an outage
  longer than odooSync.js's rolling window, or just checking what Odoo holds
  for a period before trusting it.

  Usage:
    node scripts/odoo-mining-pull.js <from YYYY-MM-DD> <to YYYY-MM-DD>
    node scripts/odoo-mining-pull.js 2026-03-01 2026-03-31
    node scripts/odoo-mining-pull.js 2026-03-01 2026-03-31 --overwrite-excel

  By default any date that already holds manually uploaded (Excel) tickets
  is SKIPPED and listed in the result as datesSkippedExcel — syncing it
  would double-count that day's tonnage. --overwrite-excel deletes those
  Excel rows for the pulled dates and replaces them with Odoo's, which is
  destructive and therefore never the default.

  A month is ~4-5k rows and takes ~10s. The endpoint has no pagination and
  truncates large ranges, so pull month by month rather than a whole year.

  Requires ODOO_MINING_URL + ODOO_MINING_API_KEY (or the ODOO_DISPATCH_*
  pair it falls back to — NOT the dashboard pair) — see
  services/odooMiningClient.js.
*/
require('../config/env');
const { pullMiningTickets } = require('../services/odooMiningSync');

const args = process.argv.slice(2);
const overwriteExcelDates = args.includes('--overwrite-excel');
const [from, to] = args.filter(a => !a.startsWith('--'));

const ISO = /^\d{4}-\d{2}-\d{2}$/;
if (!from || !to || !ISO.test(from) || !ISO.test(to)) {
  console.error('Usage: node scripts/odoo-mining-pull.js <from YYYY-MM-DD> <to YYYY-MM-DD> [--overwrite-excel]');
  process.exit(1);
}
if (from > to) {
  console.error(`Empty range: from (${from}) is after to (${to}).`);
  process.exit(1);
}

(async () => {
  try {
    const result = await pullMiningTickets(from, to, { overwriteExcelDates });
    console.log('MINING_PULL_RESULT ' + JSON.stringify(result, null, 2));

    if (result.datesSkippedExcel.length) {
      console.log(
        `\nNOTE: ${result.datesSkippedExcel.length} date(s) were skipped because they already hold `
        + 'manually uploaded tickets. Syncing them would have double-counted that tonnage. '
        + 'Re-run with --overwrite-excel to replace the Excel rows with Odoo\'s.');
    }
    if (result.rowsReceived === 0) {
      console.log(
        `\nNOTE: Odoo returned no mining rows for ${from}..${to}. Since the 2026-09-23 move to `
        + 'the production ERP this usually means a genuinely quiet period rather than missing test '
        + 'data — but confirm with a wider range before assuming the plant was idle.');
    }
    if (result.rowsUnknownProduct) {
      console.log(
        `\nNOTE: ${result.rowsUnknownProduct} ticket(s) used an Odoo product code with no known grade `
        + `mapping (${Object.keys(result.unknownProductCodes).join(', ')}). They are stored, but excluded `
        + 'from the Quarry report\'s totals until services/odooMiningSync.js\'s PRODUCT_LABEL is updated '
        + 'for that code — confirm what it is with the mines/Odoo team first.');
    }
    process.exit(0);
  } catch (err) {
    console.error('MINING_PULL_FAILED ' + err.message);
    process.exit(1);
  }
})();
