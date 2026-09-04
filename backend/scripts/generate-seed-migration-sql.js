/*
  scripts/generate-seed-migration-sql.js — turns the JSON dump from
  export-seed-migration.js into a proper db/migrations/*.sql file, so the
  Apr-Jun 2026 backfill (daily_reports + kpi_monthly) rides the EXISTING
  GitHub auto-deploy pipeline: `git push` -> deploy.sh -> `npm run
  migrate` applies it on the droplet automatically. No SSH needed.

  Safety properties, matching how every other migration in this repo
  behaves:
    - ON CONFLICT DO NOTHING on both tables' real unique constraints, so
      re-running (locally, on a fresh DB, or a second deploy) is a no-op.
    - schema_migrations tracks it by filename — applies exactly once per
      database.
    - submitted_by/updated_by/approved_by/rejected_by are resolved via
      (SELECT id FROM users WHERE username = '...') at insert time, not
      baked-in ids — correct on any database regardless of that
      database's own id sequence, and NULL (not fabricated) if a given
      service/role account doesn't exist there.
    - Whole file runs in one transaction (migrate.js already wraps every
      migration this way) — fully applies or fully rolls back.

  Usage: node scripts/generate-seed-migration-sql.js <dump.json> <outfile.sql>
*/
const fs = require('fs');

function esc(str) {
  return String(str).replace(/'/g, "''");
}
function strLit(v) {
  return v === null || v === undefined ? 'NULL' : `'${esc(v)}'`;
}
function tsLit(iso) {
  if (!iso) return 'NULL';
  // Strip to a naive "YYYY-MM-DD HH:MM:SS.mmm" literal — these ISO strings
  // came from a `timestamp without time zone` column read back through
  // node-pg's default (UTC-labelled) parser, so the digits themselves are
  // the original stored value; casting straight from text avoids any
  // timezone reinterpretation on the way back in.
  return `'${iso.replace('T', ' ').replace('Z', '')}'`;
}
function jsonLit(obj) {
  return `$seedjson$${JSON.stringify(obj)}$seedjson$::jsonb`;
}
function userLit(username) {
  return username === null || username === undefined
    ? 'NULL'
    : `(SELECT id FROM users WHERE username = ${strLit(username)})`;
}
function numLit(v) {
  return v === null || v === undefined ? 'NULL' : `${strLit(v)}::numeric`;
}

function main() {
  const [, , inFile, outFile] = process.argv;
  if (!inFile || !outFile) {
    console.error('Usage: node scripts/generate-seed-migration-sql.js <dump.json> <outfile.sql>');
    process.exit(1);
  }
  const dump = JSON.parse(fs.readFileSync(inFile, 'utf-8'));

  const lines = [];
  lines.push(`-- Apr-Jun 2026 historical backfill: production, power-cons, cpp, materials,`);
  lines.push(`-- stoppage, limestone, quality daily_reports + kpi_monthly.`);
  lines.push(`-- Generated ${new Date().toISOString()} by generate-seed-migration-sql.js from`);
  lines.push(`-- ${inFile.split(/[\\/]/).pop()} (exported ${dump.exported_at} from ${dump.source}).`);
  lines.push(`-- Idempotent: ON CONFLICT DO NOTHING on each table's real unique constraint.`);
  lines.push('');

  lines.push('INSERT INTO daily_reports');
  lines.push('  (form_type, record_date, shift, data, status, submitted_by, submitted_at,');
  lines.push('   updated_by, updated_at, approved_by, approved_at, rejected_by, rejected_at, rejection_reason)');
  lines.push('VALUES');
  const reportRows = dump.daily_reports.map((r) => {
    const cols = [
      strLit(r.form_type), strLit(r.record_date), strLit(r.shift), jsonLit(r.data), strLit(r.status),
      userLit(r.submitted_by), tsLit(r.submitted_at),
      userLit(r.updated_by), tsLit(r.updated_at),
      userLit(r.approved_by), tsLit(r.approved_at),
      userLit(r.rejected_by), tsLit(r.rejected_at), strLit(r.rejection_reason),
    ];
    return `  (${cols.join(', ')})`;
  });
  lines.push(reportRows.join(',\n'));
  lines.push('ON CONFLICT (form_type, record_date, shift) DO NOTHING;');
  lines.push('');

  lines.push('INSERT INTO kpi_monthly');
  lines.push('  (department, year, month, kpi_key, target, actual, unit, updated_by, updated_at)');
  lines.push('VALUES');
  const kpiRows = dump.kpi_monthly.map((k) => {
    const cols = [
      strLit(k.department), k.year, k.month, strLit(k.kpi_key),
      numLit(k.target), numLit(k.actual), strLit(k.unit),
      userLit(k.updated_by), tsLit(k.updated_at),
    ];
    return `  (${cols.join(', ')})`;
  });
  lines.push(kpiRows.join(',\n'));
  lines.push('ON CONFLICT (department, year, month, kpi_key) DO NOTHING;');
  lines.push('');

  fs.writeFileSync(outFile, lines.join('\n'));
  console.log(`Wrote ${outFile}`);
  console.log(`  daily_reports rows: ${dump.daily_reports.length}`);
  console.log(`  kpi_monthly rows:   ${dump.kpi_monthly.length}`);
  const size = fs.statSync(outFile).size;
  console.log(`  file size: ${(size / 1024 / 1024).toFixed(2)} MB`);
}

main();
