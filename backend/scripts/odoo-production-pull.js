/*
  scripts/odoo-production-pull.js — manual production_report pull for an
  explicit date range: the historical backfill, catching up after an outage,
  or checking what Odoo holds before trusting it.

  Usage:
    node scripts/odoo-production-pull.js <from YYYY-MM-DD> <to YYYY-MM-DD> [--dry-run]
    node scripts/odoo-production-pull.js 2024-01-01 2026-09-20      # full backfill
    node scripts/odoo-production-pull.js 2026-09-01 2026-09-20 --dry-run

  --dry-run fetches and validates the range and prints what it WOULD store,
  without touching the database. It needs no migration, so it is the first
  thing to run on a new machine.

  The range is pulled a month at a time (~0.5 s each). Requires
  ODOO_PRODUCTION_URL + ODOO_PRODUCTION_API_KEY — see
  services/odooProductionClient.js.
*/
require('../config/env');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [from, to] = args.filter(a => !a.startsWith('--'));

const ISO = /^\d{4}-\d{2}-\d{2}$/;
if (!from || !to || !ISO.test(from) || !ISO.test(to)) {
  console.error('Usage: node scripts/odoo-production-pull.js <from YYYY-MM-DD> <to YYYY-MM-DD> [--dry-run]');
  process.exit(1);
}
if (from > to) {
  console.error(`Empty range: from (${from}) is after to (${to}).`);
  process.exit(1);
}

async function dry() {
  const { fetchProductionReport } = require('../services/odooProductionClient');
  const { flattenReport, splitRange } = require('../services/odooProductionMapper');
  const totals = { windows: 0, entries: 0, rejected: 0, duplicateRefs: 0, byStage: {}, unmappedPickingTypes: {}, firstDate: null, lastDate: null };
  const rejectSample = [];

  for (const w of splitRange(from, to)) {
    const { rows, rejects, duplicateRefs } = flattenReport(await fetchProductionReport(w.from, w.to));
    totals.windows++;
    totals.entries += rows.length;
    totals.rejected += rejects.length;
    totals.duplicateRefs += duplicateRefs;
    rejectSample.push(...rejects.slice(0, 5 - rejectSample.length));
    for (const r of rows) {
      const key = r.stage || '(unmapped)';
      totals.byStage[key] = (totals.byStage[key] || 0) + 1;
      if (!r.stage) totals.unmappedPickingTypes[r.picking_type] = (totals.unmappedPickingTypes[r.picking_type] || 0) + 1;
      if (!totals.firstDate || r.production_date < totals.firstDate) totals.firstDate = r.production_date;
      if (!totals.lastDate || r.production_date > totals.lastDate) totals.lastDate = r.production_date;
    }
  }
  console.log('PRODUCTION_DRY_RUN ' + JSON.stringify({ from, to, ...totals, rejectSample }, null, 2));
}

async function real() {
  const { pullProductionEntries } = require('../services/odooProductionSync');
  const result = await pullProductionEntries(from, to);
  console.log('PRODUCTION_PULL_RESULT ' + JSON.stringify(result, null, 2));

  if (result.received === 0) {
    console.log(`\nNOTE: Odoo returned no production entries for ${from}..${to}.`);
  }
  if (result.rejected) {
    console.log(`\nNOTE: ${result.rejected} entr${result.rejected === 1 ? 'y was' : 'ies were'} rejected as unusable and not stored — see rejectSample above.`);
  }
  if (Object.keys(result.unmappedPickingTypes).length) {
    console.log(`\nNOTE: stored, but mapped to no report field: ${Object.keys(result.unmappedPickingTypes).join(', ')}. `
      + 'Add the picking type to STAGE_BY_PICKING_TYPE in config/odooProductionMap.js once you know what it is.');
  }
  if (result.sweepsSkipped.length) {
    console.log('\nNOTE: a withdrawal sweep was refused as implausible:\n  ' + result.sweepsSkipped.join('\n  '));
  }
}

/* No process.exit(): pino's exit hook flushes its log worker synchronously and
   can stall for 10 s and throw, which would report a completed pull as failed.
   Closing the pool and letting the event loop drain exits cleanly. */
(async () => {
  try {
    await (dryRun ? dry() : real());
  } catch (err) {
    console.error('PRODUCTION_PULL_FAILED ' + err.message);
    process.exitCode = 1;
  } finally {
    if (!dryRun) await require('../db').end().catch(() => { /* already closed */ });
  }
})();
