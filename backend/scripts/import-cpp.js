/*
  scripts/import-cpp.js — backfill of the `cpp` form (Captive Power Plant
  daily generation report) from the plant's real FRM-LCL-PP-06 workbooks,
  so the CPP dashboard, formula layer and MIS reports can show real data
  instead of "0 rows" placeholders.

  Sources, one workbook per month, all the same FRM-LCL-PP-06 layout:
    Apr-Jun 2026 (the original 2026-07-28 backfill)
      "master raw material reports/CPP Daily & monthly reporty.zip"
      (extracted to "master raw material reports/_cpp_extracted/")
      "DAILY,MONTHLY & YEARLY REPORT-<MONTH>-2026.xlsx" — May's is named
      "...EARLY REPORT-MAY-2026.xlsx" (a typo in the plant's own file name,
      not ours).
    Jul-Aug 2026 (added 2026-09-22, sent by the plant as the two months
      that had never been keyed in anywhere but Excel)
      "data/samples/2026-04-21/DAILY,MONTHLY & EARLY REPORT-JULY-2026.xlsx"
      "data/samples/2026-04-21/DAILY,MONTHLY & EARLY REPORT--AUG 2026.xlsx"
    Sep 2026 (added 2026-09-23, the month still in progress)
      "data/samples/2026-04-21/DAILY,MONTHLY & YEARLY REPORT-SEP-2026.xlsx"

  Each workbook has one sheet per day named "1".."N" (sheet "0" is the
  previous month's last day, a carry-in snapshot of pasted values —
  skipped; its figures belong to the previous workbook, which already
  holds them as a real day). The sheet's real calendar date lives in row 6,
  column E (a formula chaining off the previous sheet), used as ground
  truth rather than trusting the sheet name to equal day-of-month.

  Row -> fact mapping (row numbers verified identical across all five
  workbooks, including the label text of every mapped row):
    7  Gross Power Generation        -> cpp_gross_gen_kwh
    8  Auxiliary power consumption   -> cpp_aux_kwh
    12 Plant Running Hours           -> cpp_run_hrs
    14 Feed Water consumption        -> cpp_feed_water_mt
    15 Boiler Steam Generation       -> cpp_boiler_steam_mt
    16 Bleed steam                  -> cpp_bleed_steam_mt
    17 Turbine steam consumption     -> cpp_turbine_steam_mt
    18 Condensate Generation         -> cpp_condensate_mt
    19 Auxiliary steam consumption   -> cpp_aux_steam_mt
    22 Heat Rate(TG)2880             -> cpp_heat_rate_tg
    23 Heat Rate (Plant) 3300 @ MCR  -> cpp_heat_rate_plant
    24 DG Power Generation           -> cpp_dg_gen_kwh
    26 Coal Consumption              -> cpp_coal_cons
    27 GCV (ADB)                     -> cpp_coal_gcv
    30 DM water Generation           -> cpp_dm_water_gen_m3
    31 DM water Consumption          -> cpp_dm_water_cons_m3
    32 CT Makeup Water Consumption   -> cpp_ct_makeup_m3
    33 col E: Fly ash combustible %  -> cpp_flyash_combustible_pct
       col F: Fly ash GCV            -> cpp_flyash_gcv
    35 Fly ash to cement mill        -> cpp_flyash_to_cm_mt
    36 Fly ash to Coal yard (Truck)  -> cpp_flyash_to_coalyard_nos
    37 Fly ash to Dumpyard (Truck)   -> cpp_flyash_to_dumpyard_nos

  Rows 3, 4, 5, 10, 11, 13, 20, 21 (Net Exported, Aux%, Avg Gen, PLF,
  Specific Steam/Fuel Consumption) are NOT submitted — they are derived
  in the app itself (power-plant-report.html's report-loader/ratio-rollup
  computes — this single page is both the CPP entry form and its report),
  verified against this same source data to reproduce the cached Excel
  values exactly (see the 2026-07-28 backfill session notes, and
  scripts/verify-cpp.py for the Jul-Aug run). Submitting them too would
  create a second, driftable copy of the same numbers.

  Only the daily (column E) figures are imported. The workbook's own Month
  to Date (F) and Year to Date (G) columns are pure cumulative formulas
  over those same daily cells — verified cell by cell, every cumulative row
  of every sheet in all five workbooks — so the app's own MTD/YTD rollup
  (power-plant-report.html's computeRatios, summing the stored days from
  month start / fiscal 1 April) reproduces them rather than storing a
  second copy that could drift.

  Usage: node scripts/import-cpp.js [--months 2026-07,2026-08]
                                    [--base-url http://localhost:5000/api]

  --months defaults to the newest month, September 2026. Every earlier
  month is already in every database (Apr-Jun from migration 015, Jul-Aug
  from 020) and re-posting one would only re-stamp updated_at, so they have
  to be asked for by name: `--months 2026-07,2026-08`, or `--months all`.
  Re-running an earlier month is otherwise safe and would simply add that
  month's heat-rate constants, which the Apr-Aug rows predate.
*/
require('../config/env');
const path = require('path');
const ExcelJS = require('exceljs');

