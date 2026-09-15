/*
  scripts/odoo-dispatch-pull.js — one-off/manual dispatch-report pull for
  an explicit date range (testing, backfill, or catching up after an
  outage longer than odooSync.js's rolling lookback window).

  Usage:
    node scripts/odoo-dispatch-pull.js <from YYYY-MM-DD> <to YYYY-MM-DD>
    node scripts/odoo-dispatch-pull.js 2026-01-15 2026-01-16

  Requires ODOO_DISPATCH_URL + ODOO_DISPATCH_API_KEY in .env — see
  services/odooDispatchClient.js.
*/
require('../config/env');
const { pullDispatchDailySummary } = require('../services/odooDispatchSync');

const [, , from, to] = process.argv;

if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
  console.error('Usage: node scripts/odoo-dispatch-pull.js <from YYYY-MM-DD> <to YYYY-MM-DD>');
  process.exit(1);
}

(async () => {
  try {
    const result = await pullDispatchDailySummary(from, to);
    console.log('DISPATCH_PULL_RESULT ' + JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('DISPATCH_PULL_FAILED ' + err.message);
    process.exit(1);
  }
})();
