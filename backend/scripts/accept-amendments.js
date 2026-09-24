/*
  scripts/accept-amendments.js — correction requests, against a live server.

  Proves what unit tests cannot: real rows, real transactions, real HTTP.

    A. the request      who may ask, what they may ask about, one open at a time
    B. the decision     separation of duties, scoping, decline, withdraw
    C. the window       a grant snapshots the report and CHANGES NOTHING ELSE —
                        the day keeps counting in the KPIs while it is open
    D. inside a window  autosave and Save Draft land in place without touching
                        the status; a submission closes it and re-enters approval
    E. the sweeper      a window that closes unused restores the grant-time
                        figures, and keeps what was typed
    F. the trail        every step is an audit row and a revision

  The through-line is C. A correction that quietly removed the day from the
  dashboards while it was open would have been worse than no correction at all.

  Cleans up after itself. Exits 0 only if all checks pass.
  Usage: npm run accept:amendments
*/

require('../config/env');
const { spawn } = require('child_process');
const path      = require('path');
const bcrypt    = require('bcryptjs');
const db        = require('../db');

const PORT = process.env.ACCEPT_PORT || 5923;
const BASE = `http://localhost:${PORT}/api`;
const PW   = 'Accept@89012';

/* level matters here: officer/senior submit and need sign-off, an HOD
   self-certifies and is the approver of their own department's forms. */
const USERS = {
  officer: { username: 'am_officer', role: 'production', level: 'officer' },
  hod:     { username: 'am_hod',     role: 'production', level: 'hod' },
  hod2:    { username: 'am_hod2',    role: 'production', level: 'hod' },
  admin:   { username: 'am_admin',   role: 'admin',      level: 'hod' },
  pm:      { username: 'am_pm',      role: 'pm',         level: 'hod' },
  other:   { username: 'am_other',   role: 'logistics',  level: 'officer' },
};
const NAMES = Object.values(USERS).map(u => u.username);

/* Sandbox: August 1999, far outside any real record_date. */
const D = n => `1999-08-${String(n).padStart(2, '0')}`;
const RANGE = ["1999-08-01", "1999-08-31"];

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