const BASE = (process.argv.includes('--base-url')
  ? process.argv[process.argv.indexOf('--base-url') + 1]
  : process.env.IMPORT_BASE_URL) || 'http://localhost:5000/api';

const CPP_USER = process.env.IMPORT_CPP_USER || 'cpp';
const CPP_PASS = process.env.IMPORT_CPP_PASS || 'CPP@LCL2026';

const REPO_ROOT = path.join(__dirname, '..', '..');
const CPP_2026_Q1_DIR = path.join(REPO_ROOT, 'master raw material reports', '_cpp_extracted');
const SAMPLES_DIR     = path.join(REPO_ROOT, 'data', 'samples', '2026-04-21');

const MONTHS = [
  { key: '2026-04', dir: CPP_2026_Q1_DIR, file: 'DAILY,MONTHLY & YEARLY REPORT-APR-2026.xlsx',  year: 2026, month: 4, days: 30 },
  { key: '2026-05', dir: CPP_2026_Q1_DIR, file: 'DAILY,MONTHLY & EARLY REPORT-MAY-2026.xlsx',   year: 2026, month: 5, days: 31 },
  { key: '2026-06', dir: CPP_2026_Q1_DIR, file: 'DAILY,MONTHLY & YEARLY REPORT-JUNE-2026.xlsx', year: 2026, month: 6, days: 30 },
  { key: '2026-07', dir: SAMPLES_DIR,     file: 'DAILY,MONTHLY & EARLY REPORT-JULY-2026.xlsx',  year: 2026, month: 7, days: 31 },
  { key: '2026-08', dir: SAMPLES_DIR,     file: 'DAILY,MONTHLY & EARLY REPORT--AUG 2026.xlsx',  year: 2026, month: 8, days: 31 },
  { key: '2026-09', dir: SAMPLES_DIR,     file: 'DAILY,MONTHLY & YEARLY REPORT-SEP-2026.xlsx',  year: 2026, month: 9, days: 30 },
];

/* Which months this run writes. Default = the two that were sent as plain
   Excel and exist nowhere else; see the --months note in the header. */
const monthsArg = process.argv.includes('--months')
  ? process.argv[process.argv.indexOf('--months') + 1]
  : '2026-09';
const wanted = monthsArg === 'all' ? MONTHS.map(m => m.key) : monthsArg.split(',').map(s => s.trim());
const unknown = wanted.filter(k => !MONTHS.some(m => m.key === k));
if (unknown.length) {
  console.error(`Unknown --months value(s): ${unknown.join(', ')}. Known: ${MONTHS.map(m => m.key).join(', ')}`);
  process.exit(2);
}
const SELECTED = MONTHS.filter(m => wanted.includes(m.key));

