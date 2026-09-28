/*
  scripts/accept-it-assets.js — IT Asset Register, against a live server.

  Proves what unit tests cannot: a real workbook, real transactions, real
  HTTP, real role gates.

    A. import       the real sample workbook lands in it_assets with the
                     right row count per category, and an audit/import
                     trail row is written
    B. re-import    a second upload of the same file REPLACES each
                     category wholesale (same counts, new row ids) rather
                     than duplicating rows
    C. CRUD         create / update / delete one row round-trip on a single
                     category, each writing its own audit row
    D. access       write is admin+it only; read additionally allows
                     management+md; everyone else is refused outright, both
                     for reading a category and for uploading

  Cleans up after itself (it_assets/it_asset_imports rows only touch rows
  this run created — see note on scoping in cleanup()). Exits 0 only if all
  checks pass.

  Usage: npm run accept:it-assets
*/

require('../config/env');
const { spawn } = require('child_process');
const path       = require('path');
const fs         = require('fs');
const bcrypt     = require('bcryptjs');
const db         = require('../db');

const PORT = process.env.ACCEPT_PORT || 5924;
const BASE = `http://localhost:${PORT}/api`;
const PW   = 'Accept@89012';

const SAMPLE_WORKBOOK = path.join(
  __dirname, '..', '..', 'data', 'samples', '2026-04-21',
  'M - 19 IT Report - AUGUST 2026.xlsx');

// Expected row counts per category, independently confirmed by parsing the
// real sample workbook directly (services/itAssetImport.js) before this
// script was written — not assumed from the task brief.
const EXPECTED_COUNTS = {
  factory_computers:   131,
  ho_computers:         34,
  printers:             49,
  equipment_software:   21,
  dcs_licenses:         37,
  network_switches:     61,
  cctv:                 93,
  external_hard_disks:  18,
  biometric_devices:    11,
  ewaste:               44,
};

const USERS = {
  it:      { username: 'ita_it',      role: 'it',         level: 'hod' },
  admin:   { username: 'ita_admin',   role: 'admin',       level: 'hod' },
  mgmt:    { username: 'ita_mgmt',    role: 'management',  level: 'hod' },
  md:      { username: 'ita_md',      role: 'md',          level: 'hod' },
  other:   { username: 'ita_other',   role: 'production',  level: 'officer' },
};
const NAMES = Object.values(USERS).map(u => u.username);

let passCount = 0, failCount = 0;
function check(name, cond, extra) {
  if (cond) { passCount++; console.log(`  ✅ ${name}`); }
  else      { failCount++; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

async function api(method, pathname, { token, body } = {}) {
  const headers = {};
  if (body)  headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, body: json, text };
}

async function apiUpload(pathname, { token, filePath, filename, mimetype } = {}) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf], {
    type: mimetype || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }), filename || path.basename(filePath));

  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + pathname, { method: 'POST', headers, body: form });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, body: json, text };
}

async function loginToken(username) {
  const r = await api('POST', '/auth/login', { body: { username, password: PW } });
  if (r.status !== 200) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

async function seedUsers() {
  const hash = await bcrypt.hash(PW, 6);
  for (const u of Object.values(USERS)) {
    await db.query(`
      INSERT INTO users (username, password_hash, full_name, role, department, level, active, must_change_password)
      VALUES ($1, $2, $3, $4, 'TEST', $5, true, false)
      ON CONFLICT (username) DO UPDATE SET
        password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, level = EXCLUDED.level,
        active = true, must_change_password = false, failed_attempts = 0, locked_until = NULL, token_version = 0
    `, [u.username, hash, 'IT Assets Test ' + u.username, u.role, u.level]);
  }
}

async function cleanup() {
  await db.query(
    `DELETE FROM audit_log WHERE username = ANY($1)
        OR user_id IN (SELECT id FROM users WHERE username = ANY($1))`, [NAMES]);
  await db.query(
    `DELETE FROM it_asset_imports WHERE imported_by IN (SELECT id FROM users WHERE username = ANY($1))
        OR imported_by_name LIKE 'IT Assets Test %'`, [NAMES]);
  await db.query(
    `DELETE FROM it_assets WHERE updated_by IN (SELECT id FROM users WHERE username = ANY($1))
        OR updated_by_name LIKE 'IT Assets Test %'`, [NAMES]);
  await db.query('DELETE FROM users WHERE username = ANY($1)', [NAMES]);
}

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, AUTH_RATE_LIMIT: '500', WATCHDOG_CRON: 'off', BACKUP_CRON: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.output = () => out;
  return child;
}

