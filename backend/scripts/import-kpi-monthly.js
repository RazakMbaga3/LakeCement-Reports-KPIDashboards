/*
  SUPERSEDED 2026-09-01 by scripts/import-kpi-monthly-xlsx.js, which reads the
  .xlsx workbooks directly (no Python/openpyxl step, and it also picks up the
  Jan–Mar history in each sheet's "Full year KPI Tracker" columns that this
  one discarded). Kept as the record of the original 2026-07-30 backfill; its
  input JSON lives outside the repo and may no longer exist.
  Use: npm run seed:kpi

  scripts/import-kpi-monthly.js — backfill of department-level Monthly KPI
  targets/actuals/remarks (kpi_monthly table) from the plant's real "M - 11
  LCL Department KPI Report" workbooks (April/May/June 2026), so the
  dashboard's 9 department tabs show real figures for these months instead
  of only the hand-baked Jan/Feb values already in index.html.

  Extraction lives in a one-off Python/openpyxl script
  (master raw material reports/_extracted/extract-kpi-monthly.py) that reads
  the 7 sheets sharing the standard KPI/UNIT/SIGNAGE/TARGET/ACTUAL layout
  (Mechanical, Production, E & I, Power Plant, Mines, Packing Plant, Stores)
  and writes one kpi_monthly_YYYY-MM.json per month. 'Mines Workshop'
  (per-equipment matrix) and 'OT' (overtime cost table) have a different
  shape that doesn't fit kpi_monthly's (department, kpi_key) model and
  aren't wired to it on the frontend either — skipped, not backfilled here.

  kpi_key values are slugged from the Excel KPI label with the exact same
  kpiSlug() the frontend (kpi-data.js) uses to match table rows, so no
  server/API round-trip is needed to validate the mapping — verified
  offline against index.html's current row labels (see conversation).
  Two rows already computed by the formula engine (despatch-day,
  clinker-free-lime) are excluded by the extractor since kpi_monthly would
  be dead data the UI never reads for those.

  Writes directly to Postgres via backend/db (same pool the server uses),
  bypassing the HTTP/auth layer — appropriate for a bulk historical
  backfill where no interactive user session exists to log in as.

  Usage: node scripts/import-kpi-monthly.js
*/
require('../config/env');
const fs   = require('fs');
const path = require('path');
const db   = require('../db');

const DATA_DIR = path.join(__dirname, '..', '..', 'master raw material reports', '_extracted');
const FILES = ['kpi_monthly_2026-04.json', 'kpi_monthly_2026-05.json', 'kpi_monthly_2026-06.json'];

async function main() {
  let upserted = 0, failed = 0;

  for (const fname of FILES) {
    const fpath = path.join(DATA_DIR, fname);
    if (!fs.existsSync(fpath)) {
      console.error(`Missing: ${fpath}`);
      process.exit(1);
    }
    const { year, month, rows } = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
    console.log(`\n${fname}: ${rows.length} rows for ${year}-${String(month).padStart(2, '0')}`);

    for (const r of rows) {
      try {
        await db.query(`
          INSERT INTO kpi_monthly (department, year, month, kpi_key, target, actual, unit, remarks, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
          ON CONFLICT (department, year, month, kpi_key)
          DO UPDATE SET target=EXCLUDED.target, actual=EXCLUDED.actual, unit=EXCLUDED.unit,
                        remarks=EXCLUDED.remarks, updated_at=NOW()
        `, [r.department, year, month, r.kpi_key, r.target, r.actual, r.unit || '', r.remarks || null]);
        upserted++;
      } catch (e) {
        failed++;
        console.error(`  FAILED ${r.department}/${r.kpi_key}: ${e.message}`);
      }
    }
    console.log(`  done: ${rows.length} rows processed`);
  }

  console.log(`\nTotal upserted=${upserted} failed=${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
