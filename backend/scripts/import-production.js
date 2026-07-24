/*
  scripts/import-production.js — one-time backfill of the production form
  (daily-report.html) from the plant's real Master Production Report
  workbook for June 2026, so the Daily Production Report's date navigation
  shows real per-day values instead of the static demo replica.

  Source: "Master production report JUNE 26'.xlsx" — a set of per-day-row
  master sheets (Production2, Clinker, Cement) where row 3 = June 1, row 4
  = June 2, ... row 32 = June 30 (June has 30 days; row 33 is an unused
  "day 31" placeholder, all zero — skipped). We read the cached formula
  RESULTS (Excel already evaluated them) rather than re-deriving formulas.

  Cell → fact mapping (verified against forms/formula-registry.js FACTS
  and cross-checked cell-by-cell with openpyxl before writing this):
    Production2!Y   Kiln Rng Hrs                    -> kiln_run_hrs
    Clinker!EJ      Own clinker — Opening Stock      -> kiln_clinker_open
    Clinker!EK      Own clinker — Production         -> kiln_prod_mt
    Clinker!EL      Own clinker — Consumption        -> cm_clinker_own_cons
    Clinker!EO      Purchased clinker — Opening      -> cm_clinker_purch_open
    Clinker!EP      Purchased clinker — Received     -> cm_clinker_purch_recv
    Clinker!EQ      Purchased clinker — Consumption  -> cm_clinker_purch_cons
    Clinker!ED      Kiln coal — Consumption          -> coal_kiln
    Clinker!EH      CPP coal — Consumption           -> coal_cpp
    Cement!C        Gypsum — Opening Stock           -> cm_gypsum_open
    Cement!D        Gypsum — Received                -> cm_gypsum_recv
    Cement!F        Gypsum — Consumption (wet basis, the figure that
                     actually drives the sheet's own closing-stock calc)
                                                      -> cm_gypsum_cons
    Cement!H + L    Starex + Mapei — Opening          -> cm_grind_aid_open
    Cement!I + M    Starex + Mapei — Received         -> cm_grind_aid_recv
    Cement!J + N    Starex + Mapei — Consumption      -> cm_grind_aid_cons
    Production2!AC  CM1 42.5R  production             -> cm1_425r_mt
    Production2!AF  CM1 32.5N  production             -> cm1_325n_mt
    Production2!AI  CM1 42.5N  production             -> cm1_425n_mt
    Production2!AL  CM1 OPC    production             -> cm1_opc_mt
    Production2!AR  CM2 42.5R  production             -> cm2_425r_mt
    Production2!AU  CM2 32.5N  production             -> cm2_325n_mt
    Production2!AX  CM2 42.5N  production             -> cm2_425n_mt
    Production2!BD  CM2 42.5N B-M production           -> cm2_425n_bm_mt

  NOT sourced from this workbook (left absent from the submitted payload):
    cm_flyash_open/cons/recv — no fly-ash material tracked anywhere in
      this workbook (Cement sheet only has Gypsum + Starex + Mapei);
      this plant evidently doesn't use fly ash, or it isn't logged here.
    CM1 doesn't get a 42.5N-BM fact (the app only tracks that grade for
      CM2 — Production2!AO, CM1's 42.5N-BM production, has no home field)
      and CM2 doesn't get an OPC fact (Production2!BA, same situation) —
      both are pre-existing simplifications in the app's field set, not
      something this import can fix without a form change.

  Usage: node scripts/import-production.js [--base-url http://localhost:5000/api]
*/
require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');

const BASE = (process.argv.includes('--base-url')
  ? process.argv[process.argv.indexOf('--base-url') + 1]
  : process.env.IMPORT_BASE_URL) || 'http://localhost:5000/api';

const PROD_USER = process.env.IMPORT_PROD_USER || 'production';
const PROD_PASS = process.env.IMPORT_PROD_PASS || 'Prod@LCL2026';

const SRC_FILE = path.join(__dirname, '..', '..', "Master production report JUNE 26'.xlsx");
const YEAR = 2026, MONTH = 6, DAYS = 30; // June 2026