const ROW_FACT = {
  7:  'cpp_gross_gen_kwh',
  8:  'cpp_aux_kwh',
  12: 'cpp_run_hrs',
  14: 'cpp_feed_water_mt',
  15: 'cpp_boiler_steam_mt',
  16: 'cpp_bleed_steam_mt',
  17: 'cpp_turbine_steam_mt',
  18: 'cpp_condensate_mt',
  19: 'cpp_aux_steam_mt',
  22: 'cpp_heat_rate_tg',
  23: 'cpp_heat_rate_plant',
  24: 'cpp_dg_gen_kwh',
  26: 'cpp_coal_cons',
  27: 'cpp_coal_gcv',
  30: 'cpp_dm_water_gen_m3',
  31: 'cpp_dm_water_cons_m3',
  32: 'cpp_ct_makeup_m3',
  35: 'cpp_flyash_to_cm_mt',
  36: 'cpp_flyash_to_coalyard_nos',
  37: 'cpp_flyash_to_dumpyard_nos',
};

/* The four lab/DCS constants FRM-LCL-PP-06 hardcodes inside its own
   heat-rate formulas, pulled back out of the formula text per sheet per
   column. Row 22 (Heat Rate TG) carries the three enthalpies:

     =((E17*(803-130)+E31*(30))*1000)/E7      ->  sh 803, fw 130, dm 30

   and row 23 (Heat Rate Plant) carries the boiler efficiency:

     =(E15*(803-130))*1000/(E7*0.78)          ->  eff 0.78

   Column E is the day, F the month to date, G the year to date, and the
   workbook genuinely varies them per column — 20 Sep 2026 runs its whole
   sheet at 0.77 while 19 and 21 Sep run at 0.78. Storing them (since
   2026-09-23) as the twelve cpp_*_enthalpy / cpp_boiler_efficiency[_mtd|
   _ytd] fields is what lets power-plant-report.html reproduce that sheet's
   MTD and YTD heat rates exactly instead of falling back to a
   generation-weighted mean of the daily readings, which cannot express a
   period whose efficiency moved. Returns null for a column whose formulas
   don't parse, and the day is then stored without that column's constants
   — the page's fallback still covers it. */
const COL_SUFFIX = { 5: '', 6: '_mtd', 7: '_ytd' };

/* Excel stores most of the Year-to-Date column as a SHARED formula whose
   master is the Month-to-Date cell beside it ({ sharedFormula: 'F22' }
   rather than any text), and exceljs hands that back unexpanded. The
   constants are literals, identical for every member of a shared group —
   only the cell references translate — so following the reference to the
   master and reading its formula gives the right numbers. Without this,
   every YTD column in the September workbook parsed as "no constants". */
function formulaText(ws, row, col, depth) {
  const cell = ws.getRow(row).getCell(col);
  const v = cell ? cell.value : null;
  if (typeof v === 'string' && v.startsWith('=')) return v;
  if (!v || typeof v !== 'object') return null;
  if (typeof v.formula === 'string') return v.formula;
  if (typeof v.sharedFormula === 'string' && (depth || 0) < 3) {
    const master = ws.getCell(v.sharedFormula);
    if (master && master.row && master.col) return formulaText(ws, master.row, master.col, (depth || 0) + 1);
  }
  return null;
}

function columnConstants(ws, col) {
  const tg = formulaText(ws, 22, col);
  const plant = formulaText(ws, 23, col);
  if (!tg || !plant) return null;
  const ent = tg.match(/\((\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\)/);
  const dm  = tg.match(/\*\s*\((\d+(?:\.\d+)?)\)\s*\)/);
  const eff = plant.match(/\*\s*(\d*\.\d+)\s*\)\s*$/);
  if (!ent || !dm || !eff) return null;
  return {
    cpp_superheated_steam_enthalpy: Number(ent[1]),
    cpp_feedwater_enthalpy:         Number(ent[2]),
    cpp_dm_water_enthalpy:          Number(dm[1]),
    cpp_boiler_efficiency:          Number(eff[1]),
  };
}

