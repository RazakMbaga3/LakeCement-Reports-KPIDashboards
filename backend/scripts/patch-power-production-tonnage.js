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
  number without a cross-form fetch. Real data entry would fill both.

  2026-08-21: rewritten to source these three facts from
  scripts/_production_2026-<MM>.json (extract-production.py's output)
  instead of re-reading Clinker!EK / Production2 AC/AF/AI/AL/AR/AU/AX/BD
  via ExcelJS. Root-caused a real gap this way: 2026-04-19's Clinker!EK
  cell holds a formula with NO cached `result` in the workbook (confirmed
  by inspecting the raw cell — neighboring rows 20/22 both carry a
  `result`, row 21/day-19 does not), the same "ExcelJS silently drops
  cached formula results on some cells" issue extract-production.py's own
  header warns about — which is exactly why that script uses openpyxl
  instead. Reusing its already-extracted, already-verified JSON avoids
  this whole bug class rather than patching one date.

  IMPORTANT: POST /api/reports/power-cons REPLACES the whole `data` JSONB
  blob (no merge in the route) — so this script GETs each day's existing
  record first and POSTs the merged object back, rather than posting the
  three new fields alone and wiping the 91-day kWh backfill.

  Usage: node scripts/patch-power-production-tonnage.js
*/
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const BASE = process.env.IMPORT_BASE_URL || 'http://localhost:5000/api';
const PM_USER = process.env.IMPORT_PM_USER || 'pm';
const PM_PASS = process.env.IMPORT_PM_PASS || 'PM@LCL2026';

const MONTHS = [
  { jsonFile: path.join(__dirname, '_production_2026-04.json'), year: 2026, month: 4, days: 30 },
  { jsonFile: path.join(__dirname, '_production_2026-05.json'), year: 2026, month: 5, days: 31 },
  { jsonFile: path.join(__dirname, '_production_2026-06.json'), year: 2026, month: 6, days: 30 },
];

const CM1_FIELDS = ['cm1_425r_mt', 'cm1_325n_mt', 'cm1_425n_mt', 'cm1_opc_mt'];
const CM2_FIELDS = ['cm2_425r_mt', 'cm2_325n_mt', 'cm2_425n_mt', 'cm2_425n_bm_mt'];

function sumFields(record, fields) {
  const vals = fields.map((f) => record[f]).filter((n) => typeof n === 'number');
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

async function patchMonth(token, { jsonFile, year, month, days }) {
  console.log(`\n--- ${year}-${String(month).padStart(2, '0')} (${jsonFile}) ---`);
  const byDate = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));

  let patched = 0, skipped = 0, failed = 0;

  for (let day = 1; day <= days; day++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const record = byDate[dateStr];

    const kilnProd = record && typeof record.kiln_prod_mt === 'number' ? record.kiln_prod_mt : undefined;
    const cm1Total = record ? sumFields(record, CM1_FIELDS) : undefined;
    const cm2Total = record ? sumFields(record, CM2_FIELDS) : undefined;

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