function cellNumber(cell) {
  if (!cell) return undefined;
  let v = cell.value;
  if (v && typeof v === 'object') v = 'result' in v ? v.result : undefined;
  return typeof v === 'number' ? v : undefined;
}

function round2(n) {
  return Math.round(n * 100) / 100;
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
  const loginRes = await api('POST', '/auth/login', { body: { username: PROD_USER, password: PROD_PASS } });
  if (loginRes.status !== 200) {
    console.error('Login failed:', loginRes.status, loginRes.body);
    process.exit(1);
  }
  const token = loginRes.body.token;
  console.log(`Logged in as ${PROD_USER} (role ${loginRes.body.user.role})`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SRC_FILE);
  const production2 = wb.getWorksheet('Production2');
  const clinker      = wb.getWorksheet('Clinker');
  const cement        = wb.getWorksheet('Cement');
  if (!production2 || !clinker || !cement) {
    console.error('Could not find one of the required sheets (Production2 / Clinker / Cement).');
    process.exit(1);
  }

  let submitted = 0, skipped = 0, failed = 0;

  console.log(`\n=== Master production report JUNE 26'.xlsx (${YEAR}-${String(MONTH).padStart(2, '0')}, ${DAYS} days) ===`);

  for (let day = 1; day <= DAYS; day++) {
    const row = day + 2; // row 3 = day 1
    const p2Row = production2.getRow(row);
    const clRow = clinker.getRow(row);
    const ceRow = cement.getRow(row);

    const data = {};
    const set = (fact, cell) => { const n = cellNumber(cell); if (n !== undefined) data[fact] = round2(n); };
    const setSum = (fact, cellA, cellB) => {
      const a = cellNumber(cellA), b = cellNumber(cellB);
      if (a !== undefined || b !== undefined) data[fact] = round2((a || 0) + (b || 0));
    };

    set('kiln_run_hrs',          p2Row.getCell('Y'));
    set('kiln_clinker_open',     clRow.getCell('EJ'));
    set('kiln_prod_mt',          clRow.getCell('EK'));
    set('cm_clinker_own_cons',   clRow.getCell('EL'));
    set('cm_clinker_purch_open', clRow.getCell('EO'));
    set('cm_clinker_purch_recv', clRow.getCell('EP'));
    set('cm_clinker_purch_cons', clRow.getCell('EQ'));
    set('coal_kiln',             clRow.getCell('ED'));
    set('coal_cpp',              clRow.getCell('EH'));

    set('cm_gypsum_open', ceRow.getCell('C'));
    set('cm_gypsum_recv', ceRow.getCell('D'));
    set('cm_gypsum_cons', ceRow.getCell('F'));
    setSum('cm_grind_aid_open', ceRow.getCell('H'), ceRow.getCell('L'));
    setSum('cm_grind_aid_recv', ceRow.getCell('I'), ceRow.getCell('M'));
    setSum('cm_grind_aid_cons', ceRow.getCell('J'), ceRow.getCell('N'));

    set('cm1_425r_mt', p2Row.getCell('AC'));
    set('cm1_325n_mt', p2Row.getCell('AF'));
    set('cm1_425n_mt', p2Row.getCell('AI'));
    set('cm1_opc_mt',  p2Row.getCell('AL'));
    set('cm2_425r_mt',    p2Row.getCell('AR'));
    set('cm2_325n_mt',    p2Row.getCell('AU'));
    set('cm2_425n_mt',    p2Row.getCell('AX'));
    set('cm2_425n_bm_mt', p2Row.getCell('BD'));

    // Guard against an unfilled row (every field 0) rather than seeding a
    // false "plant fully stopped" record.
    const nonZero = Object.values(data).some((v) => v && Math.abs(v) > 0.001);
    if (!nonZero) { skipped++; continue; }

    const dateStr = `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const r = await api('POST', '/reports/production', { token, body: { date: dateStr, data } });
    if (r.status >= 300) {
      failed++;
      console.error(`  ❌ ${dateStr}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    } else {
      submitted++;
      process.stdout.write(`  ✅ ${dateStr}\r`);
    }
  }
  console.log('');

  console.log(`\nDone. submitted=${submitted} skipped(all-zero)=${skipped} failed=${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
