/*
  scripts/warm-dashboards-once.js — run the Sales/Purchases dashboard cache
  warmer a single time and print the result. Mirrors watchdog-once.js /
  odoo-sync-once.js. Useful right after a deploy/restart, when the
  in-process cache starts cold and the first real viewer would otherwise
  pay the full 30-49s Odoo round trip for whichever month they open first.

  Usage:
    node scripts/warm-dashboards-once.js [monthsBack]
    node scripts/warm-dashboards-once.js        (defaults to 12)
    node scripts/warm-dashboards-once.js 3
*/
require('../config/env');
const { warmDashboards } = require('../services/dashboardCacheWarmer');

const monthsBack = process.argv[2] !== undefined ? parseInt(process.argv[2], 10) : 12;

(async () => {
  try {
    console.log(`Warming Sales + Purchases dashboard cache for the current month plus ${monthsBack} before it…`);
    const result = await warmDashboards({ monthsBack });
    console.log('DASHBOARD_WARM_RESULT ' + JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('DASHBOARD_WARM_FAILED ' + err.message);
    process.exit(1);
  }
})();
