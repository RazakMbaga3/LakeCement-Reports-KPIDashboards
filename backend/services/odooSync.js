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
    3. Production entries (services/odooProductionSync.js +
       odooProductionAutofill.js) — the production_report endpoint,
       delivered 2026-09-20 on the PRODUCTION ERP (not the test server the
       two above still use). Mirrored into odoo_production_entries
       (migration 018); the daily production report's tonnages and
       material consumption are derived from that mirror by
       config/odooProductionMap.js and written into daily_reports
       (form_type='production') by odooProductionAutofill.js — Phase 3,
       wired below since 2026-09-21. New days land as 'draft' (an officer
       still reviews and submits them); a day that already has a report
       gets its Odoo-owned fields corrected in place if they disagree,
       logged to production_odoo_overrides, with the report's own
       status/approval untouched either way. It also carries the
       moisture-corrected raw-material figures the original "Production
       Entry Raw Meal" ask wanted (`final_qty_after_moisture`).

  Two schedules in server.js:
    - ODOO_SYNC_CRON — every pull below, default 05:00 daily, off if
      ODOO_SYNC_CRON=off.
    - ODOO_LIVE_SYNC_CRON — only LIVE_PULLS (mining tickets + dispatch),
      default every 30 minutes, plus once ~1 min after every boot so a
      deploy/restart closes any gap immediately. Added 2026-09-24 when the
      Quarry report was found missing the 22nd and 23rd with no way to tell
      whether pulling was even running: a daily 05:00 job can't be "live"
      for a weighbridge, and Odoo also receives a day's tickets late (the
      22nd was still empty on the morning of the 23rd).
  Every run is recorded in odoo_sync_state (migration 026) and surfaced by
  GET /api/health, so "is it pulling?" has an answer that doesn't need
  server access. Manual run: `npm run odoo:sync`, or for a specific
  date range: `npm run odoo:dispatch-pull -- 2026-08-01 2026-08-05`,
  `npm run odoo:mining-pull -- 2026-03-01 2026-03-31`,
  `npm run odoo:production-sync -- 2026-09-01 2026-09-20 [--dry-run]`.
*/

const db = require('../db');
const logger = require('./logger');
const { fireAlert } = require('./watchdog');
const { pullDispatchDailySummary } = require('./odooDispatchSync');
const { pullMiningTickets } = require('./odooMiningSync');
const { pullAndAutofillProduction } = require('./odooProductionAutofill');
const { pullAllStores } = require('./odooStoresSync');

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

// Wider than the other two: entries have arrived several days late in
// observed pulls (Phase 1's analysis found no Raw Meal/Clinker/Fine Coal
// entries for several consecutive days that later filled in), so a 5-day
// window risks permanently missing a late entry once it falls out of range.
const PRODUCTION_LOOKBACK_DAYS = 7;

// Widest of the four, and the reason is measured rather than cautious: a GRN
// is booked 0.1-5.1 days after the truck physically arrives (mean 1.5), over
// the 2026-09-16 sample. A day's rows are therefore NOT final when that day
// ends — a gate entry that was pending-GRN on Monday gets its GRN on
// Wednesday and the Monday row has to change. 7 days covers the observed
// maximum lag with headroom; anything shorter would freeze some trucks as
// permanently "pending GRN" once they fell out of the window.
const STORES_LOOKBACK_DAYS = 7;

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
  {
    name: 'production-report-autofill',
    run: () => {
      const { from, to } = lookbackRange(PRODUCTION_LOOKBACK_DAYS);
      return pullAndAutofillProduction(from, to);
    },
  },
  {
    /* Gate entries + GRN lines + material issues, feeding the Raw Material
       and Stores reports. pullAllStores runs the three sequentially and
       survives one failing — see odooStoresSync.js for why parallel is the
       wrong call against this ERP. */
    name: 'stores-gate-grn-issues',
    run: () => {
      const { from, to } = lookbackRange(STORES_LOOKBACK_DAYS);
      return pullAllStores(from, to);
    },
  },
];

