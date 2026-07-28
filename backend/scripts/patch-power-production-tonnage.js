/*
  scripts/patch-power-production-tonnage.js — one-time patch adding
  pwr_kiln_prod_mt / pwr_cm1_prod_mt / pwr_cm2_prod_mt onto the Apr–Jun 2026
  power-cons records already seeded by import-power-cons.js, so the
  Specific Power Consumption ratio KPIs (which divide by these) finally
  compute instead of showing "no data".

  These three facts are power-cons-form-only duplicates of figures that
  also live on the production form (kiln_prod_mt, and the CM1/CM2 grade
  tonnages summed) — the power-cons form was built to hold its own copies
  so its live in-form preview (kpi-live.js) can show an approximate SPC
  number without a cross-form fetch. Real data entry would fill both;
  this script back-fills the power-cons side to match, from the same
  source cells import-production.js already used and verified for the
  production-form side (Clinker!EK, Production2 AC/AF/AI/AL/AR/AU/AX/BD).

  IMPORTANT: POST /api/reports/power-cons REPLACES the whole `data` JSONB
  blob (no merge in the route) — so this script GETs each day's existing
  record first and POSTs the merged object back, rather than posting the
  three new fields alone and wiping the 91-day kWh backfill.

  2026-07-27: extended to April and May — a full-month production master
  file for each is now in the repo (`full Production Report april and
  may/Master production report APRIL 26'.xlsx` / `MAY 26'.xlsx`), same
  Clinker/Production2 sheet layout as the June file this script was
  originally written against (verified: EK column, row 3 = day 1,
  AC/AF/AI/AL/AR/AU/AX/BD headers all "Production").

  Usage: node scripts/patch-power-production-tonnage.js
*/
require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');

const BASE = process.env.IMPORT_BASE_URL || 'http://localhost:5000/api';
const PM_USER = process.env.IMPORT_PM_USER || 'pm';
const PM_PASS = process.env.IMPORT_PM_PASS || 'PM@LCL2026';

const MONTHS = [
  { file: path.join(__dirname, '..', '..', 'full Production Report april and may', "Master production report APRIL 26'.xlsx"), year: 2026, month: 4, days: 30 },
  { file: path.join(__dirname, '..', '..', 'full Production Report april and may', "Master production report MAY 26'.xlsx"), year: 2026, month: 5, days: 31 },
  { file: path.join(__dirname, '..', '..', "Master production report JUNE 26'.xlsx"), year: 2026, month: 6, days: 30 },
];

function cellNumber(cell) {
  if (!cell) return undefined;
  let v = cell.value;
  if (v && typeof v === 'object') v = 'result' in v ? v.result : undefined;
  return typeof v === 'number' ? v : undefined;
}
function sum(...cells) {
  const vals = cells.map(cellNumber).filter((n) => n !== undefined);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : undefined;
}
function round2(n) { return Math.round(n * 100) / 100; }

async function api(method, pathname, { token, body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

async function patchMonth(token, { file, year, month, days }) {
  console.log(`\n--- ${year}-${String(month).padStart(2, '0')} (${file}) ---`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const production2 = wb.getWorksheet('Production2');
  const clinker = wb.getWorksheet('Clinker');

  let patched = 0, skipped = 0, failed = 0;

  for (let day = 1; day <= days; day++) {
    const row = day + 2; // row 3 = day 1
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const kilnProd = cellNumber(clinker.getRow(row).getCell('EK'));
    const cm1Total = sum(
      production2.getRow(row).getCell('AC'), production2.getRow(row).getCell('AF'),
      production2.getRow(row).getCell('AI'), production2.getRow(row).getCell('AL'));
    const cm2Total = sum(
      production2.getRow(row).getCell('AR'), production2.getRow(row).getCell('AU'),
      production2.getRow(row).getCell('AX'), production2.getRow(row).getCell('BD'));

    if (kilnProd === undefined && cm1Total === undefined && cm2Total === undefined) {
      skipped++; continue;
    }

    const existing = await api('GET', `/reports/power-cons/${dateStr}`, { token });
    if (existing.status !== 200 || !existing.body || !existing.body.data) {
      failed++;
      console.error(`  ❌ ${dateStr}: no existing power-cons record to patch (status ${existing.status})`);
      continue;
    }

    const merged = { ...existing.body.data };
    if (kilnProd !== undefined) merged.pwr_kiln_prod_mt = round2(kilnProd);
    if (cm1Total !== undefined) merged.pwr_cm1_prod_mt = round2(cm1Total);
    if (cm2Total !== undefined) merged.pwr_cm2_prod_mt = round2(cm2Total);

    const r = await api('POST', '/reports/power-cons', { token, body: { date: dateStr, data: merged } });
    if (r.status >= 300) {
      failed++;
      console.error(`  ❌ ${dateStr}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    } else {
      patched++;
      process.stdout.write(`  ✅ ${dateStr}\r`);
    }
  }
  console.log(`\nDone. patched=${patched} skipped(no-data)=${skipped} failed=${failed}`);
  return failed;
}

async function main() {
  const loginRes = await api('POST', '/auth/login', { body: { username: PM_USER, password: PM_PASS } });
  if (loginRes.status !== 200) { console.error('Login failed:', loginRes.status, loginRes.body); process.exit(1); }
  const token = loginRes.body.token;
  console.log(`Logged in as ${PM_USER} (role ${loginRes.body.user.role})`);

  let totalFailed = 0;
  for (const m of MONTHS) {
    totalFailed += await patchMonth(token, m);
  }
  process.exit(totalFailed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
