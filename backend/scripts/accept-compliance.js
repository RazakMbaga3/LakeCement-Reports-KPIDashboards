/*
  scripts/accept-compliance.js — the Compliance Master against a live server.

  Proves what unit tests cannot — real HTTP, real transactions, real role
  gates, real bytes in and out of Postgres, real outbox rows:

    A. import       preview → commit of the workbook; every row reconciled;
                     a wrong file is refused; re-import updates, never
                     duplicates, never touches what a department changed
    B. read/access  dashboard pivot = an independent recount of the register;
                     a department sees only its own records (others are 404);
                     management reads and cannot write; no token → 401
    C. record       optimistic-lock 409; officer cannot edit; admin cannot
                     verify; senior verifies
    D. documents    v1/v2 versions, byte-identical download (sha256), type
                     spoofing refused, retract keeps history, other
                     departments 404, unauthenticated 401
    E. batch renew  one certificate, many records, one stored blob
    F. filings      marking a VAT period done clears it; a review clears a
                     "Not complied" condition
    G. reminders    jsonTransport: held while unverified, sent once verified,
                     a second run the same day sends nothing; run under 10 s
                     and 15 MB of heap
    H. extras       counts, Excel export, KPI suggestion, /api/health

  Uses the real workbook when present (repo root, or COMPLIANCE_WORKBOOK),
  else the synthetic one in test/fixtures — CI never sees the real file.

  Refuses to run against a database that already holds compliance records
  it did not create (set ACCEPT_COMPLIANCE_FORCE=1 to override): the import
  it performs would otherwise mix with real data.

  Usage: npm run accept:compliance
*/
require('../config/env');
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { buildWorkbook } = require('../test/fixtures/compliance-workbook');

const PORT = process.env.ACCEPT_PORT || 5931;
const BASE = `http://localhost:${PORT}/api`;
const PW = 'Accept@89012';
const REAL = process.env.COMPLIANCE_WORKBOOK || path.join(__dirname, '..', '..', '1. Compliance Master.xlsx');

