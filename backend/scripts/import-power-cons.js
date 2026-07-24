/*
  scripts/import-power-cons.js — one-time backfill of the power-cons form
  from the plant's real IMS power workbooks (April–June 2026), so the
  dashboard, formula engine and MIS reports can be validated against real
  data instead of synthetic acceptance fixtures.

  Source: "master power report April, May and June/Copy of IMS Report of
  <MONTH> 2026.xlsx" — the "CUMULATIVE DAILY" sheet, which itself is a set
  of formulas pulling from "IMS DATA" (submetered, netted per-circuit
  consumption) which in turn is a daily delta of "READINGS" (raw totalizer
  meter log). We read CUMULATIVE DAILY's cached formula RESULTS (Excel
  already evaluated them) rather than re-deriving the formulas ourselves.

  Row → fact mapping (verified against forms/formula-registry.js FACTS):
    4  Crusher & auxiliaries        -> pwr_crusher_kwh
    5  Raw Mill-1                   -> pwr_rawmill_kwh
    6  Raw Mill-2                   -> pwr_rawmill2_kwh
    7  coal mill                    -> pwr_coalmill_kwh
    8  kiln                         -> pwr_kiln_kwh
    9  cement mill-1                -> pwr_cm1_kwh
    10 cement mill-2                -> pwr_cm2_kwh
    11 packing plant-1              -> pwr_packing_kwh
    12 packing plant-2              -> pwr_packing2_kwh
    13 utilities                    -> pwr_utils_kwh
    14 Colony                       -> pwr_colony_kwh
    24 TANESCO UNIT                 -> pwr_tanesco_kwh
    25 CPP UNIT                     -> pwr_cpp_kwh
    28 TANESCO UNITS FOR CLINKER    -> pwr_tanesco_clinker_kwh
    29 CPP UNIT FOR CLINKER         -> pwr_cpp_clinker_kwh
    30 TANESCO UNITS FOR CEMENT     -> pwr_tanesco_cement_kwh
    32 CPP UNIT FOR CEMENT          -> pwr_cpp_cement_kwh
    33 CPP UNIT FOR COLONY          -> pwr_cpp_colony_kwh
    34 TANESCO UNIT FOR COLONY      -> pwr_tanesco_colony_kwh

  NOT sourced from this workbook (left absent from the submitted payload):
    pwr_lighting_kwh — no independent circuit in this data; lighting
      feeders (LC-1/LC-2/LC-2A/LC-4) are already folded into row 13
      "utilities" upstream in IMS DATA. Splitting it out would be a guess.
    pwr_kiln_prod_mt / pwr_cm1_prod_mt / pwr_cm2_prod_mt — production
      tonnage isn't in a power workbook; these come from the Production
      Report master files (separate import). Until those are seeded too,
      SPC ratio KPIs for these dates will show as "no data" (the registry
      already treats non-positive production as null, by design).

  Data-quality note found in the source: row 1's date header reads
  "2025-<month>-01" etc. (a stale year left over from a copied template —
  C1 = B1+1 propagates it). We use the real 2026 calendar month for each
  file (from its filename) and treat column position as day-of-month,
  ignoring the on-sheet year label.

  Usage: node scripts/import-power-cons.js [--base-url http://localhost:5000/api]
*/
require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');

const BASE = (process.argv.includes('--base-url')
  ? process.argv[process.argv.indexOf('--base-url') + 1]
  : process.env.IMPORT_BASE_URL) || 'http://localhost:5000/api';

const PM_USER = process.env.IMPORT_PM_USER || 'pm';
const PM_PASS = process.env.IMPORT_PM_PASS || 'PM@LCL2026';

const SRC_DIR = path.join(__dirname, '..', '..', 'master power report April, May and June');
const MONTHS = [
  { file: 'Copy of IMS Report of APRIL 2026_.xlsx', year: 2026, month: 4, days: 30 },
  { file: 'Copy of IMS Report of MAY 2026.xlsx',     year: 2026, month: 5, days: 31 },
  { file: 'Copy of IMS Report of JUNE 2026.xlsx',    year: 2026, month: 6, days: 30 },
];

const ROW_FACT = {
  4: 'pwr_crusher_kwh', 5: 'pwr_rawmill_kwh', 6: 'pwr_rawmill2_kwh',
  7: 'pwr_coalmill_kwh', 8: 'pwr_kiln_kwh', 9: 'pwr_cm1_kwh', 10: 'pwr_cm2_kwh',
  11: 'pwr_packing_kwh', 12: 'pwr_packing2_kwh', 13: 'pwr_utils_kwh', 14: 'pwr_colony_kwh',
  24: 'pwr_tanesco_kwh', 25: 'pwr_cpp_kwh',
  28: 'pwr_tanesco_clinker_kwh', 29: 'pwr_cpp_clinker_kwh',
  30: 'pwr_tanesco_cement_kwh', 32: 'pwr_cpp_cement_kwh',
  33: 'pwr_cpp_colony_kwh', 34: 'pwr_tanesco_colony_kwh',
};

function cellNumber(cell) {
  if (!cell) return undefined;
  let v = cell.value;
  if (v && typeof v === 'object') v = 'result' in v ? v.result : undefined;
  return typeof v === 'number' ? v : undefined;
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
  const loginRes = await api('POST', '/auth/login', { body: { username: PM_USER, password: PM_PASS } });
  if (loginRes.status !== 200) {
    console.error('Login failed:', loginRes.status, loginRes.body);
    process.exit(1);
  }
  const token = loginRes.body.token;
  console.log(`Logged in as ${PM_USER} (role ${loginRes.body.user.role})`);

  let submitted = 0, skipped = 0, failed = 0;

  for (const m of MONTHS) {
    const full = path.join(SRC_DIR, m.file);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(full);
    const sheet = wb.getWorksheet('CUMULATIVE DAILY');
    console.log(`\n=== ${m.file} (${m.year}-${String(m.month).padStart(2, '0')}, ${m.days} days) ===`);

    for (let day = 1; day <= m.days; day++) {
      const col = day + 1; // column B = day 1
      const data = {};
      for (const [row, fact] of Object.entries(ROW_FACT)) {
        const n = cellNumber(sheet.getRow(Number(row)).getCell(col));
        if (n !== undefined) data[fact] = Math.round(n * 100) / 100;
      }
      // Guard against a day where every meter reads exactly 0 — almost
      // certainly a not-yet-updated column (month in progress at export
      // time), not a real zero-consumption day. Skip rather than
      // seeding a false "plant stopped" record.
      const nonZero = Object.values(data).some((v) => v && Math.abs(v) > 0.001);
      if (!nonZero) { skipped++; continue; }

      const dateStr = `${m.year}-${String(m.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const r = await api('POST', '/reports/power-cons', { token, body: { date: dateStr, data } });
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