function cellNumber(cell) {
  if (!cell) return undefined;
  let v = cell.value;
  if (v && typeof v === 'object') v = 'result' in v ? v.result : undefined;
  return typeof v === 'number' ? v : undefined;
}

function sheetDate(ws) {
  const cell = ws.getRow(6).getCell(5);
  let v = cell.value;
  if (v && typeof v === 'object' && 'result' in v) v = v.result;
  if (v instanceof Date) return v;
  return null;
}

async function api(method, pathname, { token, body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

async function main() {
  const loginRes = await api('POST', '/auth/login', { body: { username: CPP_USER, password: CPP_PASS } });
  if (loginRes.status !== 200) {
    console.error('Login failed:', loginRes.status, loginRes.body);
    process.exit(1);
  }
  const token = loginRes.body.token;
  console.log(`Logged in as ${CPP_USER} (role ${loginRes.body.user.role})`);

  let submitted = 0, skipped = 0, failed = 0;

  for (const m of SELECTED) {
    const full = path.join(m.dir, m.file);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(full);
    console.log(`\n=== ${m.file} (${m.year}-${String(m.month).padStart(2, '0')}, ${m.days} days) ===`);

    for (let day = 1; day <= m.days; day++) {
      const ws = wb.getWorksheet(String(day));
      if (!ws) { console.error(`  ⚠ sheet "${day}" missing`); failed++; continue; }

      const sheetDt = sheetDate(ws);
      const expected = new Date(Date.UTC(m.year, m.month - 1, day));
      if (!sheetDt || sheetDt.getUTCFullYear() !== expected.getUTCFullYear() ||
          sheetDt.getUTCMonth() !== expected.getUTCMonth() || sheetDt.getUTCDate() !== expected.getUTCDate()) {
        console.error(`  ⚠ sheet "${day}" date mismatch: sheet says ${sheetDt}, expected day ${day} of ${m.month}/${m.year}`);
      }

      const data = {};
      for (const [row, fact] of Object.entries(ROW_FACT)) {
        const n = cellNumber(ws.getRow(Number(row)).getCell(5));
        if (n !== undefined) data[fact] = Math.round(n * 100) / 100;
      }
      // Row 33 is a special two-value row: col E = fly ash combustible %,
      // col F = fly ash GCV (NOT a "Month to Date" column on this row).
      const flyCombustible = cellNumber(ws.getRow(33).getCell(5));
      const flyGcv = cellNumber(ws.getRow(33).getCell(6));
      if (flyCombustible !== undefined) data.cpp_flyash_combustible_pct = Math.round(flyCombustible * 100) / 100;
      if (flyGcv !== undefined) data.cpp_flyash_gcv = Math.round(flyGcv * 100) / 100;

      /* Constants per column, named for the Day / MTD / YTD inputs on
         power-plant-report.html. Read before the all-zero test below so an
         unfilled sheet — whose heat-rate cells read #DIV/0! — is still
         skipped whole rather than stored as constants with no readings. */
      for (const [col, suffix] of Object.entries(COL_SUFFIX)) {
        const k = columnConstants(ws, Number(col));
        if (!k) { console.error(`  ⚠ ${m.key} day ${day}: could not read the column ${col} constants`); continue; }
        for (const [field, value] of Object.entries(k)) data[field + suffix] = value;
      }

      const FACT_KEYS = Object.values(ROW_FACT).concat(['cpp_flyash_combustible_pct', 'cpp_flyash_gcv']);
      const nonZero = FACT_KEYS.some((f) => data[f] && Math.abs(data[f]) > 0.001);
      if (!nonZero) { skipped++; continue; }

      const dateStr = `${m.year}-${String(m.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const r = await api('POST', '/reports/cpp', { token, body: { date: dateStr, data, replace: true } });
      if (r.status >= 300) {
        failed++;
        console.error(`  ❌ ${dateStr}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
      } else {
        submitted++;
        process.stdout.write(`  ✅ ${dateStr}\r`);
      }
    }
    console.log('');
  }

  console.log(`\nDone. submitted=${submitted} skipped(all-zero)=${skipped} failed=${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
