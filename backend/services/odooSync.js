/*
  services/odooSync.js — scheduled pull from Odoo into lcl_mis (skeleton).

  No real pulls are wired up yet — the exact model/fields for either
  confirmed target haven't been confirmed with the Odoo team. Use
  `npm run odoo:test -- <model>` to discover a model's fields once
  ODOO_URL/ODOO_DB/ODOO_USERNAME/ODOO_API_KEY are set in .env — see
  docs/TECHNICAL_SPEC.md §11.

  Confirmed targets so far:
    1. "Production Entry Raw Meal" — moisture-adjusted (wet→dry) raw
       material consumption for limestone/clay/iron ore/sand.
    2. Dispatch daily summary — REGULAR/BULKER/BIG BAG totals per cement
       grade (the same shape forms/formula-registry.js's dispatch_reg_,
       dispatch_blk_, dispatch_bag_, and dispatch_clinker facts already
       use), one row per day. Explicitly scoped to the daily aggregate ONLY —
       not individual sale orders, invoices, or truck-level dispatch
       records. If Odoo can't hand back an already-aggregated daily view,
       the pull still only stores the aggregated total per grade/channel/
       day, never the underlying order lines.

  Once a dataset is confirmed:
    1. add a dedicated typed table for it (mirror weighbridge_tickets —
       schema.sql + a db/migrations/*.sql — keyed on Odoo's own record id,
       NOT the JSONB daily_reports blob),
    2. write a pull-and-upsert function and add it to PULLS below (see
       routes/quarry.js's import handler for the upsert shape to follow),
    3. flip that fact's `source` in forms/formula-registry.js from
       'manual' to 'odoo', pointing it at the new table.

  Scheduled in server.js on ODOO_SYNC_CRON whenever ODOO_URL is set (default
  05:00 daily, off if ODOO_SYNC_CRON=off). Manual run: `npm run odoo:sync`.
*/

const logger = require('./logger');
const odoo   = require('./odooClient');

/* One entry per confirmed dataset: { name, run }. run() pulls + upserts and
   returns a small summary object (added/updated counts, date range, …). */
const PULLS = [
  // { name: 'raw-meal-consumption', run: pullRawMealConsumption },
  // { name: 'dispatch-daily-summary', run: pullDispatchDailySummary },
  //   Aggregate only — see "Dispatch daily summary" above. Do not extend
  //   this to pull per-order/per-invoice rows even if it's easier than
  //   asking Odoo for a pre-aggregated view.
];

async function runOdooSync() {
  if (!PULLS.length) {
    logger.info('odoo sync: no pulls configured yet — skipping');
    return { ran: [], skipped: 'no pulls configured' };
  }

  await odoo.authenticate(); // fail fast with one clear error if creds are bad

  const ran = [];
  for (const pull of PULLS) {
    try {
      ran.push({ name: pull.name, ...(await pull.run()) });
    } catch (err) {
      logger.error({ err, pull: pull.name }, 'odoo sync pull failed');
      ran.push({ name: pull.name, error: err.message });
    }
  }
  return { ran };
}

module.exports = { runOdooSync };
