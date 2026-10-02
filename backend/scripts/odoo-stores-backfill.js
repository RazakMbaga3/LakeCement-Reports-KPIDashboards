/*
  scripts/odoo-stores-backfill.js — one-off historical backfill for the
  Odoo Stores pipeline (gate entries, GRN lines, material issues).

  WHY THIS EXISTS
  The live sync (odooSync.js, STORES_LOOKBACK_DAYS=7) only ever keeps the
  TRAILING WEEK current — it re-pulls a rolling window so the pending-GRN
  column stays accurate as GRNs land late (0.1-5.1 days, see
  odooStoresSync.js). It was never meant to populate history, so any date
  older than ~7 days before the sync started has zero rows: "Fill from
  Odoo" on the Raw Material form correctly reports "0 cells filled" for
  those dates, because there is genuinely nothing in rm_gate_entries /
  rm_grn_lines / stores_issues for them yet. This script is what fills that
  gap, once.

  WHY IT CHUNKS INTO WEEKS, NOT ONE CALL
  gate_entry_report has no pagination and TIMED OUT at 180s for a one-month
  window in production testing (odooStoresClient.js's header). A week is
  comfortably inside the 15-30s/week range actually measured. Chunking
  further than necessary just adds requests for no benefit, so a week is
  the unit, matching odooStoresSync.pullAllStores's own per-call shape.

  WHAT IT REUSES, DELIBERATELY
  Every chunk goes through services/odooStoresSync.js's pullAllStores() —
  the exact function the live cron calls. Same parsing (comma-joined fields,
  plant-local timestamps), same idempotent upsert keyed on Odoo's own IDs,
  same "never overwrite an 'excel' source row" rule. Running this script
  twice over the same range is safe; it rewrites matching rows with
  identical values and is NOT additive.

  SAFETY
  - Stops (does not throw past) a chunk that fails; records it and keeps
    going, so one bad week does not lose the rest of a multi-month run.
  - --dry-run prints the chunk plan and exits without calling Odoo.
  - Chunks run SEQUENTIALLY, same reasoning as pullAllStores: these are the
    slowest endpoints on the ERP and it also serves the plant's own users.

  USAGE
    node scripts/odoo-stores-backfill.js --from=2026-01-01 --to=2026-09-30
    node scripts/odoo-stores-backfill.js --from=2026-01-01 --to=2026-09-30 --dry-run
    node scripts/odoo-stores-backfill.js --from=2026-01-01 --to=2026-09-30 --resume-log=backfill-state.json

  --resume-log writes progress after every chunk (JSON: completed ranges +
  totals) and, if the file already exists, skips any chunk already marked
  done — so a run interrupted partway (network blip, Odoo outage) can be
  re-invoked with the same flags and pick up where it stopped instead of
  re-pulling weeks that already succeeded.
*/
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pullAllStores } = require('../services/odooStoresSync');
const client = require('../services/odooStoresClient');

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

/* Weekly chunks covering [from, to] inclusive. The last chunk is whatever
   remains (<=7 days), never padded past `to` — padding would ask Odoo for
   future dates that cannot have data, same reasoning odooSync.js's
   lookbackRange already follows for the live pulls. */
function weeklyChunks(from, to) {
  const chunks = [];
  let cursor = from;
  while (cursor <= to) {
    const end = addDays(cursor, 6);
    chunks.push([cursor, end > to ? to : end]);
    cursor = addDays(end > to ? to : end, 1);
  }
  return chunks;
}

function loadLog(logPath) {
  if (!logPath || !fs.existsSync(logPath)) return { done: {} };
  try {
    return JSON.parse(fs.readFileSync(logPath, 'utf8'));
  } catch {
    return { done: {} };
  }
}

