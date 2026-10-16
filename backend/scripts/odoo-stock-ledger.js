/*
  scripts/odoo-stock-ledger.js — run the Production Report stock ledger
  (services/odooStockLedger.js) by hand: backfill, re-check, or preview.

    npm run odoo:stock-ledger                       full rebuild from the 30-Jun anchor, writes
    npm run odoo:stock-ledger -- --dry-run          compute + compare with Odoo, write nothing
    npm run odoo:stock-ledger -- --incremental      the live job's 14-day window
    npm run odoo:stock-ledger -- --to 2026-09-30    stop at a day (never later than today)
    npm run odoo:stock-ledger -- --at 2026-08-30,2026-09-30   closings to print

  Prints the closing per ledger at each month end (and any --at day), the
  latest published closing with the reason for whatever is blank after it,
  and the comparison with Odoo's live on-hand rolled back to that same day.
  Needs the Odoo database login (ODOO_PG_*); without it the run is skipped.
*/

require('../config/env');
const { pullStockLedger } = require('../services/odooStockLedger');
const { LEDGERS } = require('../config/odooStockLedger');
const odooDb = require('../services/odooDb');
const db = require('../db');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function monthEnds(from, to) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCMonth(d.getUTCMonth() + 1, 1)) {
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    if (end <= to) out.push(end);
  }
  return out;
}

const fmt = v => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }));

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  const mode = process.argv.includes('--incremental') ? 'incremental' : 'full';
  const res = await pullStockLedger({ mode, to: arg('--to'), dryRun, detail: true });
  if (res.skipped) { console.log('skipped:', res.skipped); return; }

  console.log(`mode ${res.mode}  ${res.from} .. ${res.to}  (${res.days} days)`);
  console.log(`rows created ${res.rowsCreated}, updated ${res.rowsUpdated}; fields written ${res.fieldsWritten}, removed ${res.fieldsRemoved}; ` +
    `human values kept ${res.humanValuesKept}; consumption read from Odoo (row lacked it) ${res.consumptionFallbacks}`);
  if (Object.keys(res.unknownCoalVendors).length) console.log('coal from suppliers not yet confirmed Kiln/CPP (put on Kiln row):', res.unknownCoalVendors);

  const at = (arg('--at') || '').split(',').filter(Boolean);
  const points = [...new Set([...monthEnds(res.from, res.to), ...at])].sort();
  console.log('\nClosing stock (MT) — "—" = not published (reason below)');
  console.log('ledger'.padEnd(26), ...points.map(p => p.slice(5).padStart(11)), '  last published');
  for (const l of LEDGERS) {
    const list = res.detail[l.key];
    const byDate = Object.fromEntries(list.map(r => [r.date, r]));
    const s = res.ledgers[l.key];
    const cell = p => {
      const r = byDate[p];
      if (!r) return '';
      return l.publish ? fmt(r.closing) : `(${fmt(r.balance)})`;
    };
    console.log((l.label + (l.publish ? '' : ' [held]')).padEnd(26), ...points.map(p => cell(p).padStart(11)),
      `  ${s.lastClosingDate || '—'} ${fmt(s.lastClosing)}`);
  }

  console.log('\nWhy the latest day is blank, per ledger:');
  for (const l of LEDGERS) {
    const s = res.ledgers[l.key];
    console.log(`  ${l.label}: ${s.latestStatus}${s.latestReason ? ' — ' + s.latestReason : ''}`);
    if (s.negativeDays.length) console.log(`      negative (left blank) on: ${s.negativeDays.join(', ')}`);
  }

  console.log('\nThe plant\'s 30-Jun book + every flow Odoo has approved so far, vs Odoo\'s live on-hand');
  console.log('ledger'.padEnd(26), 'scope'.padEnd(9), 'roll'.padStart(11), 'Odoo live'.padStart(11), 'diff'.padStart(10), '   report vs Odoo figures');
  for (const c of res.comparison) {
    console.log(c.label.padEnd(26), String(c.scope || '').padEnd(9), fmt(c.odooRoll).padStart(11), fmt(c.odooLive).padStart(11),
      fmt(c.diff).padStart(10), `   ${fmt(c.ledgerVsOdoo)}${c.matches === false ? '   <-- differs' : ''}`);
  }
})()
  .catch(err => { console.error('FAILED:', err.stack || err.message); process.exitCode = 1; })
  .finally(async () => { await odooDb.close().catch(() => {}); await db.end?.().catch?.(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 50); });
