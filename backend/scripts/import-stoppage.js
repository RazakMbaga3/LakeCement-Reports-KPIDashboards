/*
  scripts/import-stoppage.js — backfill of the stoppage form
  (forms/stoppage-form.html) from the plant's real master Stoppage Report
  workbooks, so the Dashboard tab's Pareto/category totals show real data
  for April–June 2026 instead of the April-only hand-compiled reference set.

  Extraction lives in a one-off Python/openpyxl script (category-header +
  reason-row aggregation per section sheet, converting the source's decimal
  hours to the app's persisted minutes) — this script's only job is: read
  the JSON it wrote, log in as a 'pm'-role account (form access:
  backend/config/formAccess.js → pm owns 'stoppage'), and POST each day.

  Usage:
    node scripts/import-stoppage.js --file <path-to-stoppage-data.json> [--base-url http://localhost:5000/api]
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

const PM_USER = process.env.IMPORT_PM_USER;
const PM_PASS = process.env.IMPORT_PM_PASS;

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
  if (!FILE) {
    console.error('Usage: node scripts/import-stoppage.js --file <path-to-stoppage-data.json>');
    process.exit(1);
  }
  if (!PM_USER || !PM_PASS) {
    console.error('Set IMPORT_PM_USER and IMPORT_PM_PASS in the environment before running.');
    process.exit(1);
  }
  if (!fs.existsSync(FILE)) {
    console.error(`File not found: ${FILE}`);
    process.exit(1);
  }

  const loginRes = await api('POST', '/auth/login', { body: { username: PM_USER, password: PM_PASS } });
  if (loginRes.status !== 200) {
    console.error('Login failed:', loginRes.status, loginRes.body);
    process.exit(1);
  }
  const token = loginRes.body.token;
  console.log(`Logged in as ${PM_USER} (role ${loginRes.body.user.role})`);

  const records = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  console.log(`Loaded ${records.length} day records from ${path.basename(FILE)}`);

  let submitted = 0, failed = 0;

  for (const rec of records) {
    const { date, ...data } = rec;
    const r = await api('POST', '/reports/stoppage', { token, body: { date, data } });
    if (r.status >= 300) {
      failed++;
      console.error(`  ❌ ${date}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
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
