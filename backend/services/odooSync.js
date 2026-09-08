/*
  services/odooSync.js — scheduled pull from Odoo into lcl_mis.

  Two DIFFERENT Odoo connection types are in play here, deliberately not
  unified into one client:
    - odooClient.js: the generic Odoo External API (XML/JSON-RPC,
      ODOO_URL/ODOO_DB/ODOO_USERNAME/ODOO_API_KEY, a real Odoo user login).
      Not used by anything wired up yet.
    - odooDispatchClient.js: a bespoke REST-ish controller the Odoo team
      built specifically for this app (ODOO_DISPATCH_URL/
      ODOO_DISPATCH_API_KEY, a single opaque key, form-encoded POST, no
      Odoo user session at all). This is what dispatch-daily-summary uses.
  A pull only needs to authenticate via whichever client it actually calls
  — there is no longer a blanket "log into generic Odoo first" step, since
  that would wrongly gate a dispatch-only pull behind XML-RPC credentials
  nobody has issued.

  Confirmed/wired targets:
    1. Dispatch daily summary (services/odooDispatchSync.js) — already-
       aggregated per (date, product_grade, dispatch_channel) totals,
       mapped onto forms/dispatch-form.html's dispatch_reg_/dispatch_blk_/
       dispatch_bag_ fields and upserted into daily_reports
       (form_type='dispatch'). Feeds the standalone Dispatch report, NOT
       the dashboard's "Despatch / Day" KPI (that's sourced from the
       Production Report's CM-1 stock ledger since 2026-07-31 — see
       forms/formula-registry.js). Each run re-pulls a short trailing
       window (see DISPATCH_LOOKBACK_DAYS below) so a missed day self-
       heals on the next run — upserts are idempotent.
    2. Mining weighbridge tickets (services/odooMiningSync.js) — raw
       per-weighing rows from the bespoke mining_report endpoint, mirrored
       into weighbridge_tickets, which the Quarry dashboard already reads.
       This automates what was a manual Excel upload; dates that already
       hold uploaded tickets are skipped rather than double-counted. Same
       rolling-window logic as dispatch, and idempotent for the same
       reason — see that file on why its ticket numbers are synthesised.
    3. "Production Entry Raw Meal" — moisture-adjusted (wet→dry) raw
       material consumption for limestone/clay/iron ore/sand. Not yet
       confirmed with the Odoo team; no pull written.

  Scheduled in server.js on ODOO_SYNC_CRON (default 05:00 daily, off if
  ODOO_SYNC_CRON=off). Manual run: `npm run odoo:sync`, or for a specific
  date range: `npm run odoo:dispatch-pull -- 2026-08-01 2026-08-05`,
  `npm run odoo:mining-pull -- 2026-03-01 2026-03-31`.
*/

const logger = require('./logger');
const { fireAlert } = require('./watchdog');
const { pullDispatchDailySummary } = require('./odooDispatchSync');
const { pullMiningTickets } = require('./odooMiningSync');

// How many trailing days each scheduled run re-pulls — wide enough that a
// skipped/failed run (server down, Odoo unreachable) self-heals within a
// few days without needing a manual backfill, cheap enough (a handful of
// upserts) to run daily without concern.
const DISPATCH_LOOKBACK_DAYS = 5;

// Mining pulls raw per-weighing rows rather than dispatch's pre-aggregated
// day totals — roughly 150 rows per day, so the same 5-day window is still
// only a few hundred rows, but it is deliberately not widened much beyond
// that: each run re-reads and re-mirrors every date in the window.
const MINING_LOOKBACK_DAYS = 5;

function isoDate(d) { return d.toISOString().slice(0, 10); }

function lookbackRange(days) {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - (days - 1));
  return { from: isoDate(from), to: isoDate(to) };
}

/* One entry per confirmed dataset: { name, run }. run() pulls + upserts and
   returns a small summary object (added/updated counts, date range, …). */
const PULLS = [
  {
    name: 'dispatch-daily-summary',
    run: () => {
      const { from, to } = lookbackRange(DISPATCH_LOOKBACK_DAYS);
      return pullDispatchDailySummary(from, to);
    },
  },
  {
    name: 'mining-weighbridge-tickets',
    run: () => {
      const { from, to } = lookbackRange(MINING_LOOKBACK_DAYS);
      /* Never overwrite manual uploads on a schedule: if someone has
         already uploaded a day's Excel export, the automatic run leaves it
         alone and reports the date as skipped. Replacing an operator's
         data is only ever an explicit, manual decision — see
         scripts/odoo-mining-pull.js --overwrite-excel. */
      return pullMiningTickets(from, to, { overwriteExcelDates: false });
    },
  },
  // { name: 'raw-meal-consumption', run: pullRawMealConsumption },
];

async function runOdooSync() {
  if (!PULLS.length) {
    logger.info('odoo sync: no pulls configured yet — skipping');
    return { ran: [], skipped: 'no pulls configured' };
  }

  const ran = [];
  for (const pull of PULLS) {
    try {
      const result = await pull.run();
      ran.push({ name: pull.name, ...result });
      /* Rows Odoo sent that we could not store are the one failure mode a
         successful-looking sync can hide: the run reports "ok" while that
         tonnage is simply missing. Dispatch calls them unmapped (no field
         mapping), mining calls them rejected (unusable date/quantity) —
         either way somebody has to look. */
      const dropped = (result?.rowsUnmapped || 0) + (result?.rowsRejected || 0);
      if (dropped) {
        await fireAlert(
          'odoo-sync-dropped-rows:' + pull.name,
          `${dropped} row(s) from '${pull.name}' could not be stored and were not written anywhere — `
          + 'check the server logs for samples, then review the mapping in the pull\'s sync service.'
        ).catch(() => { /* alerting must never break the sync itself */ });
      }
    } catch (err) {
      logger.error({ err, pull: pull.name }, 'odoo sync pull failed');
      ran.push({ name: pull.name, error: err.message });
      await fireAlert(
        'odoo-sync-failed:' + pull.name,
        `Odoo sync pull '${pull.name}' failed: ${err.message}`
      ).catch(() => { /* alerting must never break the sync itself */ });
    }
  }
  return { ran };
}

module.exports = { runOdooSync };
