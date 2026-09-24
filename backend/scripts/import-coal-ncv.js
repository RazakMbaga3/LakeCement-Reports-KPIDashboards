/*
  scripts/import-coal-ncv.js — one-time backfill of daily coal NCV (Net
  Calorific Value, kcal/kg) onto the limestone form, so Specific Thermal
  Energy Consumption can finally compute (it was null for every real
  submission, not just backfilled data — see forms/formula-registry.js
  FACTS.kiln_coal_ncv notes, 2026-07-24).

  Source: each master production workbook's per-day sheets (one sheet per
  calendar day, named "1".."31"/"30") — NOT the Production2/Clinker/Cement
  rollup sheets the production-form backfill uses. Every day-sheet has a
  "SPECIFIC HEAT CONSUMPTION (KILN)" mini-table with a "COAL NCV, KCAL /
  KG COAL" row; found by the user directly in Excel (screenshot,
  2026-07-25), confirmed here it's present on every day of all three
  months. The label sits in column O (and duplicated in P); the cached
  value is one column to the right, in Q. The label's ROW drifts by a
  few rows month to month and even day to day (row 51 on most April/May
  days, row 53 on June 15) — same variable-blank-row pattern already
  seen in the production-report day-sheets — so this searches for the
  label text rather than assuming a fixed cell.

  Usage: node scripts/import-coal-ncv.js [--base-url http://localhost:5000/api]
*/
require('../config/env');
const path = require('path');
const ExcelJS = require('exceljs');

const BASE = (process.argv.includes('--base-url')
  ? process.argv[process.argv.indexOf('--base-url') + 1]
  : process.env.IMPORT_BASE_URL) || 'http://localhost:5000/api';

const PROD_USER = process.env.IMPORT_PROD_USER || 'production';
const PROD_PASS = process.env.IMPORT_PROD_PASS;

/* A RE-RUN lands on days that are already 'approved' or 'pending_approval',
   which POST /api/reports/:formType now refuses outright (409
   REPORT_LOCKED) rather than merging over them and quietly resetting the
   approval — see THE LOCK in backend/routes/reports.js. Sending a reason
   turns a re-run into an AUDITED amendment (FORM_AMEND_DIRECT, with the
   full pre-image kept in report_revisions) instead of a silent overwrite.
   Break-glass is admin/md only, so amending already-reported days needs
   IMPORT_PROD_USER/IMPORT_PROD_PASS set to an admin account. A first-time
   import is unaffected — nothing is locked yet. */
const AMEND_REASON =
  'Backfill re-import of daily coal NCV from the master production workbooks (scripts/import-coal-ncv.js)';

const MONTHS = [
  { file: path.join(__dirname, '..', '..', 'full Production Report april and may', "Master production report APRIL 26'.xlsx"), year: 2026, month: 4, days: 30 },
  { file: path.join(__dirname, '..', '..', 'full Production Report april and may', "Master production report MAY 26'.xlsx"),   year: 2026, month: 5, days: 31 },
  { file: path.join(__dirname, '..', '..', "Master production report JUNE 26'.xlsx"),                                          year: 2026, month: 6, days: 30 },
];

function cellVal(cell) {
  let v = cell.value;
  if (v && typeof v === 'object') v = v.richText ? v.richText.map((t) => t.text).join('') : ('result' in v ? v.result : undefined);
  return v;
}

/* Search columns O/P, rows 35-65, for the "COAL NCV" label; return the
   numeric value from column Q on that row, or undefined if not found. */
function findNcv(sheet) {
  for (let r = 35; r <= 65; r++) {
    for (let c = 15; c <= 16; c++) { // O, P
      const v = cellVal(sheet.getRow(r).getCell(c));
      if (typeof v === 'string' && /COAL NCV/i.test(v)) {
        const q = cellVal(sheet.getRow(r).getCell(17)); // Q
        return typeof q === 'number' ? q : undefined;
      }
    }
  }
  return undefined;
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

/* A 409 REPORT_LOCKED is not bad data — it means the day has already been
   reported and this account may not amend it. Say so plainly. */
function lockedHint(r) {
  return r.body && r.body.code === 'REPORT_LOCKED'
    ? `\n     ↳ already ${r.body.status}. Re-run with an admin/md account to amend it (see AMEND_REASON).`
    : '';
}

async function main() {
  if (!PROD_PASS) { console.error('Set IMPORT_PROD_PASS in the environment before running.'); process.exit(1); }
  const loginRes = await api('POST', '/auth/login', { body: { username: PROD_USER, password: PROD_PASS } });
  if (loginRes.status !== 200) { console.error('Login failed:', loginRes.status, loginRes.body); process.exit(1); }
  const token = loginRes.body.token;
  console.log(`Logged in as ${PROD_USER} (role ${loginRes.body.user.role})`);

  let submitted = 0, skipped = 0, failed = 0;

  for (const m of MONTHS) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(m.file);
    console.log(`\n=== ${path.basename(m.file)} (${m.year}-${String(m.month).padStart(2, '0')}, ${m.days} days) ===`);

    for (let day = 1; day <= m.days; day++) {
      const sheet = wb.getWorksheet(String(day));
      const ncv = sheet ? findNcv(sheet) : undefined;
      if (ncv === undefined || ncv <= 0) { skipped++; continue; }

      const dateStr = `${m.year}-${String(m.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const r = await api('POST', '/reports/limestone', {
        token, body: { date: dateStr, data: { ncv: Math.round(ncv) }, amendReason: AMEND_REASON },
      });
      if (r.status >= 300) {
        failed++;
        console.error(`  ❌ ${dateStr}: HTTP ${r.status} ${JSON.stringify(r.body)}${lockedHint(r)}`);
      } else {
        submitted++;
        process.stdout.write(`  ✅ ${dateStr} (${Math.round(ncv)})\r`);
      }
    }
    console.log('');
  }

  console.log(`\nDone. submitted=${submitted} skipped(no-ncv-found)=${skipped} failed=${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
