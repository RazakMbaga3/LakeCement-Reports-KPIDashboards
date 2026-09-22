/*
  scripts/export-seed-migration.js — one-off export of the Apr-Jun 2026
  historical backfill (production, power-cons, cpp, materials, stoppage,
  limestone, quality daily_reports + kpi_monthly) from THIS machine's
  database into a portable JSON dump, so it can be applied to a different
  Postgres instance (the production droplet) that this machine cannot
  reach directly (Postgres 5432 is firewalled to internal-only there).

  Deliberately resolves submitted_by/updated_by/approved_by/rejected_by to
  USERNAMES, not raw ids — local and production `users` rows have
  unrelated id sequences, so the apply script re-resolves each username
  against whatever database it's run against.

  Usage: node scripts/export-seed-migration.js [outfile.json]
           [--forms production,cpp,...] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
           [--kpi-months none|4,5,6] [--kpi-year 2026] [--title "one line"]

  The defaults reproduce the original Apr-Jun 2026 export exactly, so the
  flags only matter for a later backfill: the Jul-Aug 2026 CPP months were
  exported with

    node scripts/export-seed-migration.js _cpp_2026-07-to-08.json       --forms cpp --from 2026-07-01 --to 2026-08-31 --kpi-months none       --title "Jul-Aug 2026 CPP (FRM-LCL-PP-06) historical backfill"
*/
require('../config/env');
const fs = require('fs');
const db = require('../db');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const FORM_TYPES = arg('forms', 'production,power-cons,cpp,materials,stoppage,limestone,quality')
  .split(',').map((s) => s.trim()).filter(Boolean);
const START = arg('from', '2026-04-01');
const END   = arg('to',   '2026-06-30');
const KPI_YEAR = Number(arg('kpi-year', '2026'));
/* `--kpi-months none` exports daily_reports only — a form-specific backfill
   has no monthly-KPI rows to carry, and an empty array keeps the dump's
   shape (and the generator's) unchanged. */
const KPI_MONTHS_ARG = arg('kpi-months', '4,5,6');
const KPI_MONTHS = KPI_MONTHS_ARG === 'none'
  ? []
  : KPI_MONTHS_ARG.split(',').map((s) => Number(s.trim())).filter((n) => n >= 1 && n <= 12);
const TITLE = arg('title', 'Apr-Jun 2026 historical backfill: production, power-cons, cpp, materials, stoppage, limestone, quality daily_reports + kpi_monthly');

async function main() {
  const outfile = process.argv[2] || 'seed-migration-2026-04-to-06.json';

  const reportsRes = await db.query(
    `SELECT dr.form_type, dr.record_date, dr.shift, dr.data, dr.status,
            dr.submitted_at, dr.updated_at, dr.approved_at, dr.rejected_at, dr.rejection_reason,
            u1.username AS submitted_by, u2.username AS updated_by,
            u3.username AS approved_by, u4.username AS rejected_by
     FROM daily_reports dr
     LEFT JOIN users u1 ON u1.id = dr.submitted_by
     LEFT JOIN users u2 ON u2.id = dr.updated_by
     LEFT JOIN users u3 ON u3.id = dr.approved_by
     LEFT JOIN users u4 ON u4.id = dr.rejected_by
     WHERE dr.form_type = ANY($1) AND dr.record_date BETWEEN $2 AND $3
     ORDER BY dr.form_type, dr.record_date`,
    [FORM_TYPES, START, END]
  );

  const kpiRes = await db.query(
    `SELECT k.department, k.year, k.month, k.kpi_key, k.target, k.actual, k.unit, k.updated_at,
            u.username AS updated_by
     FROM kpi_monthly k
     LEFT JOIN users u ON u.id = k.updated_by
     WHERE k.year = $1 AND k.month = ANY($2)
     ORDER BY k.department, k.month, k.kpi_key`,
    [KPI_YEAR, KPI_MONTHS]
  );

  const dump = {
    exported_at: new Date().toISOString(),
    source: 'local dev DB',
    title: TITLE,
    range: { from: START, to: END, form_types: FORM_TYPES },
    daily_reports: reportsRes.rows,
    kpi_monthly: kpiRes.rows,
  };

  fs.writeFileSync(outfile, JSON.stringify(dump, null, 2));
  console.log(`Wrote ${outfile}`);
  console.log(`  daily_reports: ${reportsRes.rows.length} rows`);
  const byType = {};
  for (const r of reportsRes.rows) byType[r.form_type] = (byType[r.form_type] || 0) + 1;
  for (const [t, c] of Object.entries(byType)) console.log(`    ${t.padEnd(12)} ${c}`);
  console.log(`  kpi_monthly:   ${kpiRes.rows.length} rows`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