async function waitForHealth() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return true; }
    catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

const one = async (sql, params) => (await db.query(sql, params)).rows[0] || null;
const countOf = category => one(`SELECT COUNT(*)::int AS n FROM it_assets WHERE category = $1`, [category]).then(r => r.n);
const audits = (action, category) =>
  db.query(`SELECT * FROM audit_log WHERE action = $1 AND form_type = $2`, [action, 'it-assets:' + category]).then(r => r.rows);

async function main() {
  console.log('IT Asset Register acceptance — booting server on port ' + PORT + '…\n');

  if (!fs.existsSync(SAMPLE_WORKBOOK)) {
    console.error('Sample workbook not found at ' + SAMPLE_WORKBOOK);
    process.exit(1);
  }

  await cleanup();
  await seedUsers();
  const child = startServer();

  try {
    if (!(await waitForHealth())) {
      console.error('Server did not come up.\n--- output ---\n' + child.output());
      process.exit(1);
    }

    const T = {};
    for (const [k, u] of Object.entries(USERS)) T[k] = await loginToken(u.username);

    /* ══ A. IMPORT ══════════════════════════════════════════════════════ */
    console.log('A. Import (real sample workbook):');

    let r = await apiUpload('/it-assets/import', { token: T.it, filePath: SAMPLE_WORKBOOK });
    check('the IT role can upload the real workbook (200)', r.status === 200, JSON.stringify(r.body).slice(0, 300));

    if (r.status === 200) {
      check('nothing reported missing — every expected sheet was recognized',
        Array.isArray(r.body.missing) && r.body.missing.length === 0, JSON.stringify(r.body.missing));

      const gotByCat = Object.fromEntries((r.body.imported || []).map(t => [t.category, t.newCount]));
      console.log('\n  Row counts per category (response vs. expected from the real workbook):');
      for (const [cat, expected] of Object.entries(EXPECTED_COUNTS)) {
        const got = gotByCat[cat];
        console.log(`    ${cat.padEnd(20)} expected ${String(expected).padStart(3)}  got ${String(got).padStart(3)}`);
        check(`${cat}: import response row count matches the real workbook (${expected})`, got === expected, `got ${got}`);
      }

      console.log('\n  Row counts actually persisted in it_assets:');
      for (const [cat, expected] of Object.entries(EXPECTED_COUNTS)) {
        const dbCount = await countOf(cat);
        console.log(`    ${cat.padEnd(20)} expected ${String(expected).padStart(3)}  in DB ${String(dbCount).padStart(3)}`);
        check(`${cat}: persisted row count matches (${expected})`, dbCount === expected, `db has ${dbCount}`);
      }
    }

    r = await api('GET', '/it-assets', { token: T.it });
    check('the overview reflects the import (200, all 10 categories present)',
      r.status === 200 && Array.isArray(r.body.categories) && r.body.categories.length === 10, JSON.stringify(r.body).slice(0, 200));
    const overviewCctv = r.body && r.body.categories.find(c => c.category === 'cctv');
    check('…with per-category counts and last-import info', overviewCctv && overviewCctv.count === EXPECTED_COUNTS.cctv
      && overviewCctv.lastImport && overviewCctv.lastImport.source_filename === 'M - 19 IT Report - AUGUST 2026.xlsx',
      JSON.stringify(overviewCctv));

    const importAudits = await audits('IT_ASSET_IMPORT', 'all');
    check('IT_ASSET_IMPORT wrote an audit row', importAudits.length >= 1);

    const importRows = await db.query(
      `SELECT category, row_count, previous_row_count FROM it_asset_imports
       WHERE imported_by_name = 'IT Assets Test ita_it' ORDER BY category`).then(x => x.rows);
    check('it_asset_imports has one row per category imported (10)', importRows.length === 10, `got ${importRows.length}`);
    check('…with previous_row_count = 0 on a first import',
      importRows.every(x => x.previous_row_count === 0), JSON.stringify(importRows.filter(x => x.previous_row_count !== 0)));

    /* ══ B. RE-IMPORT REPLACES, DOESN'T DUPLICATE ══════════════════════ */
    console.log('\nB. Re-import (same file again):');

    const beforeIds = await db.query(`SELECT id FROM it_assets WHERE category = 'ewaste' ORDER BY id`).then(x => x.rows.map(r => r.id));
    r = await apiUpload('/it-assets/import', { token: T.it, filePath: SAMPLE_WORKBOOK });
    check('a second upload of the same workbook also succeeds (200)', r.status === 200, JSON.stringify(r.body).slice(0, 200));

    const afterCount = await countOf('ewaste');
    check('re-importing the SAME file yields the SAME row count, not double',
      afterCount === EXPECTED_COUNTS.ewaste, `got ${afterCount}`);
    const afterIds = await db.query(`SELECT id FROM it_assets WHERE category = 'ewaste' ORDER BY id`).then(x => x.rows.map(r => r.id));
    check('…and the rows are NEW ids (old ones deleted, not merged/upserted)',
      afterIds.length > 0 && afterIds.every(id => !beforeIds.includes(id)), `overlap: ${afterIds.filter(id => beforeIds.includes(id)).length}`);

    const secondImportRow = await one(
      `SELECT previous_row_count, row_count FROM it_asset_imports WHERE category = 'ewaste' ORDER BY imported_at DESC LIMIT 1`);
    check('the import audit trail shows the replace (previous_row_count = old count)',
      secondImportRow && secondImportRow.previous_row_count === EXPECTED_COUNTS.ewaste && secondImportRow.row_count === EXPECTED_COUNTS.ewaste,
      JSON.stringify(secondImportRow));

    /* ══ C. CRUD ROUND-TRIP (one category: external_hard_disks) ═══════ */
    console.log('\nC. CRUD round-trip:');

    r = await api('POST', '/it-assets/external_hard_disks', {
      token: T.it, body: { name: 'Acceptance Test Disk', dept: 'IT', qty: '1', capacity: '1TB', actual_data: 'test data' } });
    check('IT can create a row (201)', r.status === 201 && r.body.data.name === 'Acceptance Test Disk', JSON.stringify(r.body));
    const newId = r.body && r.body.id;

    r = await api('POST', '/it-assets/external_hard_disks', { token: T.it, body: { bogus_field: 'x' } });
    check('an unknown field for the category is rejected (400)', r.status === 400, JSON.stringify(r.body));

    r = await api('PUT', `/it-assets/external_hard_disks/${newId}`, { token: T.it, body: { capacity: '2TB' } });
    check('IT can update a row, partial patch (200)', r.status === 200 && r.body.data.capacity === '2TB', JSON.stringify(r.body));
    check('…untouched fields are preserved (merge, not replace)', r.body.data.name === 'Acceptance Test Disk');

    r = await api('GET', '/it-assets/external_hard_disks', { token: T.it, });
    check('the new row is listed back', r.status === 200 && r.body.rows.some(row => row.id === newId));

    r = await api('GET', `/it-assets/external_hard_disks?q=Acceptance`, { token: T.it });
    check('free-text search finds it', r.status === 200 && r.body.rows.some(row => row.id === newId), JSON.stringify(r.body).slice(0, 200));

    r = await api('DELETE', `/it-assets/external_hard_disks/${newId}`, { token: T.it });
    check('IT can delete the row (200)', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

    r = await api('DELETE', `/it-assets/external_hard_disks/${newId}`, { token: T.it });
    check('deleting again finds nothing (404)', r.status === 404, JSON.stringify(r.body));

    const crudAudits = {
      create: await audits('IT_ASSET_CREATE', 'external_hard_disks'),
      update: await audits('IT_ASSET_UPDATE', 'external_hard_disks'),
      del:    await audits('IT_ASSET_DELETE', 'external_hard_disks'),
    };
    check('create/update/delete each wrote an audit row',
      crudAudits.create.length >= 1 && crudAudits.update.length >= 1 && crudAudits.del.length >= 1,
      JSON.stringify({ c: crudAudits.create.length, u: crudAudits.update.length, d: crudAudits.del.length }));

    /* ══ D. ACCESS ══════════════════════════════════════════════════════ */
    console.log('\nD. Access control:');

    r = await api('GET', '/it-assets/cctv', { token: T.admin });
    check('admin can read (200)', r.status === 200);
    r = await api('GET', '/it-assets/cctv', { token: T.mgmt });
    check('management can read (200)', r.status === 200);
    r = await api('GET', '/it-assets/cctv', { token: T.md });
    check('md can read (200)', r.status === 200);
    r = await api('GET', '/it-assets/cctv', { token: T.other });
    check('a role outside IT_ASSETS_READ_ROLES cannot read (403)', r.status === 403, `status ${r.status}`);
    r = await api('GET', '/it-assets/cctv');
    check('no token at all is refused (401)', r.status === 401, `status ${r.status}`);

    r = await api('POST', '/it-assets/cctv', { token: T.mgmt, body: { camera_name: 'nope' } });
    check('management can read but not write (403)', r.status === 403, `status ${r.status}`);
    r = await api('POST', '/it-assets/cctv', { token: T.other, body: { camera_name: 'nope' } });
    check('an unrelated role cannot write either (403)', r.status === 403, `status ${r.status}`);
    r = await api('POST', '/it-assets/cctv', { token: T.admin, body: { camera_name: 'Admin Test Camera' } });
    check('admin (break-glass) can write (201)', r.status === 201, JSON.stringify(r.body));
    if (r.status === 201) {
      await api('DELETE', `/it-assets/cctv/${r.body.id}`, { token: T.admin });
    }

    r = await apiUpload('/it-assets/import', { token: T.other, filePath: SAMPLE_WORKBOOK });
    check('a role outside IT_ASSETS_WRITE_ROLES cannot upload (403)', r.status === 403, `status ${r.status}`);
    r = await apiUpload('/it-assets/import', { token: T.mgmt, filePath: SAMPLE_WORKBOOK });
    check('management (read-only) cannot upload either (403)', r.status === 403, `status ${r.status}`);

    // Wrong file type — honestly wrong on both the extension AND the
    // mimetype header, so this exercises multer's own fileFilter (a real
    // client would never send a .txt with the .xlsx content-type).
    const scratchTxt = path.join(__dirname, '..', '..', 'data', 'samples', '2026-04-21', '__accept_it_assets_scratch.txt');
    fs.writeFileSync(scratchTxt, 'not a workbook');
    try {
      r = await apiUpload('/it-assets/import', {
        token: T.it, filePath: scratchTxt, filename: 'notes.txt', mimetype: 'text/plain' });
      check('a non-.xlsx upload is rejected by the file filter (400)', r.status === 400, JSON.stringify(r.body));
    } finally {
      fs.unlinkSync(scratchTxt);
    }

    // A file that PASSES the filter (.xlsx name, xlsx mimetype) but isn't
    // really a zip underneath — a corrupted upload or a mis-renamed file,
    // which the filter alone cannot catch. Must not 500.
    const scratchFakeXlsx = path.join(__dirname, '..', '..', 'data', 'samples', '2026-04-21', '__accept_it_assets_scratch.xlsx');
    fs.writeFileSync(scratchFakeXlsx, 'this looks like an xlsx by name/mimetype but is not a real zip');
    try {
      r = await apiUpload('/it-assets/import', { token: T.it, filePath: scratchFakeXlsx });
      check('a corrupted/fake .xlsx (passes the filter, fails to parse) is a clean 400, not a 500',
        r.status === 400, `status ${r.status}: ${JSON.stringify(r.body)}`);
    } finally {
      fs.unlinkSync(scratchFakeXlsx);
    }

    r = await api('GET', '/it-assets/not_a_real_category', { token: T.it });
    check('an unknown category 400s (zod enum)', r.status === 400, JSON.stringify(r.body));

  } finally {
    if (process.env.ACCEPT_DEBUG) console.log('\n--- server output ---\n' + child.output());
    child.kill();
    await cleanup();
    await db.end();
  }

  console.log(`\n${failCount === 0 ? '✅' : '❌'} IT Asset Register acceptance: ${passCount} passed, ${failCount} failed.`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Acceptance run crashed:', err);
  try { await cleanup(); await db.end(); } catch { /* best effort */ }
  process.exit(1);
});
