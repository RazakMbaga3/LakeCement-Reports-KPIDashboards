/*
  scripts/backfill-raw-materials.js — safe GET-merge-POST-verify backfill
  of the new raw-material / cement-grinding / internal-use-cement /
  specific-power fields into the existing `daily_reports` production
  rows for 2026-04-01 .. 2026-06-30.

  POST /api/reports/:formType REPLACES the whole `data` JSONB column
  (ON CONFLICT ... DO UPDATE SET data = EXCLUDED.data — see
  backend/routes/reports.js), it does NOT merge server-side. So for
  every date this script:
    1. GETs the existing record.
    2. Merges the new fields on top client-side ({ ...existing, ...new }).
    3. Refuses to proceed if that merge would silently change the VALUE
       of any key that already existed with a different value (the only
       keys this script ever introduces are brand new — rmm_/cm_limestone_/
       cm_starex_/iuc_/spc_/coal_ncv — so a collision here means something
       is wrong and needs a human to look, not a silent overwrite).
    4. POSTs the merged object.
    5. Re-GETs and verifies every existing key is unchanged AND every new
       key now matches what was just written.

  Usage:
    node backend/scripts/backfill-raw-materials.js [--base-url ...]
  Reads: backend/scripts/_rawmat_2026-04.json / _05.json / _06.json
         (written by extract-raw-materials.py)
*/
require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const BASE = (process.argv.includes('--base-url')
  ? process.argv[process.argv.indexOf('--base-url') + 1]
  : process.env.IMPORT_BASE_URL) || 'https://lakecement-mis-api.onrender.com/api';

const PROD_USER = process.env.IMPORT_PROD_USER || 'production';
const PROD_PASS = process.env.IMPORT_PROD_PASS || 'prod@lcl2026';

const JSON_FILES = ['_rawmat_2026-04.json', '_rawmat_2026-05.json', '_rawmat_2026-06.json']
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

function numEq(a, b) {
  if (a === b) return true;
  const na = +a, nb = +b;
  if (isNaN(na) || isNaN(nb)) return false;
  return Math.abs(na - nb) < 0.005; // 2dp float tolerance
}

async function main() {
  const loginRes = await api('POST', '/auth/login', { body: { username: PROD_USER, password: PROD_PASS } });
  if (loginRes.status !== 200) {
    console.error('Login failed:', loginRes.status, loginRes.body);
    process.exit(1);
  }
  const token = loginRes.body.token;
  console.log(`Logged in as ${PROD_USER} (role ${loginRes.body.user.role}, id ${loginRes.body.user.id})`);

  let written = 0, skipped = 0, failed = 0, collisions = 0;
  const failedDates = [];

  for (const file of JSON_FILES) {
    if (!fs.existsSync(file)) {
      console.log(`\n(skipping ${file} — run extract-raw-materials.py first)`);
      continue;
    }
    const days = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const dates = Object.keys(days).sort();
    console.log(`\n=== ${path.basename(file)} (${dates.length} days) ===`);

    for (const dateStr of dates) {
      const newFields = days[dateStr];

      // 1. GET existing
      const getRes = await api('GET', `/reports/production/${dateStr}`, { token });
      if (getRes.status !== 200) {
        console.error(`  ❌ ${dateStr}: GET failed HTTP ${getRes.status}`);
        failed++; failedDates.push(dateStr);
        continue;
      }
      const existing = (getRes.body && getRes.body.data) || {};

      // 2. Collision check — any key that already exists with a DIFFERENT value?
      let collision = false;
      for (const k of Object.keys(newFields)) {
        if (Object.prototype.hasOwnProperty.call(existing, k) && !numEq(existing[k], newFields[k])) {
          console.error(`  ⚠️  ${dateStr}: COLLISION on '${k}' — existing=${existing[k]} new=${newFields[k]} — SKIPPING this date, needs human review`);
          collision = true;
        }
      }
      if (collision) { collisions++; skipped++; continue; }

      const merged = { ...existing, ...newFields };

      // 3. POST merged object
      const postRes = await api('POST', '/reports/production', { token, body: { date: dateStr, data: merged } });
      if (postRes.status >= 300) {
        console.error(`  ❌ ${dateStr}: POST failed HTTP ${postRes.status} ${JSON.stringify(postRes.body)}`);
        failed++; failedDates.push(dateStr);
        continue;
      }

      // 4. Re-GET and verify
      const verifyRes = await api('GET', `/reports/production/${dateStr}`, { token });
      const verifyData = (verifyRes.body && verifyRes.body.data) || {};
      let ok = true;
      for (const k of Object.keys(existing)) {
        if (!numEq(verifyData[k], existing[k]) && verifyData[k] !== existing[k]) {
          console.error(`  ❌ ${dateStr}: REGRESSION — existing key '${k}' changed! was=${existing[k]} now=${verifyData[k]}`);
          ok = false;
        }
      }
      for (const k of Object.keys(newFields)) {
        if (!numEq(verifyData[k], newFields[k])) {
          console.error(`  ❌ ${dateStr}: new key '${k}' didn't verify — expected=${newFields[k]} got=${verifyData[k]}`);
          ok = false;
        }
      }
      if (ok) {
        written++;
        process.stdout.write(`  ✅ ${dateStr} (${Object.keys(newFields).length} new fields, ${Object.keys(existing).length} preserved)\r`);
      } else {
        failed++; failedDates.push(dateStr);
      }
    }
    console.log('');
  }

  console.log(`\nDone. written=${written} skipped(collision)=${collisions} failed=${failed}`);
  if (failedDates.length) console.log('Failed/collision dates:', failedDates.join(', '));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