async function loginToken(username) {
  const r = await api('POST', '/auth/login', { body: { username, password: PW } });
  if (r.status !== 200) throw new Error(`login ${username}: ${r.status}`);
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
    `, [u.username, hash, 'Amend Test ' + u.username, u.role, u.level]);
  }
}

async function cleanup() {
  /* By username AND by sandbox date. The expiry sweeper writes its audit rows
     as 'system' (no user id, no test username), so a cleanup keyed only on the
     test users leaks them — and the next run then finds two of them and fails a
     count that was correct. Real audit rows never carry a 1999 date. */
  await db.query(
    `DELETE FROM audit_log WHERE username = ANY($1)
        OR user_id IN (SELECT id FROM users WHERE username = ANY($1))
        OR record_date BETWEEN $2 AND $3`, [NAMES, RANGE[0], RANGE[1]]);
  /* report_amendments and report_revisions: like report_revisions, an amendment
     is permanent in production; an acceptance run is the one exception. Scoped
     to the sandbox month, so a real one can never be caught. */
  await db.query('DELETE FROM report_amendments WHERE record_date BETWEEN $1 AND $2', RANGE);
  await db.query('DELETE FROM report_revisions  WHERE record_date BETWEEN $1 AND $2', RANGE);
  await db.query('DELETE FROM daily_reports     WHERE record_date BETWEEN $1 AND $2', RANGE);
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
const report = (d, form = 'production') =>
  one('SELECT status, approved_by, data, updated_by FROM daily_reports WHERE form_type = $1 AND record_date = $2', [form, d]);
const amendmentRow = id => one('SELECT * FROM report_amendments WHERE id = $1', [id]);
const revisions = (d, form = 'production') =>
  db.query('SELECT * FROM report_revisions WHERE form_type = $1 AND record_date = $2 ORDER BY revision', [form, d]).then(r => r.rows);
const audits = (action, d) =>
  db.query('SELECT * FROM audit_log WHERE action = $1 AND record_date = $2', [action, d]).then(r => r.rows);

async function main() {
  console.log('Amendments acceptance — booting server on port ' + PORT + '…\n');
  await cleanup();                                  // a crashed earlier run must not poison this one
  await seedUsers();
  const child = startServer();

  try {
    if (!(await waitForHealth())) {
      console.error('Server did not come up.\n--- output ---\n' + child.output());
      process.exit(1);
    }

    const T = {};
    for (const [k, u] of Object.entries(USERS)) T[k] = await loginToken(u.username);
    const id = k => one('SELECT id FROM users WHERE username = $1', [USERS[k].username]).then(r => r.id);
    const UID = { officer: await id('officer'), hod: await id('hod'), hod2: await id('hod2') };

    const submit = (tok, date, data, extra = {}) =>
      api('POST', '/reports/production', { token: tok, body: { date, data, status: 'submitted', ...extra } });
    const request = (tok, date, reason = 'Kiln tonnage was keyed from the wrong shift sheet', extra = {}) =>
      api('POST', `/amendments/production/${date}`, { token: tok, body: { reason, ...extra } });
    const grant = (tok, date, aid, body = {}) =>
      api('POST', `/amendments/production/${date}/${aid}/grant`, { token: tok, body });
    const decline = (tok, date, aid, note) =>
      api('POST', `/amendments/production/${date}/${aid}/decline`, { token: tok, body: { note } });
    const withdraw = (tok, date, aid) =>
      api('POST', `/amendments/production/${date}/${aid}/withdraw`, { token: tok, body: {} });

    /* ── seed: an approved day and a pending day ── */
    console.log('Seed:');
    let r = await submit(T.hod, D(10), { kiln_prod_mt: 2000, clinker_stock_mt: 500 });
    check('an HOD submission self-certifies as approved', r.status === 200 && (await report(D(10))).status === 'approved',
      JSON.stringify(r.body));
    r = await submit(T.officer, D(11), { kiln_prod_mt: 1900 });
    check('an officer submission lands pending_approval', r.status === 200 && (await report(D(11))).status === 'pending_approval');
    r = await api('POST', '/reports/production', { token: T.officer, body: { date: D(12), data: { kiln_prod_mt: 1800 }, status: 'draft' } });
    check('an officer draft stays a draft', r.status === 200 && (await report(D(12))).status === 'draft');

    /* ══ A. THE REQUEST ═════════════════════════════════════════════════════ */
    console.log('\nA. The request:');

    r = await request(T.officer, D(10), 'too short');
    check('a reason under 10 characters is refused (400)', r.status === 400, `status ${r.status}`);
    check('…and nothing was written', (await one('SELECT count(*)::int n FROM report_amendments WHERE record_date = $1', [D(10)])).n === 0);

    r = await request(T.officer, D(12));
    check('a DRAFT is already editable — no correction request (409 REPORT_NOT_LOCKED)',
      r.status === 409 && r.body.code === 'REPORT_NOT_LOCKED', JSON.stringify(r.body));

    r = await request(T.officer, D(20));
    check('a day with no report has nothing to correct (404 NO_REPORT)', r.status === 404 && r.body.code === 'NO_REPORT');

    r = await request(T.other, D(10));
    check('a role that cannot submit production cannot ask about it (403)', r.status === 403, `status ${r.status}`);

    r = await request(T.officer, D(10));
    check('an officer can request a correction to an approved report (201)', r.status === 201 && r.body.amendment.status === 'requested',
      JSON.stringify(r.body));
    const a1 = r.body && r.body.amendment && r.body.amendment.id;
    check('…recording who asked, why, and what state the report was in',
      r.body.amendment.requested_by_name === 'Amend Test am_officer' && r.body.amendment.locked_status === 'approved'
      && /wrong shift sheet/.test(r.body.amendment.reason));

    r = await request(T.hod, D(10));
    check('a second request while one is open is refused, and returns the existing one (409)',
      r.status === 409 && r.body.code === 'AMENDMENT_ALREADY_OPEN' && r.body.amendment.id === a1, JSON.stringify(r.body));

    r = await request(T.officer, D(11), 'Trips keyed against the wrong truck register');
    check('a PENDING report can also be corrected (201)', r.status === 201, JSON.stringify(r.body));
    const a2 = r.body.amendment && r.body.amendment.id;

    r = await api('GET', `/reports/production/${D(10)}`, { token: T.officer });
    check('the day read carries its open request, so a form can show it', r.status === 200 && r.body.amendment
      && r.body.amendment.id === a1 && r.body.amendment.status === 'requested', JSON.stringify(r.body && r.body.amendment));
    r = await api('GET', `/reports/production/${D(12)}`, { token: T.officer });
    check('a day with no request carries amendment: null', r.body && r.body.amendment === null);

    /* ══ B. THE DECISION ════════════════════════════════════════════════════ */
    console.log('\nB. The decision:');

    r = await grant(T.officer, D(10), a1);
    check('an officer cannot grant (403 — not an approver)', r.status === 403, `status ${r.status}`);
    r = await grant(T.pm, D(10), a1);
    check("another department's HOD cannot grant (403)", r.status === 403, `status ${r.status}`);
    r = await grant(T.other, D(10), a1);
    check('an unrelated role cannot grant (403)', r.status === 403, `status ${r.status}`);

    // The HOD's own correction: they may ask, they may not decide.
    check('setup: an HOD report to correct', (await submit(T.hod, D(13), { kiln_prod_mt: 1700 })).status === 200);
    r = await request(T.hod, D(13), 'I entered last month\'s kiln figure by mistake');
    check('an HOD can request a correction to their own report (201)', r.status === 201, JSON.stringify(r.body));
    const a3 = r.body.amendment && r.body.amendment.id;
    r = await grant(T.hod, D(13), a3);
    check('…but cannot grant their own request (403 SEPARATION_OF_DUTIES)',
      r.status === 403 && r.body.code === 'SEPARATION_OF_DUTIES', JSON.stringify(r.body));
    r = await grant(T.hod2, D(13), a3, { hours: 2 });
    check('…another HOD of the same department can (200)', r.status === 200 && r.body.amendment.status === 'granted', JSON.stringify(r.body));
    check('…and the grant is attributed to them, not to the requester',
      (await amendmentRow(a3)).decided_by === UID.hod2 && (await amendmentRow(a3)).requested_by === UID.hod);

    // admin/md are the escalation: an admin can decide anyone's request (the
    // "their own" case is pinned by the unit test — admin cannot submit, so
    // cannot be a requester over HTTP).
    check('setup: a third approved day', (await submit(T.hod, D(14), { kiln_prod_mt: 1600 })).status === 200);
    r = await request(T.hod, D(14), 'Wrong day — this was Sunday\'s figure');
    const a4 = r.body.amendment && r.body.amendment.id;
    r = await grant(T.admin, D(14), a4, { hours: 1 });
    check('an admin can grant across departments (200)', r.status === 200, JSON.stringify(r.body));

    // Decline
    r = await decline(T.hod, D(11), a2, 'no');
    check('a decline needs a real reason — under 10 characters is refused (400)', r.status === 400);
    r = await decline(T.hod, D(11), a2, 'The weighbridge ticket matches the figure as submitted.');
    check('the owning HOD can decline, with a reason (200)', r.status === 200 && r.body.amendment.status === 'declined', JSON.stringify(r.body));
    check('…the report is still locked, untouched', (await report(D(11))).status === 'pending_approval');
    r = await api('GET', `/reports/production/${D(11)}`, { token: T.officer });
    check('the day read tells the requester what became of it (last_amendment: declined, with the reason)',
      r.body && r.body.amendment === null && r.body.last_amendment && r.body.last_amendment.status === 'declined'
      && /weighbridge ticket/.test(r.body.last_amendment.decision_note || ''), JSON.stringify(r.body && r.body.last_amendment));
    r = await grant(T.hod, D(11), a2);
    check('a decided request cannot be decided again (409 AMENDMENT_NOT_PENDING)',
      r.status === 409 && r.body.code === 'AMENDMENT_NOT_PENDING', JSON.stringify(r.body));
    r = await request(T.officer, D(11), 'Asking again with the delivery note attached');
    check('after a decline a fresh request is allowed', r.status === 201, JSON.stringify(r.body));
    const a5 = r.body.amendment && r.body.amendment.id;

    // Withdraw
    r = await withdraw(T.hod, D(11), a5);
    check('only the requester can withdraw (403)', r.status === 403 && r.body.code === 'NOT_REQUESTER', JSON.stringify(r.body));
    r = await withdraw(T.officer, D(11), a5);
    check('the requester can withdraw an undecided request (200)', r.status === 200 && r.body.amendment.status === 'withdrawn');

    // A wrong path must not decide someone else's request
    r = await grant(T.hod, D(15), a1);
    check('the id must belong to the date in the path (404)', r.status === 404, `status ${r.status}`);

    /* ══ scoping of the list ════════════════════════════════════════════════ */
    console.log('\nScoping:');
    r = await api('GET', '/amendments?state=open', { token: T.officer });
    check("an officer sees only their own requests", r.status === 200 && r.body.every(x => x.requested_by === UID.officer)
      && r.body.some(x => x.id === a1), JSON.stringify(r.body.map(x => [x.id, x.requested_by])));
    r = await api('GET', '/amendments?state=open', { token: T.hod2 });
    check("an HOD sees their department's queue, including others' requests",
      r.status === 200 && r.body.some(x => x.id === a1) && r.body.some(x => x.id === a3), JSON.stringify(r.body.map(x => x.id)));
    const queued = r.body.find(x => x.id === a1);
    check('…with the report\'s current figures, so the decision is not blind',
      queued && Array.isArray(queued.fields) && queued.fields.some(f => f.key === 'kiln_prod_mt' && +f.value === 2000),
      JSON.stringify(queued && queued.fields));
    r = await api('GET', '/amendments?state=open', { token: T.pm });
    check("another department's HOD sees none of it", r.status === 200 && !r.body.some(x => x.form_type === 'production'),
      JSON.stringify(r.body.map(x => x.id)));
    r = await api('GET', '/amendments?state=open', { token: T.admin });
    check('admin sees everything', r.status === 200 && r.body.some(x => x.id === a1) && r.body.some(x => x.id === a4));
    r = await api('GET', `/amendments/production/${D(10)}`, { token: T.other });
    check('a role with no stake cannot read the day\'s history (403)', r.status === 403, `status ${r.status}`);
    r = await api('GET', `/amendments/production/${D(10)}`, { token: T.officer });
    check("a submitter can read the day's history and revision trail (no figures)",
      r.status === 200 && Array.isArray(r.body.amendments) && Array.isArray(r.body.revisions)
      && r.body.revisions.every(v => !('prior_data' in v)), JSON.stringify(r.body).slice(0, 200));

    /* ══ C. THE WINDOW — the through-line ═══════════════════════════════════ */
    console.log('\nC. The window:');

    const before = await report(D(10));
    r = await grant(T.hod2, D(10), a1, { hours: 2, note: 'Go ahead — re-check against the shift sheet.' });
    check('the owning HOD (not the requester) grants a 2 h window (200)', r.status === 200 && r.body.amendment.status === 'granted', JSON.stringify(r.body));
    const secs = r.body.amendment.seconds_left;
    check('…seconds_left comes from the DATABASE clock and is ~2 h', secs > 7100 && secs <= 7200, `seconds_left=${secs}`);

    const after = await report(D(10));
    check("a grant DOES NOT CHANGE THE REPORT'S STATUS", after.status === 'approved' && before.status === 'approved');
    check('…nor who approved it', after.approved_by === before.approved_by && after.approved_by !== null);
    check('…nor a single figure', JSON.stringify(after.data) === JSON.stringify(before.data));

    /* The KPI engine reads status through REPORTED_STATUSES. If a grant had
       moved the day out of it, this figure would vanish mid-correction. Asked
       for THIS DAY ALONE — the monthly aggregate would stay non-null on the
       strength of the other days and never notice. */
    r = await api('GET', `/formula/daily?from=${D(10)}&to=${D(10)}`, { token: T.hod });
    const series = r.status === 200 && r.body['kiln-output'] && r.body['kiln-output'].series;
    check('the day STILL COUNTS in the KPI engine while its correction is open',
      Array.isArray(series) && series.some(p => p.date === D(10) && +p.value === 2000), JSON.stringify(series));

    const revs = await revisions(D(10));
    const grantRev = revs.find(v => v.action === 'AMENDMENT_GRANT');
    check('the grant snapshots the report as it stood (the restore point)',
      grantRev && grantRev.prior_data && +grantRev.prior_data.kiln_prod_mt === 2000 && grantRev.amendment_id === a1,
      JSON.stringify(grantRev));
    check('…and the amendment points at it', (await amendmentRow(a1)).baseline_revision_id === grantRev.id);

    r = await api('GET', `/reports/production/${D(10)}`, { token: T.officer });
    check('the day read now says the window is open, with the time left',
      r.body.amendment && r.body.amendment.status === 'granted' && r.body.amendment.seconds_left > 7000, JSON.stringify(r.body.amendment));

    /* ══ D. INSIDE THE WINDOW ═══════════════════════════════════════════════ */
    console.log('\nD. Inside the window:');

    r = await api('POST', '/reports/production', { token: T.officer, body: {
      date: D(10), data: { kiln_prod_mt: 1950 }, status: 'draft', autosave: true } });
    check('a background autosave is accepted inside the window (200)', r.status === 200, JSON.stringify(r.body));
    let mid = await report(D(10));
    check('…it lands in place, and the report is STILL approved', +mid.data.kiln_prod_mt === 1950 && mid.status === 'approved');

    r = await api('POST', '/reports/production', { token: T.officer, body: {
      date: D(10), data: { kiln_prod_mt: 1955, clinker_stock_mt: 480 }, status: 'draft' } });
    check('an explicit Save Draft is accepted inside the window (200)', r.status === 200, JSON.stringify(r.body));
    mid = await report(D(10));
    check('…and it KEEPS the status — it must not un-approve the day', mid.status === 'approved' && mid.approved_by === before.approved_by,
      `status=${mid.status}`);
    check('…the response tells the client the window is still open', r.body.amendment && r.body.amendment.status === 'granted');

    // the same person, on a locked day with NO window (D11: its request was
    // declined, then withdrawn), is still refused
    r = await submit(T.officer, D(11), { kiln_prod_mt: 1 });
    check('a DIFFERENT locked day (no window) is still refused (409 REPORT_LOCKED)', r.status === 409 && r.body.code === 'REPORT_LOCKED');
    check('…and its figure is intact', +(await report(D(11))).data.kiln_prod_mt === 1900);

    r = await submit(T.officer, D(10), { kiln_prod_mt: 1960, clinker_stock_mt: 480 });
    check('the officer submits the correction — no amendReason needed (200)', r.status === 200, JSON.stringify(r.body));
    const applied = await report(D(10));
    check('an officer resubmission RE-ENTERS APPROVAL (pending_approval, approver cleared)',
      applied.status === 'pending_approval' && applied.approved_by === null, `status=${applied.status}`);
    check('…with the corrected figure', +applied.data.kiln_prod_mt === 1960);
    check('the amendment is marked applied, in the same transaction', (await amendmentRow(a1)).status === 'applied'
      && (await amendmentRow(a1)).applied_at !== null);

    const revs2 = await revisions(D(10));
    const applyRev = revs2.find(v => v.action === 'FORM_SUBMIT' && v.amendment_id === a1);
    check('the submission wrote a revision holding the PRE-image, linked to the amendment',
      applyRev && applyRev.prior_data && +applyRev.prior_data.kiln_prod_mt === 1955 && /^Correction #\d+:/.test(applyRev.reason || ''),
      JSON.stringify(applyRev && { prior: applyRev.prior_data, reason: applyRev.reason }));
    check('…and changed_fields names exactly what moved', applyRev && applyRev.changed_fields.includes('kiln_prod_mt'));
    check('the amendment records which revision applied it', (await amendmentRow(a1)).applied_revision_id === applyRev.id);
    check('REPORT_AMEND_APPLY is in the audit trail', (await audits('REPORT_AMEND_APPLY', D(10))).length === 1);

    // the window is gone
    r = await api('POST', '/reports/production', { token: T.officer, body: {
      date: D(10), data: { kiln_prod_mt: 1 }, status: 'draft', autosave: true } });
    check('after it is applied, autosave is refused again (409)', r.status === 409, `status ${r.status}`);
    r = await submit(T.officer, D(10), { kiln_prod_mt: 1 });
    check('…and so is a plain resubmit (409 REPORT_LOCKED) — one window, one use', r.status === 409 && r.body.code === 'REPORT_LOCKED');
    check('…the corrected figure is intact', +(await report(D(10))).data.kiln_prod_mt === 1960);

    /* an HOD's own resubmission inside a window self-certifies (documented trade-off:
       the second signature was collected at the grant, from a different person) */
    r = await submit(T.hod, D(13), { kiln_prod_mt: 1710 });
    check('an HOD resubmits inside THEIR granted window (200)', r.status === 200, JSON.stringify(r.body));
    check('…and it self-certifies as approved, like any HOD submission',
      (await report(D(13))).status === 'approved' && +(await report(D(13))).data.kiln_prod_mt === 1710);

    /* ══ E. THE SWEEPER ═════════════════════════════════════════════════════ */
    console.log('\nE. The sweeper — a window that closes unused:');
    const { sweepExpired } = require('../services/reportAmendments');

    // D(14): admin granted a 1 h window (a4). The author autosaves half a correction, then walks away.
    const base14 = await report(D(14));
    r = await api('POST', '/reports/production', { token: T.hod, body: {
      date: D(14), data: { kiln_prod_mt: 999 }, status: 'draft', autosave: true } });
    check('setup: half a correction is autosaved into an approved report', r.status === 200 && +(await report(D(14))).data.kiln_prod_mt === 999);

    // Not due yet — nothing to sweep
    let swept = await sweepExpired();
    check('a window that has NOT expired is left alone', !swept.some(s => s.id === a4) && (await amendmentRow(a4)).status === 'granted');

    await db.query(`UPDATE report_amendments SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [a4]);
    swept = await sweepExpired();
    const mine = swept.find(s => s.id === a4);
    check('an expired window is swept', !!mine && mine.reverted === true, JSON.stringify(swept));
    const reverted = await report(D(14));
    check('the report is RESTORED to the figures it held at the grant', +reverted.data.kiln_prod_mt === +base14.data.kiln_prod_mt,
      `kiln_prod_mt=${reverted.data.kiln_prod_mt}`);
    check('…its status was never touched', reverted.status === 'approved');
    check('the amendment is closed as expired', (await amendmentRow(a4)).status === 'expired');
    r = await api('GET', `/reports/production/${D(14)}`, { token: T.hod });
    check('…and the day read says so (last_amendment: expired)', r.body && r.body.last_amendment && r.body.last_amendment.status === 'expired',
      JSON.stringify(r.body && r.body.last_amendment));

    const revs14 = await revisions(D(14));
    const revert = revs14.find(v => v.action === 'AMENDMENT_EXPIRE_REVERT');
    check('the revert is itself a revision that KEEPS the half-typed work',
      revert && +revert.prior_data.kiln_prod_mt === 999 && revert.actor_name === 'system', JSON.stringify(revert));
    check('REPORT_AMEND_EXPIRE is in the audit trail', (await audits('REPORT_AMEND_EXPIRE', D(14))).length === 1);

    r = await api('POST', '/reports/production', { token: T.hod, body: {
      date: D(14), data: { kiln_prod_mt: 5 }, status: 'draft', autosave: true } });
    check('after expiry, autosave is refused with a specific code (409 WINDOW_CLOSED)',
      r.status === 409 && r.body.code === 'WINDOW_CLOSED', JSON.stringify(r.body));
    r = await submit(T.hod, D(14), { kiln_prod_mt: 5 });
    check('…and a submit says the same (409 WINDOW_CLOSED)', r.status === 409 && r.body.code === 'WINDOW_CLOSED', JSON.stringify(r.body));

    swept = await sweepExpired();
    check('sweeping again is a no-op (idempotent)', !swept.some(s => s.id === a4));

    // An expired window where NOTHING changed must not write a revert.
    await submit(T.hod, D(16), { kiln_prod_mt: 1500 });
    r = await request(T.hod, D(16), 'Checking whether the figure needs to change');
    const a6 = r.body.amendment.id;
    await grant(T.hod2, D(16), a6, { hours: 1 });
    await db.query(`UPDATE report_amendments SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [a6]);
    swept = await sweepExpired();
    const untouched = swept.find(s => s.id === a6);
    check('an expired window with nothing typed reverts nothing', untouched && untouched.reverted === false, JSON.stringify(swept));
    check('…and writes no revert revision', !(await revisions(D(16))).some(v => v.action === 'AMENDMENT_EXPIRE_REVERT'));

    // An APPLIED window must never be swept, whatever its expires_at says.
    await db.query(`UPDATE report_amendments SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [a1]);
    swept = await sweepExpired();
    check('an APPLIED window is never swept, even with a past expires_at',
      !swept.some(s => s.id === a1) && (await amendmentRow(a1)).status === 'applied');

    /* ══ F. THE TRAIL ═══════════════════════════════════════════════════════ */
    console.log('\nF. The trail:');
    for (const [action, n] of [['REPORT_AMEND_REQUEST', 6], ['REPORT_AMEND_GRANT', 4], ['REPORT_AMEND_DECLINE', 1], ['REPORT_AMEND_WITHDRAW', 1]]) {
      const c = await one(
        `SELECT count(*)::int n FROM audit_log WHERE action = $1 AND record_date BETWEEN $2 AND $3`, [action, RANGE[0], RANGE[1]]);
      check(`${action}: ${n} audit rows`, c.n === n, `found ${c.n}`);
    }
    r = await api('GET', `/amendments/production/${D(10)}`, { token: T.hod });
    check("the day's history reads back: the amendment and the revisions that trace it",
      r.status === 200 && r.body.amendments.some(x => x.id === a1 && x.status === 'applied')
      && ['AMENDMENT_GRANT', 'FORM_SUBMIT'].every(a => r.body.revisions.some(v => v.action === a)));

    /* Deleting a user must not be blocked by the trail — the lesson of
       migration 025. audit_log has its own, older, unqualified FK to users (the
       reason every cleanup deletes it first), so that is cleared here too; what
       is under test is that report_amendments and report_revisions do NOT
       stand in the way. */
    await db.query('DELETE FROM audit_log WHERE username = $1', [USERS.officer.username]);
    /* daily_reports.submitted_by / updated_by are ALSO plain REFERENCES users(id)
       — the reason e2e's global-teardown deletes report rows by author before
       users. Also older than this work and out of its scope, so the sandbox
       reports go first; nothing references daily_reports, so the amendments and
       revisions under test are unaffected. */
    await db.query('DELETE FROM daily_reports WHERE record_date BETWEEN $1 AND $2', RANGE);
    await db.query('DELETE FROM users WHERE username = $1', [USERS.officer.username]).then(
      () => check('a user who requested and applied a correction can still be deleted (FKs are SET NULL)', true),
      e => check('a user who requested and applied a correction can still be deleted (FKs are SET NULL)', false, e.message));
    const orphan = await amendmentRow(a1);
    check('…and the amendment keeps their NAME after the id goes', orphan.requested_by === null
      && orphan.requested_by_name === 'Amend Test am_officer');
    const orphanRev = (await revisions(D(10))).find(v => v.action === 'FORM_SUBMIT' && v.amendment_id === a1);
    check('…and so does the revision', orphanRev && orphanRev.actor_id === null && orphanRev.actor_name === 'Amend Test am_officer');

  } finally {
    child.kill();
    await cleanup();
    await db.end();
  }

  console.log(`\n${failCount === 0 ? '✅' : '❌'} Amendments acceptance: ${passCount} passed, ${failCount} failed.`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Acceptance run crashed:', err);
  try { await cleanup(); await db.end(); } catch { /* best effort */ }
  process.exit(1);
});
