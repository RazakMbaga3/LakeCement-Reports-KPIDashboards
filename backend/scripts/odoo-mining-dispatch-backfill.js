/*
  scripts/odoo-mining-dispatch-backfill.js — one command to catch a fresh
  environment (the production droplet, most likely) up on mining_report +
  dispatch_report after they moved to the production ERP 2026-09-23.

  odooSync.js's cron only re-pulls a short trailing window (5 days), so a
  server that has never pulled from the new host — or was still pointed at
  the old test host until now — needs an explicit month-by-month backfill.
  This is exactly what was run by hand against the dev DB on 2026-09-23
  (see RAID_LOG.md R-1); this script exists so the SAME catch-up on the
  droplet doesn't have to be typed out as 14 separate npm run commands.

  Both endpoints truncate large date ranges with no pagination (see
  odooMiningClient.js / odooDispatchClient.js), so this always pulls
  calendar-month chunks, never the whole span in one request — same
  approach scripts/odoo-mining-pull.js's header already documents.

  Usage:
    node scripts/odoo-mining-dispatch-backfill.js [from YYYY-MM-DD] [to YYYY-MM-DD]

    node scripts/odoo-mining-dispatch-backfill.js
      → defaults to 2026-03-01..today, matching the range already applied
        to the dev DB (2026-03-01 is when the OLD test-host snapshot's
        mirrored data started, so this also fully replaces it).

    node scripts/odoo-mining-dispatch-backfill.js 2026-01-01 2026-02-28
      → an earlier span, if the plant wants mining/dispatch history to
        reach back further than the rest of the app's Apr-2026 data floor.

  Mining tickets that fall on a date already holding a manual Excel
  upload are skipped by default, same as odoo-mining-pull.js — pass
  --overwrite-excel to replace them (rare; confirm with Mining first).

  Requires ODOO_MINING_URL/ODOO_MINING_API_KEY (or the ODOO_DISPATCH_*
  pair they fall back to) and ODOO_DISPATCH_URL/ODOO_DISPATCH_API_KEY —
  see services/odooMiningClient.js and services/odooDispatchClient.js.
*/
require('../config/env');
const { pullMiningTickets }        = require('../services/odooMiningSync');
const { pullDispatchDailySummary } = require('../services/odooDispatchSync');

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const args = process.argv.slice(2);
const overwriteExcelDates = args.includes('--overwrite-excel');
const positional = args.filter(a => !a.startsWith('--'));

function isoDate(d) { return d.toISOString().slice(0, 10); }

const DEFAULT_FROM = '2026-03-01';
const from = positional[0] || DEFAULT_FROM;
const to   = positional[1] || isoDate(new Date());

if (!ISO.test(from) || !ISO.test(to)) {
  console.error('Usage: node scripts/odoo-mining-dispatch-backfill.js [from YYYY-MM-DD] [to YYYY-MM-DD] [--overwrite-excel]');
  process.exit(1);
}
if (from > to) {
  console.error(`Empty range: from (${from}) is after to (${to}).`);
  process.exit(1);
}

/* [from, to] split into whole calendar-month chunks, first/last clipped to
   the requested bounds — e.g. 2026-03-15..2026-05-10 yields
   [2026-03-15..03-31, 2026-04-01..04-30, 2026-05-01..05-10]. */
function monthChunks(fromISO, toISO) {
  const chunks = [];
  let cursor = new Date(fromISO + 'T00:00:00Z');
  const end  = new Date(toISO + 'T00:00:00Z');

  while (cursor <= end) {
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const chunkEnd = monthEnd < end ? monthEnd : end;
    chunks.push({ from: isoDate(cursor), to: isoDate(chunkEnd) });
    cursor = new Date(Date.UTC(chunkEnd.getUTCFullYear(), chunkEnd.getUTCMonth(), chunkEnd.getUTCDate() + 1));
  }
  return chunks;
}

(async () => {
  const chunks = monthChunks(from, to);
  console.log(`Backfilling mining + dispatch from Odoo production, ${from}..${to} (${chunks.length} month chunk(s))\n`);

  const mining = { rowsReceived: 0, added: 0, updated: 0, removedStale: 0, datesSkippedExcel: [], rowsUnknownProduct: 0 };
  const dispatch = { rowsReceived: 0, daysUpdated: 0, rowsUnmapped: 0 };
  let failed = false;

  for (const { from: cFrom, to: cTo } of chunks) {
    process.stdout.write(`mining   ${cFrom}..${cTo} … `);
    try {
      const r = await pullMiningTickets(cFrom, cTo, { overwriteExcelDates });
      mining.rowsReceived += r.rowsReceived;
      mining.added += r.added;
      mining.updated += r.updated;
      mining.removedStale += r.removedStale;
      mining.rowsUnknownProduct += r.rowsUnknownProduct;
      mining.datesSkippedExcel.push(...r.datesSkippedExcel);
      console.log(`${r.rowsReceived} rows, +${r.added} ~${r.updated} -${r.removedStale}` +
        (r.datesSkippedExcel.length ? `, ${r.datesSkippedExcel.length} date(s) skipped (Excel)` : ''));
    } catch (err) {
      failed = true;
      console.log(`FAILED — ${err.message}`);
    }
  }

  for (const { from: cFrom, to: cTo } of chunks) {
    process.stdout.write(`dispatch ${cFrom}..${cTo} … `);
    try {
      const r = await pullDispatchDailySummary(cFrom, cTo);
      dispatch.rowsReceived += r.rowsReceived;
      dispatch.daysUpdated += r.daysUpdated;
      dispatch.rowsUnmapped += r.rowsUnmapped;
      console.log(`${r.rowsReceived} rows, ${r.daysUpdated} day(s) updated` +
        (r.rowsUnmapped ? `, ${r.rowsUnmapped} row(s) unmapped (see log)` : ''));
    } catch (err) {
      failed = true;
      console.log(`FAILED — ${err.message}`);
    }
  }

  console.log('\nBACKFILL_RESULT ' + JSON.stringify({ from, to, mining, dispatch }, null, 2));
  if (mining.rowsUnknownProduct) {
    console.log(`\nNOTE: ${mining.rowsUnknownProduct} mining ticket(s) used a product code with no grade `
      + 'mapping — stored, but excluded from Quarry totals. See odooMiningSync.js PRODUCT_LABEL.');
  }
  if (dispatch.rowsUnmapped) {
    console.log(`\nNOTE: ${dispatch.rowsUnmapped} dispatch row(s) were unmapped (expected: "CEMENT B-M `
      + '42.5 N" / Duramax 42 has no Dispatch-report field yet — see odooDispatchSync.js header).');
  }
  process.exit(failed ? 1 : 0);
})();
