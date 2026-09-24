/*
  scripts/import-materials.js — backfill of the materials form
  (forms/materials-form.html) from the plant's real master Raw Material
  Report workbooks, so the Raw Materials report shows real per-day stock
  and consumption for April–June 2026 instead of only the 21.04.2026
  hand-baked reference day.

  Extraction lives in a one-off Python/openpyxl script that ports the
  exact MATERIALS_SECTIONS row catalogue and section-matching logic from
  forms/excel-import.js's `materials` extractor, applied per day-sheet
  ('01'..'31') in each monthly workbook instead of a single-day upload.
  This script's only job is: read the JSON it wrote, log in as a
  'stores'-role account (form access: backend/config/formAccess.js →
  stores owns 'materials'), and POST each day.

  Usage:
    node scripts/import-materials.js --file <path-to-materials-data.json> [--base-url http://localhost:5000/api]
*/
require('../config/env');
const fs   = require('fs');
const path = require('path');

const BASE = (process.argv.includes('--base-url')
  ? process.argv[process.argv.indexOf('--base-url') + 1]
  : process.env.IMPORT_BASE_URL) || 'http://localhost:5000/api';

const FILE = process.argv.includes('--file')
  ? process.argv[process.argv.indexOf('--file') + 1]
  : null;

const STORES_USER = process.env.IMPORT_STORES_USER;
const STORES_PASS = process.env.IMPORT_STORES_PASS;

/* A RE-RUN lands on days that are already 'approved' or 'pending_approval',
   which POST /api/reports/:formType now refuses outright (409
   REPORT_LOCKED) rather than merging over them and quietly resetting the
   approval — see THE LOCK in backend/routes/reports.js. Sending a reason
   turns a re-run into an AUDITED amendment (FORM_AMEND_DIRECT, with the
   full pre-image kept in report_revisions) instead of a silent overwrite.
   Break-glass is admin/md only, so amending already-reported days needs
   IMPORT_STORES_USER/IMPORT_STORES_PASS set to an admin account. A
   first-time import is unaffected — nothing is locked yet. */
const AMEND_REASON =
  'Backfill re-import from the plant master Raw Material Report workbooks (scripts/import-materials.js)';

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
  if (!FILE) {
    console.error('Usage: node scripts/import-materials.js --file <path-to-materials-data.json>');
    process.exit(1);
  }
  if (!STORES_USER || !STORES_PASS) {
    console.error('Set IMPORT_STORES_USER and IMPORT_STORES_PASS in the environment before running.');
    process.exit(1);
  }
  if (!fs.existsSync(FILE)) {
    console.error(`File not found: ${FILE}`);
    process.exit(1);
  }

  const loginRes = await api('POST', '/auth/login', { body: { username: STORES_USER, password: STORES_PASS } });
  if (loginRes.status !== 200) {
    console.error('Login failed:', loginRes.status, loginRes.body);
    process.exit(1);
  }
  const token = loginRes.body.token;
  console.log(`Logged in as ${STORES_USER} (role ${loginRes.body.user.role})`);

  const records = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  console.log(`Loaded ${records.length} day records from ${path.basename(FILE)}`);

  let submitted = 0, failed = 0;

  for (const rec of records) {
    const { date, ...data } = rec;
    const r = await api('POST', '/reports/materials', {
      token, body: { date, data, amendReason: AMEND_REASON },
    });
    if (r.status >= 300) {
      failed++;
      console.error(`  ❌ ${date}: HTTP ${r.status} ${JSON.stringify(r.body)}${lockedHint(r)}`);
    } else {
      submitted++;
      process.stdout.write(`  ✅ ${date}\r`);
    }
  }
  console.log('');

  console.log(`\nDone. submitted=${submitted} failed=${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
