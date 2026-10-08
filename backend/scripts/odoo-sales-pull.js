/*
  scripts/odoo-sales-pull.js — pull the Odoo Sale Register feed into
  Postgres for a date range, one day at a time.

    npm run odoo:sales-pull -- 2026-09-01 2026-09-30
    npm run odoo:sales-pull -- 2026-09-30            (single day)

  The live sync (odooSync.js 'sales-register') keeps today, yesterday and a
  rotating window of the last SALES_REFRESH_DAYS current. It never fills
  older history; this does, once.

  It goes through services/odooSalesSync.js's pullSalesRange() — the same
  per-day function the live pull calls, so a backfilled day is
  indistinguishable from a synced one, and re-running a range is safe (each
  day is replaced as a unit).

  Cost: ~25-60 s per day on the production ERP (≈9 min per month). Days run
  sequentially. Run long backfills outside working hours — the same ERP
  serves the plant's own Odoo users.
*/
require('../config/env');
const db = require('../db');
const { pullSalesRange } = require('../services/odooSalesSync');

const ISO = /^\d{4}-\d{2}-\d{2}$/;

async function main() {
  const [from, to = from] = process.argv.slice(2);
  if (!ISO.test(from || '') || !ISO.test(to) || to < from) {
    console.error('usage: npm run odoo:sales-pull -- YYYY-MM-DD [YYYY-MM-DD]');
    process.exit(2);
  }
  const t0 = Date.now();
  let mt = 0;
  const res = await pullSalesRange(from, to, {
    onDay: r => {
      if (r.error) { console.log(`${r.date}  ERROR  ${r.error}`); return; }
      mt += r.cementMt;
      console.log(`${r.date}  invoices ${String(r.stored).padStart(4)}  cement ${r.cementMt.toFixed(2).padStart(10)} MT`
        + `  pruned ${r.pruned}${r.pruneSkipped ? ' (prune skipped: empty answer)' : ''}`
        + `${r.rejected ? `  REJECTED ${r.rejected}` : ''}${r.unknownUom ? `  unknown-UoM ${r.unknownUom}` : ''}`
        + `  ${r.secs}s`);
    },
  });
  console.log(`\n${res.days} day(s), ${res.results.length} ok, ${res.errors.length} failed — `
    + `${mt.toFixed(2)} MT cement — ${Math.round((Date.now() - t0) / 1000)}s`);
  await db.end();
  process.exit(res.errors.length ? 1 : 0);
}

main().catch(async err => {
  console.error(err.message);
  await db.end().catch(() => {});
  process.exit(1);
});