/* The pulls the frequent "live" job in server.js runs — defined in
   config/odooPulls.js, which health.js reads too (see that file for why it
   is not defined here).

   The production autofill was deliberately left off this list when it was
   added on 2026-09-24 — the reasoning being that a day's tonnages don't move
   minute to minute the way a weighbridge does. That reasoning was wrong in
   practice for one reason: the daily job it was left on is gated by
   ODOO_SYNC_CRON, which .env.example ships as `off`, so on a droplet built
   from that file the autofill never ran at all. Production stayed empty for
   days while Mining and Dispatch stayed current, because only they were on
   the switch that defaults to ON. Being on the same schedule as the other two
   is what makes "is it pulling?" have one answer instead of three.

   Re-running it is safe and near-free when nothing changed: the pull is
   idempotent (content-hashed entries, unchanged rows are a no-op) and the
   autofill only writes a field whose value actually differs, so a repeat run
   over a quiet window writes nothing and logs no override. */
const { LIVE_PULLS } = require('../config/odooPulls');

/* Remember what a pull last did (migration 026). This is the only way to
   tell, from inside the app, whether a pull is really live — and it must
   never be the thing that breaks a sync, so a failure to record is logged
   and swallowed. */
async function recordRun(name, { result, error }) {
  try {
    if (error) {
      await db.query(`
        INSERT INTO odoo_sync_state (pull_name, last_run_at, last_error, last_error_at)
        VALUES ($1, NOW(), $2, NOW())
        ON CONFLICT (pull_name) DO UPDATE
          SET last_run_at = NOW(), last_error = EXCLUDED.last_error, last_error_at = NOW()
      `, [name, String(error).slice(0, 2000)]);
    } else {
      await db.query(`
        INSERT INTO odoo_sync_state (pull_name, last_run_at, last_success_at, last_result)
        VALUES ($1, NOW(), NOW(), $2::jsonb)
        ON CONFLICT (pull_name) DO UPDATE
          SET last_run_at = NOW(), last_success_at = NOW(), last_result = EXCLUDED.last_result
      `, [name, JSON.stringify(result || {})]);
    }
  } catch (err) {
    logger.warn({ err, pull: name }, 'odoo sync: could not record run state (is migration 026 applied?)');
  }
}

async function getSyncState() {
  const { rows } = await db.query(
    `SELECT pull_name, last_run_at, last_success_at, last_error, last_error_at, last_result
     FROM odoo_sync_state ORDER BY pull_name`);
  return rows;
}

/* A pull already running (a slow production window, an overlapping cron
   tick) is skipped rather than stacked — two mining pulls re-mirroring the
   same days at once would only fight each other. */
const _inFlight = new Set();

/* opts.only — restrict to these pull names (see LIVE_PULLS). */
async function runOdooSync({ only } = {}) {
  const pulls = only ? PULLS.filter(p => only.includes(p.name)) : PULLS;
  if (!pulls.length) {
    logger.info('odoo sync: no pulls configured yet — skipping');
    return { ran: [], skipped: 'no pulls configured' };
  }

  const ran = [];
  for (const pull of pulls) {
    if (_inFlight.has(pull.name)) {
      ran.push({ name: pull.name, skipped: 'already running' });
      continue;
    }
    _inFlight.add(pull.name);
    try {
      const result = await pull.run();
      ran.push({ name: pull.name, ...result });
      await recordRun(pull.name, { result });
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
      await recordRun(pull.name, { error: err.message });
      await fireAlert(
        'odoo-sync-failed:' + pull.name,
        `Odoo sync pull '${pull.name}' failed: ${err.message}`
      ).catch(() => { /* alerting must never break the sync itself */ });
    } finally {
      _inFlight.delete(pull.name);
    }
  }
  return { ran };
}

module.exports = { runOdooSync, getSyncState, LIVE_PULLS };
