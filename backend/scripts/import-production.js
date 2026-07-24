/*
  scripts/import-production.js — backfill of the production form
  (daily-report.html) from the plant's real Master Production Report
  workbooks, so the Daily Production Report's date navigation shows real
  per-day values instead of the static demo replica.

  Extraction lives in scripts/extract-production.py (Python/openpyxl),
  not here. Reason: ExcelJS was found to silently drop the cached
  formula RESULT for a subset of cells in these workbooks (confirmed on
  a real cell: 2 of 30 days on one column, verified by direct inspection)
  while still parsing the cell as a formula object — a Node-only
  extractor would produce quietly incomplete data on an unpredictable
  subset of days. openpyxl's data_only=True read has been cross-checked
  cell-by-cell against known values throughout this project with no such
  gap. This script's only job is: read the JSON that script wrote, log
  in as the production role, and POST each day.

  Usage:
    python scripts/extract-production.py         # writes scripts/_production_YYYY-MM.json
    node scripts/import-production.js [--base-url http://localhost:5000/api]
*/
require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const BASE = (process.argv.includes('--base-url')
  ? process.argv[process.argv.indexOf('--base-url') + 1]
  : process.env.IMPORT_BASE_URL) || 'http://localhost:5000/api';

const PROD_USER = process.env.IMPORT_PROD_USER || 'production';
const PROD_PASS = process.env.IMPORT_PROD_PASS;

const JSON_FILES = ['_production_2026-04.json', '_production_2026-05.json', '_production_2026-06.json']
  .map((f) => path.join(__dirname, f));

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
  if (!PROD_PASS) {
    console.error('Set IMPORT_PROD_PASS in the environment before running.');
    process.exit(1);
  }
  const loginRes = await api('POST', '/auth/login', { body: { username: PROD_USER, password: PROD_PASS } });
  if (loginRes.status !== 200) {
    console.error('Login failed:', loginRes.status, loginRes.body);
    process.exit(1);
  }
  const token = loginRes.body.token;
  console.log(`Logged in as ${PROD_USER} (role ${loginRes.body.user.role})`);

  let submitted = 0, failed = 0;

  for (const file of JSON_FILES) {
    if (!fs.existsSync(file)) {
      console.log(`\n(skipping ${file} — run extract-production.py first)`);
      continue;
    }
    const days = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const dates = Object.keys(days).sort();
    console.log(`\n=== ${path.basename(file)} (${dates.length} days) ===`);

    for (const dateStr of dates) {
      const r = await api('POST', '/reports/production', { token, body: { date: dateStr, data: days[dateStr] } });
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

  console.log(`\nDone. submitted=${submitted} failed=${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