const USERS = {
  admin:     { username: 'cmp_admin',     role: 'admin',      level: 'hod' },
  md:        { username: 'cmp_md',        role: 'md',         level: 'hod' },
  mgmt:      { username: 'cmp_mgmt',      role: 'management', level: 'hod' },
  pmHod:     { username: 'cmp_pm_hod',    role: 'pm',         level: 'hod' },
  pmSenior:  { username: 'cmp_pm_senior', role: 'pm',         level: 'senior' },
  pmOfficer: { username: 'cmp_pm_off',    role: 'pm',         level: 'officer' },
  eiHod:     { username: 'cmp_ei_hod',    role: 'ei',         level: 'hod' },
  finSenior: { username: 'cmp_fin_sen',   role: 'finance',    level: 'senior' },
  minSenior: { username: 'cmp_min_sen',   role: 'mining',     level: 'senior' },
};
const NAMES = Object.values(USERS).map(u => u.username);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}${extra ? ' — ' + String(extra).slice(0, 400) : ''}`); }
}

async function api(method, p, { token, body, raw } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
async function upload(p, { token, file, name, type, fields }) {
  const form = new FormData();
  if (file) form.append('file', new Blob([file], { type: type || 'application/octet-stream' }), name);
  for (const [k, v] of Object.entries(fields || {})) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  const res = await fetch(BASE + p, { method: 'POST', headers, body: form });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const pdf = label => Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const today = () => require('../services/complianceStatus').todayIn();

async function seedUsers() {
  const hash = await bcrypt.hash(PW, 6);
  for (const u of Object.values(USERS)) {
    await db.query(`
      INSERT INTO users (username, password_hash, full_name, role, department, level, active, must_change_password)
      VALUES ($1,$2,$3,$4,'TEST',$5,true,false)
      ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, level = EXCLUDED.level,
        active = true, must_change_password = false, failed_attempts = 0, locked_until = NULL, token_version = 0`,
    [u.username, hash, 'Compliance Test ' + u.username, u.role, u.level]);
  }
}

let firstRunId = null;
async function cleanup() {
  const ids = (await db.query('SELECT id FROM users WHERE username = ANY($1)', [NAMES])).rows.map(r => r.id);
  const items = (await db.query(`SELECT id FROM compliance_items WHERE created_by = ANY($1) OR created_by_name LIKE 'Compliance Test %'`, [ids])).rows.map(r => r.id);
  if (items.length) {
    await db.query('DELETE FROM compliance_documents WHERE item_id = ANY($1)', [items]);
    await db.query('DELETE FROM compliance_items WHERE id = ANY($1)', [items]);
  }
  await db.query('DELETE FROM compliance_blobs b WHERE NOT EXISTS (SELECT 1 FROM compliance_documents d WHERE d.blob_sha256 = b.sha256)');
  await db.query('DELETE FROM compliance_groups g WHERE NOT EXISTS (SELECT 1 FROM compliance_items i WHERE i.group_id = g.id)');
  await db.query('DELETE FROM compliance_head_recipients');
  await db.query(`DELETE FROM compliance_contacts c WHERE NOT EXISTS (SELECT 1 FROM compliance_item_responsibles r WHERE r.contact_id = c.id)`);
  await db.query(`DELETE FROM compliance_imports WHERE by_id = ANY($1) OR by_name LIKE 'Compliance Test %'`, [ids]);
  if (firstRunId) {
    await db.query('DELETE FROM compliance_mail_log WHERE run_id >= $1', [firstRunId]);
    await db.query('DELETE FROM compliance_reminder_runs WHERE id >= $1', [firstRunId]);
  }
  if (!(await db.query('SELECT 1 FROM compliance_items LIMIT 1')).rows.length) {
    await db.query('DELETE FROM compliance_snapshots');
    await db.query(`UPDATE compliance_settings SET value = 'false' WHERE key = 'reminders_enabled'`);
    await db.query(`DELETE FROM compliance_settings WHERE key <> 'reminders_enabled'`);
  }
  await db.query(`DELETE FROM audit_log WHERE username = ANY($1) OR user_id = ANY($2) OR username LIKE 'Compliance Test %'`, [NAMES, ids]);
  await db.query('DELETE FROM users WHERE username = ANY($1)', [NAMES]);
}

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, AUTH_RATE_LIMIT: '500', WATCHDOG_CRON: 'off', BACKUP_CRON: 'off', RESTORE_DRILL_CRON: 'off',
      COMPLIANCE_REMINDER_CRON: 'off', ODOO_SYNC_CRON: 'off', ODOO_LIVE_SYNC_CRON: 'off', DIGEST_TRANSPORT: 'json',
      APP_URL: 'https://mis.example.test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  child.output = () => out;
  return child;
}
async function waitForHealth() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://localhost:${PORT}/api/health`)).status < 600) return true; } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  console.log('Compliance Master acceptance — booting server on port ' + PORT + '…\n');
  const foreign = (await db.query(`SELECT COUNT(*)::int AS n FROM compliance_items WHERE created_by_name IS NULL OR created_by_name NOT LIKE 'Compliance Test %'`)).rows[0].n;
  if (foreign && process.env.ACCEPT_COMPLIANCE_FORCE !== '1') {
    console.error(`Refusing: this database already holds ${foreign} compliance records this script did not create. Run it against a test database (or set ACCEPT_COMPLIANCE_FORCE=1).`);
    process.exit(1);
  }
  await cleanup();
  await seedUsers();
  firstRunId = ((await db.query('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM compliance_reminder_runs')).rows[0]).n;

  const useReal = fs.existsSync(REAL);
  const workbook = useReal ? fs.readFileSync(REAL) : await buildWorkbook();
  const wbName = useReal ? path.basename(REAL) : 'synthetic-compliance-master.xlsx';
  console.log(`Workbook: ${useReal ? 'REAL — ' + REAL : 'synthetic (test/fixtures/compliance-workbook.js)'}\n`);

  const child = startServer();
  try {
    if (!(await waitForHealth())) { console.error('Server did not come up.\n' + child.output()); process.exit(1); }
    const T = {};
    for (const [k, u] of Object.entries(USERS)) {
      const r = await api('POST', '/auth/login', { body: { username: u.username, password: PW } });
      if (r.status !== 200) throw new Error(`login ${u.username}: ${r.status} ${r.text}`);
      T[k] = r.body.token;
    }

    /* ══ A. Import ═════════════════════════════════════════════════════ */
    console.log('A. Import:');
    let r = await upload('/compliance/import/preview', { token: T.md, file: workbook, name: wbName });
    check('only an administrator can import (md → 403)', r.status === 403, r.status);
    r = await upload('/compliance/import/preview', { token: T.admin, file: workbook, name: wbName });
    check('preview 200', r.status === 200, r.text);
    const preview = r.body || {};
    const N = (preview.rows || []).length;
    check(`every non-blank row reconciled (${JSON.stringify(Object.fromEntries(Object.entries(preview.reconciliation || {}).map(([k, v]) => [k, v.balanced])))})`,
      Object.values(preview.reconciliation || {}).every(v => v.balanced));
    check(`preview plans ${N} new records and nothing else`, preview.counts && preview.counts.new === N && !preview.counts.update && !preview.counts.kept, JSON.stringify(preview.counts));
    check('the honest view: stale "Active" rows show Overdue', (preview.statusTotals || {}).overdue > 0, JSON.stringify(preview.statusTotals));
    if (useReal) check('real workbook: 203 records', N === 203, N);
    r = await upload('/compliance/import/commit', { token: T.admin, file: workbook, name: wbName, fields: { expectedSha256: 'f'.repeat(64) } });
    check('commit refuses a file that is not the one previewed (409)', r.status === 409, r.status);
    r = await upload('/compliance/import/commit', { token: T.admin, file: workbook, name: wbName, fields: { expectedSha256: preview.sha256 } });
    check('commit 200', r.status === 200, r.text);
    check(`commit created ${N}`, r.body && r.body.counts && r.body.counts.new === N, JSON.stringify(r.body && r.body.counts));
    const dbCount = (await db.query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE verified_at IS NULL)::int AS unverified FROM compliance_items`)).rows[0];
    check(`${N} rows in compliance_items, all unverified`, dbCount.n === N && dbCount.unverified === N, JSON.stringify(dbCount));

    r = await upload('/compliance/import/preview', { token: T.admin, file: workbook, name: wbName });
    check('re-import plans updates only, no duplicates', r.body && r.body.counts.new === 0 && r.body.counts.update === N, JSON.stringify(r.body && r.body.counts));

    /* ══ B. Read & access ══════════════════════════════════════════════ */
    console.log('\nB. Dashboard, register and access:');
    r = await api('GET', '/compliance/summary', { token: T.admin });
    const sum = r.body || {};
    check('summary 200', r.status === 200, r.text);
    const pivotTotal = (sum.pivot && sum.pivot.rows || []).reduce((a, x) => a + x.total, 0);
    check(`tiles.total (${sum.tiles && sum.tiles.total}) = pivot total (${pivotTotal}) = records (${N})`, sum.tiles && sum.tiles.total === N && pivotTotal === N);
    const items = await api('GET', '/compliance/items?limit=500', { token: T.admin });
    const recount = {};
    for (const it of items.body.rows) recount[it.status] = (recount[it.status] || 0) + 1;
    check('pivot status totals = an independent recount of the register',
      ['active', 'due', 'overdue', 'undated', 'inactive'].every(s => (recount[s] || 0) === sum.pivot.totals[s]),
      JSON.stringify({ recount, totals: sum.pivot.totals }));
    r = await api('GET', '/compliance/summary', { token: T.pmOfficer });
    check('a department user is scoped to its own department', r.body && r.body.scope === 'pm' && r.body.pivot && r.body.pivot.rows.every(x => x.key === 'pm'), r.text);
    const pmRows = items.body.rows.filter(i => i.owner_role === 'pm');
    const pmItem = pmRows.find(i => i.kind === 'validity' && i.status === 'overdue') || pmRows[0];
    r = await api('GET', `/compliance/items/${pmItem.id}`, { token: T.eiHod });
    check("another department's record is 404, not 403", r.status === 404, r.status);
    r = await api('GET', `/compliance/items/${pmItem.id}`, { token: T.mgmt });
    check('management can read any record', r.status === 200, r.status);
    r = await api('PATCH', `/compliance/items/${pmItem.id}`, { token: T.mgmt, body: { remarks: 'x', expectedUpdatedAt: new Date().toISOString() } });
    check('management cannot write (403)', r.status === 403, r.status);
    r = await api('GET', '/compliance/items');
    check('no token → 401', r.status === 401, r.status);

    /* ══ C. One record ═════════════════════════════════════════════════ */
    console.log('\nC. Editing and verifying:');
    let detail = (await api('GET', `/compliance/items/${pmItem.id}`, { token: T.pmSenior })).body;
    r = await api('PATCH', `/compliance/items/${pmItem.id}`, { token: T.pmOfficer, body: { remarks: 'officer edit', expectedUpdatedAt: detail.item.updated_at } });
    check('an officer cannot edit core fields (403)', r.status === 403, r.status);
    r = await api('PATCH', `/compliance/items/${pmItem.id}`, { token: T.pmSenior, body: { remarks: 'stale', expectedUpdatedAt: '2001-01-01T00:00:00.000Z' } });
    check('a stale edit is refused with 409', r.status === 409, r.status);
    r = await api('PATCH', `/compliance/items/${pmItem.id}`, { token: T.pmSenior, body: { remarks: 'Checked against the OSHA file', criticality: 'high', expectedUpdatedAt: detail.item.updated_at } });
    check('a senior officer edits (200)', r.status === 200 && r.body.item.remarks === 'Checked against the OSHA file', r.text);
    r = await api('POST', `/compliance/items/${pmItem.id}/verify`, { token: T.admin });
    check('admin cannot verify a department\'s record (403)', r.status === 403, r.status);
    r = await api('POST', `/compliance/items/${pmItem.id}/verify`, { token: T.pmSenior });
    check('the department\'s senior officer verifies (200)', r.status === 200 && !!r.body.item.verified_at, r.text);
    const hist = (await api('GET', `/compliance/items/${pmItem.id}/history`, { token: T.pmOfficer })).body.history.map(h => h.action);
    check('history records imported → edited → verified', ['imported', 'edited', 'verified'].every(a => hist.includes(a)), hist.join(','));

    /* ══ D. Documents ══════════════════════════════════════════════════ */
    console.log('\nD. Documents & versions:');
    const v1 = pdf('v1 ' + Date.now());
    r = await upload(`/compliance/items/${pmItem.id}/documents`, { token: T.pmOfficer, file: v1, name: 'OSHA certificate 2026.pdf', type: 'application/pdf', fields: { doc_type: 'certificate', valid_from: today(), valid_to: '2027-12-31' } });
    check('an officer uploads the renewed certificate (201)', r.status === 201, r.text);
    check('the upload IS the renewal: record now in date', r.body && r.body.item.valid_to === '2027-12-31' && ['active', 'due'].includes(r.body.item.status), JSON.stringify(r.body && r.body.item && [r.body.item.valid_to, r.body.item.status]));
    const doc1 = r.body && r.body.document;
    r = await upload(`/compliance/items/${pmItem.id}/documents`, { token: T.pmOfficer, file: pdf('fake'), name: 'photo.png', type: 'image/png', fields: { doc_type: 'other' } });
    check('a file whose contents do not match its extension is refused (400)', r.status === 400, r.text);
    r = await upload(`/compliance/items/${pmItem.id}/documents`, { token: T.pmOfficer, file: pdf('v2'), name: 'OSHA covering letter.pdf', type: 'application/pdf', fields: { doc_type: 'other' } });
    check('a second upload is version 2', r.status === 201 && r.body.document.version_no === 2, r.text);
    const doc2 = r.body && r.body.document;
    const docs = (await api('GET', `/compliance/items/${pmItem.id}/documents`, { token: T.pmOfficer })).body.documents;
    check('versions listed newest first, both kept', docs.length === 2 && docs[0].version_no === 2 && docs[1].version_no === 1, JSON.stringify(docs.map(d => d.version_no)));
    r = await api('GET', `/compliance/documents/${doc1.id}/download`, { token: T.pmOfficer, raw: true });
    check('download is byte-identical (sha256)', r.status === 200 && sha(r.buf) === sha(v1), r.status);
    check('download is an attachment, never cached', /attachment/.test(r.headers.get('content-disposition') || '') && /no-store/.test(r.headers.get('cache-control') || ''));
    r = await api('GET', `/compliance/documents/${doc1.id}/download`, { token: T.eiHod, raw: true });
    check("another department cannot download it (404)", r.status === 404, r.status);
    r = await api('GET', `/compliance/documents/${doc1.id}/download`, { raw: true });
    check('no token → 401', r.status === 401, r.status);
    r = await api('POST', `/compliance/documents/${doc2.id}/retract`, { token: T.pmOfficer, body: { reason: 'Uploaded to the wrong record' } });
    check('an uploader can retract their own upload within 24 h', r.status === 200, r.text);
    const after = (await api('GET', `/compliance/items/${pmItem.id}/documents`, { token: T.pmOfficer })).body.documents;
    check('a retracted version is kept and marked, history never shrinks', after.length === 2 && !!after.find(d => d.id === doc2.id).retracted_at);

    /* ══ E. Batch renew ════════════════════════════════════════════════ */
    console.log('\nE. Batch renewal:');
    const others = pmRows.filter(i => i.kind === 'validity' && i.id !== pmItem.id).slice(0, 2);
    if (others.length === 2) {
      const cert = pdf('batch ' + Date.now());
      r = await upload('/compliance/items/batch-renew', { token: T.pmSenior, file: cert, name: 'TBS batch certificate.pdf', type: 'application/pdf',
        fields: { ids: others.map(o => o.id), valid_from: today(), valid_to: '2027-10-07' } });
      check('two records renewed with one certificate', r.status === 200 && r.body.renewed === 2, r.text);
      const blobs = (await db.query('SELECT COUNT(*)::int AS n FROM compliance_blobs WHERE sha256 = $1', [sha(cert)])).rows[0].n;
      const ds = (await db.query('SELECT COUNT(*)::int AS n FROM compliance_documents WHERE blob_sha256 = $1', [sha(cert)])).rows[0].n;
      check('stored once, attached twice', blobs === 1 && ds === 2, `${blobs} blob(s), ${ds} documents`);
    } else check('two more PM records to batch-renew', false);
    r = await upload('/compliance/items/batch-renew', { token: T.eiHod, fields: { ids: [pmItem.id], valid_to: '2027-01-01' } });
    check("a department cannot batch-renew another department's records (403)", r.status === 403, r.status);

    /* ══ F. Filings and reviews ════════════════════════════════════════ */
    console.log('\nF. Filings and reviews:');
    const vat = items.body.rows.find(i => i.owner_role === 'finance' && i.kind === 'recurring' && /VAT PAYMENT/i.test(i.title));
    if (vat) {
      const d1 = (await api('GET', `/compliance/items/${vat.id}`, { token: T.finSenior })).body;
      const open = d1.periods.find(p => p.status === 'open');
      check('the VAT obligation has an open monthly instance', !!open, JSON.stringify(d1.periods.map(p => [p.period_key, p.status])));
      if (open) {
        r = await upload(`/compliance/items/${vat.id}/periods/${open.id}/done`, { token: T.finSenior, file: pdf('vat receipt'), name: 'VAT receipt.pdf', type: 'application/pdf', fields: { done_on: today(), reference: 'TRA-ACK-123' } });
        check('marking the instance filed (with the receipt) succeeds', r.status === 200, r.text);
        const d2 = (await api('GET', `/compliance/items/${vat.id}`, { token: T.finSenior })).body;
        check('…and the next instance is open', d2.periods.some(p => p.status === 'done' && p.id === open.id) && d2.periods.some(p => p.status === 'open'), JSON.stringify(d2.periods.map(p => [p.period_key, p.status])));
      }
    } else check('a VAT obligation exists in the workbook', false);
    const cond = items.body.rows.find(i => i.owner_role === 'mining' && i.kind === 'condition' && i.condition_result === 'not_complied');
    if (cond) {
      check('a "Not complied" condition is Overdue', cond.status === 'overdue', cond.status);
      r = await upload(`/compliance/items/${cond.id}/assessments`, { token: T.minSenior, fields: { result: 'complied', assessed_on: today(), note: 'Verified on site' } });
      check('recording a "Complied" review clears it', r.status === 200 && r.body.item.status === 'active', r.text);
    } else check('a "Not complied" mining condition exists', false);

    /* ══ G. Reminders ══════════════════════════════════════════════════ */
    console.log('\nG. Reminders (jsonTransport):');
    r = await api('PUT', '/compliance/settings', { token: T.mgmt, body: { reminders_enabled: true } });
    check('management cannot switch reminders on (403)', r.status === 403, r.status);
    r = await api('PUT', '/compliance/settings', { token: T.md, body: { reminders_enabled: true } });
    check('the MD switches reminders on', r.status === 200 && r.body.settings.reminders_enabled === true, r.text);
    // A verified, overdue PM record whose responsible person has an email.
    const target = pmRows.find(i => i.kind === 'validity' && i.status === 'overdue' && i.id !== pmItem.id && !others.some(o => o.id === i.id) && i.direct.length);
    if (target) {
      const contactId = target.direct[0].contactId;
      r = await api('PATCH', `/compliance/contacts/${contactId}`, { token: T.pmSenior, body: { email: 'rawat.test@lakecement.co.tz' } });
      check('a senior officer fills in a missing email', r.status === 200, r.text);
      r = await api('PATCH', `/compliance/contacts/${contactId}`, { token: T.pmSenior, body: { email: 'someone.else@lakecement.co.tz' } });
      check('…but cannot change an existing one (403)', r.status === 403, r.status);
      const ex = (await db.query("SELECT id FROM compliance_contacts WHERE LOWER(name) = 'pavan gandhi'")).rows[0];
      if (ex) {
        r = await api('PUT', '/compliance/settings/head-recipients', { token: T.md, body: { heads: [{ contact_id: ex.id, label: 'Unit Head' }] } });
        check('the MD sets the central Head list', r.status === 200, r.text);
      }
      r = await api('GET', '/compliance/reminders/preview', { token: T.md });
      check('the dry-run preview answers and writes nothing', r.status === 200 && r.body.ok && (await db.query('SELECT COUNT(*)::int AS n FROM compliance_notifications')).rows[0].n === 0, r.text);
      const ver = await api('POST', `/compliance/items/${target.id}/verify`, { token: T.pmSenior });
      check('the target record is verified', ver.status === 200);
      r = await api('POST', '/compliance/reminders/run', { token: T.admin, body: {} });
      const st = r.body && r.body.stats || {};
      check('run 200', r.status === 200, r.text);
      check(`unverified records are held, not mailed (${(st.byStatus || {}).held_unverified || 0} held)`, ((st.byStatus || {}).held_unverified || 0) > 0, JSON.stringify(st.byStatus));
      check(`at least one reminder email sent (${st.emailsSent})`, st.emailsSent >= 1, JSON.stringify(st));
      const sent = (await db.query(`SELECT status, recipient_email FROM compliance_notifications WHERE item_id = $1 AND audience = 'direct'`, [target.id])).rows;
      check('the verified record\'s responsible person was sent the reminder', sent.some(x => x.status === 'sent' && x.recipient_email === 'rawat.test@lakecement.co.tz'), JSON.stringify(sent));
      const log = (await db.query(`SELECT subject, sent FROM compliance_mail_log WHERE recipient_email = 'rawat.test@lakecement.co.tz' ORDER BY id DESC LIMIT 1`)).rows[0];
      check('the email carries the briefed subject', log && log.sent && /^Compliance (Renewal )?Reminder/.test(log.subject), JSON.stringify(log));
      check(`run within budget: ${r.body.durationMs} ms, heap +${r.body.heapDeltaKb} KB`, r.body.durationMs < 10000 && r.body.heapDeltaKb < 15 * 1024);
      r = await api('POST', '/compliance/reminders/run', { token: T.admin, body: {} });
      check('a second run the same day sends nothing new (exactly once)', r.body && r.body.stats.emailsSent === 0 && r.body.stats.created === 0, JSON.stringify(r.body && r.body.stats));
      r = await api('POST', '/compliance/reminders/run', { token: T.md, body: {} });
      check('only an administrator runs the job by hand (md → 403)', r.status === 403, r.status);
    } else check('an overdue PM record with a responsible person exists', false);

    /* ══ H. Extras ═════════════════════════════════════════════════════ */
    console.log('\nH. Counts, export, KPI suggestion, health:');
    r = await api('GET', '/compliance/counts', { token: T.pmOfficer });
    check('counts answer for a department user', r.status === 200 && typeof r.body.overdue === 'number', r.text);
    r = await api('GET', '/approvals/counts', { token: T.pmOfficer });
    check('the sidebar counts carry the compliance figure without changing the approvals total', r.status === 200 && r.body.compliance && typeof r.body.compliance.overdue === 'number', r.text);
    r = await api('GET', '/compliance/items/export.xlsx', { token: T.pmSenior, raw: true });
    check('Excel export', r.status === 200 && r.buf.slice(0, 2).toString() === 'PK' && /spreadsheetml/.test(r.headers.get('content-type') || ''), r.status);
    const ym = today().slice(0, 7).split('-');
    r = await api('GET', `/compliance/kpi-suggestion/mines/${+ym[0]}/${+ym[1]}`, { token: T.minSenior });
    check('KPI suggestion for the Quarry is a percentage', r.status === 200 && typeof r.body.value === 'number', r.text);
    r = await api('GET', `/compliance/kpi-suggestion/packing/${+ym[0]}/${+ym[1]}`, { token: T.minSenior });
    check('…and null (never 0 or 100) for a department with no obligations', r.status === 200 && r.body.value === null, r.text);
    const h = await fetch(`http://localhost:${PORT}/api/health`).then(x => x.json());
    check('/api/health reports the reminder job', h.checks && h.checks.compliance && typeof h.checks.compliance.status === 'string', JSON.stringify(h.checks && h.checks.compliance));
  } finally {
    child.kill();
  }

  await cleanup();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try { await cleanup(); await db.end(); } catch { /* best effort */ }
  process.exit(1);
});