function saveLog(logPath, state) {
  if (!logPath) return;
  fs.writeFileSync(logPath, JSON.stringify(state, null, 2));
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.from || !args.to) {
    console.error('Usage: node scripts/odoo-stores-backfill.js --from=YYYY-MM-DD --to=YYYY-MM-DD [--dry-run] [--resume-log=path]');
    process.exit(1);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.from) || !/^\d{4}-\d{2}-\d{2}$/.test(args.to)) {
    console.error('from/to must be ISO YYYY-MM-DD');
    process.exit(1);
  }
  if (args.from > args.to) {
    console.error(`--from (${args.from}) is after --to (${args.to})`);
    process.exit(1);
  }

  if (!client.isConfigured('gate') || !client.isConfigured('grn') || !client.isConfigured('issues')) {
    console.error('Odoo stores endpoints are not configured (ODOO_PRODUCTION_URL/ODOO_PRODUCTION_API_KEY or '
      + 'the per-endpoint overrides) — nothing to backfill from.');
    process.exit(1);
  }

  const chunks = weeklyChunks(args.from, args.to);
  const logPath = args['resume-log'] ? path.resolve(args['resume-log']) : null;
  const state = loadLog(logPath);

  console.log(`Backfill plan: ${args.from} .. ${args.to} → ${chunks.length} week-sized chunk(s)`);
  chunks.forEach(([f, t], i) => {
    const key = `${f}..${t}`;
    const marker = state.done[key] ? ' (already done — will skip)' : '';
    console.log(`  ${String(i + 1).padStart(2)}. ${f} .. ${t}${marker}`);
  });

  if (args['dry-run']) {
    console.log('\n--dry-run: no Odoo calls made.');
    return;
  }

  const totals = { gateWritten: 0, grnWritten: 0, issuesWritten: 0, chunksFailed: [] };

  for (const [f, t] of chunks) {
    const key = `${f}..${t}`;
    if (state.done[key]) {
      console.log(`\nSkipping ${key} (already completed per ${logPath})`);
      continue;
    }

    console.log(`\nPulling ${key} ...`);
    const t0 = Date.now();
    let out;
    try {
      out = await pullAllStores(f, t);
    } catch (err) {
      console.error(`  FAILED entirely: ${err.message}`);
      totals.chunksFailed.push({ range: key, error: err.message });
      continue;
    }
    const ms = ((Date.now() - t0) / 1000).toFixed(1);

    for (const r of out.results) {
      console.log(`  ${r.dataset.padEnd(16)} fetched=${r.fetched} written=${r.written}`
        + (r.pendingGrn !== undefined ? ` pendingGrn=${r.pendingGrn}` : '')
        + (r.skippedExcel ? ` skippedExcel=${r.skippedExcel}` : ''));
      if (r.dataset === 'gate-entries') totals.gateWritten += r.written;
      if (r.dataset === 'grn-register') totals.grnWritten += r.written;
      if (r.dataset === 'material-issues') totals.issuesWritten += r.written;
    }
    if (out.errors.length) {
      console.log(`  partial failure in this chunk: ${JSON.stringify(out.errors)}`);
      totals.chunksFailed.push({ range: key, error: JSON.stringify(out.errors), partial: true });
    } else {
      state.done[key] = { at: new Date().toISOString() };
      saveLog(logPath, state);
    }
    console.log(`  (${ms}s)`);
  }

  console.log('\n── Summary ──────────────────────────────────────');
  console.log(`gate entries written   : ${totals.gateWritten}`);
  console.log(`GRN lines written      : ${totals.grnWritten}`);
  console.log(`material issues written: ${totals.issuesWritten}`);
  if (totals.chunksFailed.length) {
    console.log(`\n${totals.chunksFailed.length} chunk(s) had a problem:`);
    totals.chunksFailed.forEach(c => console.log(`  ${c.range}${c.partial ? ' (partial)' : ''}: ${c.error}`));
    console.log(logPath
      ? `\nRe-run the same command — completed chunks are skipped via ${logPath}.`
      : '\nRe-run with --resume-log=<path> next time to make a retry skip what already succeeded.');
    process.exitCode = 1;
  } else {
    console.log('\nAll chunks completed with no errors.');
  }
}

main().catch(err => {
  console.error('Backfill script crashed:', err);
  process.exit(1);
});
