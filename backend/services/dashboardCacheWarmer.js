/*
  services/dashboardCacheWarmer.js — proactively fills odooDashboardClient's
  in-process cache for Sales and Purchases so a real user navigating to a
  past month hits a warm cache instead of paying the full Odoo round trip.

  Why this exists: sale_dashboard_report has a known, still-open server-side
  defect (odooDashboardClient.js header, defect 3) — its customer_receipts
  array ignores the date filter entirely and returns the WHOLE history
  (30,700+ rows for a single month's request on production), so every
  cold call downloads and parses a multi-MB bundle regardless of how
  narrow the requested range is. Measured 2026-09-23 against production:
  a single cold sales.getDashboard() call costs 30-49 SECONDS; the exact
  same call against odooDashboardClient's warm cache costs ~170ms. That
  gap is the entire "navigating past months feels broken" complaint — it
  is Odoo's endpoint being slow, not this app's own code, and the honest
  fix is the Odoo team correcting the date filter server-side. Until then,
  this is the best lever available on our side: make sure nobody is ever
  the first person to ask for a given past month.

  Deliberately does NOT try to keep the CURRENT month warm on a tight
  cycle: odooDashboardClient caches an open (current) range for only 5
  minutes, on purpose, because today's figures are still moving — re-
  warming that every few minutes would mean paying the full 30-49s cost
  forever, far more Odoo load than the problem is worth. Closed months
  never change, so warming them on a cycle safely inside their 12-hour
  cache TTL (see DASHBOARD_WARM_CRON's default in server.js) means a real
  user should never wait on one. The current month is warmed once per
  cycle too — better than nothing — but a user can still be first to ask
  within a given 5-minute window and pay the full cost. That is an
  inherent freshness/latency trade-off, not a bug in this file.

  Sequential, not parallel: this hits the same slow endpoint the Odoo
  team already flagged as having no pagination and a truncation risk on
  large responses — piling concurrent multi-MB requests onto it would
  make things worse, not better. A small delay between calls gives it
  room to breathe.
*/
const logger    = require('./logger');
const sales     = require('./sales');
const purchases = require('./purchases');

const INTER_CALL_DELAY_MS = 500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* [{year, month}, ...] for the current month plus `monthsBack` months
   before it, oldest first — matches how a year/month dropdown navigates. */
function trailingMonths(monthsBack) {
  const out = [];
  const now = new Date();
  for (let i = monthsBack; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }
  return out;
}

async function warmDashboards({ monthsBack = 12 } = {}) {
  const months = trailingMonths(monthsBack);
  const t0 = Date.now();
  let salesOk = 0, salesFailed = 0, purchasesOk = 0, purchasesFailed = 0;

  for (const { year, month } of months) {
    try {
      await sales.getDashboard(year, month);
      salesOk++;
    } catch (err) {
      salesFailed++;
      logger.warn({ err, year, month }, 'dashboard warmer: sales.getDashboard failed');
    }
    await sleep(INTER_CALL_DELAY_MS);

    try {
      await purchases.getDashboard({ year, month });
      purchasesOk++;
    } catch (err) {
      purchasesFailed++;
      logger.warn({ err, year, month }, 'dashboard warmer: purchases.getDashboard failed');
    }
    await sleep(INTER_CALL_DELAY_MS);
  }

  const result = {
    months: months.length,
    salesOk, salesFailed, purchasesOk, purchasesFailed,
    ms: Date.now() - t0,
  };
  logger.info(result, 'dashboard cache warmer finished');
  return result;
}

module.exports = { warmDashboards, trailingMonths };
