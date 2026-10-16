/*
  scripts/power-to-production-sync.js — reconcile a date range of
  Production Reports against the Power Consumption reports for the same
  days (services/powerToProduction.js). Idempotent: a second run over the
  same range writes nothing.

  What it is for:
    • catching up — after Electrical enters (or imports) July–October, one
      run fills every Production Report that already exists for those days;
    • production rows the Odoo autofill creates AFTER the power report was
      saved (the save-time hook only fires on power-cons/production saves);
    • proving the mapping: over Apr–Jun 2026 it must write nothing, because
      the plant's own figures are already there — every field is either
      'equal' or a logged 'conflict' (the two workbooks disagreeing).

  Usage (from backend/):
    node scripts/power-to-production-sync.js --from 2026-07-01 --to 2026-10-14 [--dry-run] [--json]
    npm run power:to-production -- --from 2026-07-01 --to 2026-10-14 --dry-run

  --dry-run runs the exact same per-day transaction and rolls it back.
*/
require('../config/env');
const db = require('../db');
const { syncRange } = require('../services/powerToProduction');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const ISO = /^\d{4}-\d{2}-\d{2}$/;

async function main() {
  const from   = arg('--from');
  const to     = arg('--to', from);
  const dryRun = process.argv.includes('--dry-run');
  const asJson = process.argv.includes('--json');
  if (!ISO.test(from || '') || !ISO.test(to || '') || from > to) {
    console.error('Usage: node scripts/power-to-production-sync.js --from YYYY-MM-DD [--to YYYY-MM-DD] [--dry-run] [--json]');
    process.exit(2);
  }

  const s = await syncRange(from, to, { dryRun });
  if (asJson) {
    console.log(JSON.stringify(s, null, 2));
  } else {
    console.log(`\nPower Consumption -> Production Report copy, ${from} .. ${to}${dryRun ? '  (DRY RUN — nothing saved)' : ''}`);
    console.log(`  days examined                      ${s.days}`);
    console.log(`  no Production Report (skipped)     ${s.noProductionRow}`);
    console.log(`  no reported Power Consumption      ${s.noReportedPower}`);
    console.log(`  days ${dryRun ? 'that would be ' : ''}written                 ${s.daysWritten}`);
    console.log('  fields:', Object.entries(s.fields).map(([k, v]) => `${k} ${v}`).join(' · '));
    if (s.writes.length) {
      console.log('\n  Writes:');
      s.writes.forEach(w => console.log(`    ${w.date}  set ${JSON.stringify(w.set)}${w.remove.length ? `  removed ${w.remove.join(',')}` : ''}`));
    }
    if (s.conflicts.length) {
      console.log('\n  Conflicts (Production Report kept as entered; Power Consumption figure NOT written):');
      s.conflicts.forEach(c => console.log(`    ${c.date}  ${c.field.padEnd(17)} production ${c.production_value}  power ${c.power_value}  diff ${(c.production_value - c.power_value).toFixed(2)}`));
    }
  }
  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  await db.end().catch(() => {});
  process.exit(1);
});
