/*
  scripts/import-cpp.js — one-time backfill of the `cpp` form (Captive
  Power Plant daily generation report) from the plant's real FRM-LCL-PP-06
  workbooks (April-June 2026), so the CPP dashboard, formula layer and MIS
  reports can show real data instead of "0 rows" placeholders.

  Source: "master raw material reports/CPP Daily & monthly reporty.zip"
  (extracted to "master raw material reports/_cpp_extracted/"), one workbook
  per month: "DAILY,MONTHLY & YEARLY REPORT-<MONTH>-2026.xlsx" (May's is
  named "...EARLY REPORT-MAY-2026.xlsx" — a typo in the plant's own file
  name, not ours). Each workbook has one sheet per day named "1".."N"
  (sheet "0" is the previous month's last day, a spillover template row —
  skipped). The sheet's real calendar date lives in row 6, column E (a
  formula chaining off the previous sheet), used as ground truth rather
  than trusting the sheet name to equal day-of-month.

  Row -> fact mapping (row numbers identical across all 3 workbooks,
  verified directly):
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
  values exactly (see the 2026-07-28 backfill session notes). Submitting them too would
  create a second, driftable copy of the same numbers.

  Usage: node scripts/import-cpp.js [--base-url http://localhost:5000/api]
*/
require('../config/env');
const path = require('path');
const ExcelJS = require('exceljs');

const BASE = (process.argv.includes('--base-url')
  ? process.argv[process.argv.indexOf('--base-url') + 1]
  : process.env.IMPORT_BASE_URL) || 'http://localhost:5000/api';

const CPP_USER = process.env.IMPORT_CPP_USER || 'cpp';
const CPP_PASS = process.env.IMPORT_CPP_PASS || 'CPP@LCL2026';

const SRC_DIR = path.join(__dirname, '..', '..', 'master raw material reports', '_cpp_extracted');
const MONTHS = [
  { file: 'DAILY,MONTHLY & YEARLY REPORT-APR-2026.xlsx',  year: 2026, month: 4, days: 30 },
  { file: 'DAILY,MONTHLY & EARLY REPORT-MAY-2026.xlsx',   year: 2026, month: 5, days: 31 },
  { file: 'DAILY,MONTHLY & YEARLY REPORT-JUNE-2026.xlsx', year: 2026, month: 6, days: 30 },
];

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

  for (const m of MONTHS) {
    const full = path.join(SRC_DIR, m.file);
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

      const nonZero = Object.values(data).some((v) => v && Math.abs(v) > 0.001);
      if (!nonZero) { skipped++; continue; }

      const dateStr = `${m.year}-${String(m.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const r = await api('POST', '/reports/cpp', { token, body: { date: dateStr, data } });
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
