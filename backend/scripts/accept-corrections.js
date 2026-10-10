/*
  scripts/accept-corrections.js — the corrections flow, against a live server.

  accept-amendments.js already holds the correction-request rules for one day
  (separation of duties, the window, the sweeper). This holds what was added
  on 2026-10-10 so that the plant can actually FIND and USE that flow, and so
  that the other locked, hand-entered data — a submitted KPI month — has one:

    A. the day picker     GET /api/amendments/days/:form — a month of reported
                          days, who signed them, how many figures are non-zero
                          (a report approved with every field at zero is the
                          case that started this), and their correction state
    B. a run of bad days  several days asked for at once, granted at once, and
                          each corrected through its own window
    C. the self-certifier the shared department login that approves its own
                          reports cannot grant its own request; admin can
    D. the counts         GET /api/approvals/counts — what the sidebar shows an
                          approver, and the window it shows the requester
    E. KPI months         a submitted month: ask, decline, withdraw, reopen —
                          and the figures as they stood are kept

  Sandbox: July 1998 for daily reports, July 2000 for KPI months (the KPI routes refuse a year before 2000) — far outside any
  real record and clear of accept-amendments (Aug 1999) and e2e (Sep 1999).
  Cleans up after itself. Exits 0 only if all checks pass.
  Usage: npm run accept:corrections
*/

require('../config/env');
const { spawn } = require('child_process');
const path      = require('path');
const bcrypt    = require('bcryptjs');
const db        = require('../db');

const PORT = process.env.ACCEPT_PORT || 5927;
const BASE = `http://localhost:${PORT}/api`;
const PW   = 'Accept@89012';

const USERS = {
  officer: { username: 'cr_officer', role: 'cpp',        level: 'officer' },
  hod:     { username: 'cr_hod',     role: 'cpp',        level: 'hod' },
  admin:   { username: 'cr_admin',   role: 'admin',      level: 'hod' },
  md:      { username: 'cr_md',      role: 'md',         level: 'hod' },
  prodhod: { username: 'cr_prodhod', role: 'production', level: 'hod' },
  logi:    { username: 'cr_logi',    role: 'logistics',  level: 'officer' },
};
const NAMES = Object.values(USERS).map(u => u.username);

const D = n => `1998-07-${String(n).padStart(2, '0')}`;
const RANGE = ['1998-07-01', '1998-07-31'];
/* KPI routes validate year >= 2000, so the KPI sandbox is July 2000. */
const KY = 2000, KM = 7;

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
    `, [u.username, hash, 'Corr Test ' + u.username, u.role, u.level]);
  }
}

async function cleanup() {
  await db.query(
    `DELETE FROM audit_log WHERE username = ANY($1)
        OR user_id IN (SELECT id FROM users WHERE username = ANY($1))
        OR record_date BETWEEN $2 AND $3
        OR (form_type LIKE '%/${KY}/${KM}' AND action LIKE 'KPI_%')`, [NAMES, RANGE[0], RANGE[1]]);
  await db.query('DELETE FROM report_amendments WHERE record_date BETWEEN $1 AND $2', RANGE);
  await db.query('DELETE FROM report_revisions  WHERE record_date BETWEEN $1 AND $2', RANGE);
  await db.query('DELETE FROM daily_reports     WHERE record_date BETWEEN $1 AND $2', RANGE);
  await db.query('DELETE FROM kpi_reopen_requests WHERE year = $1', [KY]);
  await db.query('DELETE FROM kpi_submissions     WHERE year = $1', [KY]);
  await db.query('DELETE FROM kpi_monthly         WHERE year = $1', [KY]);
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
const report = d => one('SELECT status, approved_by, data FROM daily_reports WHERE form_type = $1 AND record_date = $2', ['cpp', d]);

async function seedReport(date, data, status, by, approvedBy) {
  await db.query(`
    INSERT INTO daily_reports (form_type, record_date, shift, data, submitted_by, submitted_at, status, approved_by, approved_at)
    VALUES ('cpp', $1, 'day', $2::jsonb, $3, NOW(), $4, $5, CASE WHEN $5::int IS NULL THEN NULL ELSE NOW() END)`,
    [date, JSON.stringify(data), by, status, approvedBy]);
}

async function main() {
  console.log('Corrections acceptance — booting server on port ' + PORT + '…\n');
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
    const UID = {};
    for (const k of Object.keys(USERS)) UID[k] = (await one('SELECT id FROM users WHERE username = $1', [USERS[k].username])).id;

    const days = (tok, from = RANGE[0], to = RANGE[1]) =>
      api('GET', `/amendments/days/cpp?from=${from}&to=${to}`, { token: tok });
    const request = (tok, date, reason = 'Every CPP figure was entered as zero by mistake') =>
      api('POST', `/amendments/cpp/${date}`, { token: tok, body: { reason } });
    const grant = (tok, date, id, hours = 24) =>
      api('POST', `/amendments/cpp/${date}/${id}/grant`, { token: tok, body: { hours } });
    const counts = tok => api('GET', '/approvals/counts', { token: tok }).then(r => r.body);

    /* ── seed: the 8 Oct case and its neighbours ── */
    // 1: approved by the self-certifying HOD login, every figure zero — the case reported
    await seedReport(D(1), { date: D(1), prepared_by: 'CPP', cpp_gross_gen: 0, cpp_net_export: '0', cpp_coal_consumed: '' }, 'approved', UID.hod, UID.hod);
    // 2: approved, real figures
    await seedReport(D(2), { date: D(2), cpp_gross_gen: 312000, cpp_net_export: '281000', cpp_remarks: 'normal' }, 'approved', UID.hod, UID.hod);
    // 3: a draft
    await seedReport(D(3), { cpp_gross_gen: 1 }, 'draft', UID.officer, null);
    // 4: approved with NO person's signature (an ERP-written row)
    await seedReport(D(4), { cpp_gross_gen: 5 }, 'approved', UID.hod, null);
    // 5: pending sign-off, with a value that would break a careless numeric cast
    await seedReport(D(5), { cpp_gross_gen: '1.2.3', cpp_net_export: 7 }, 'pending_approval', UID.officer, null);
    // 6, 7: two more all-zero approved days — a run of bad days
    await seedReport(D(6), { cpp_gross_gen: 0, cpp_net_export: 0 }, 'approved', UID.hod, UID.hod);
    await seedReport(D(7), { cpp_gross_gen: 0, cpp_net_export: 0 }, 'approved', UID.hod, UID.hod);

    /* ══ A. THE DAY PICKER ══════════════════════════════════════════════ */
    console.log('A. The day picker:');
    let r = await days(T.officer);
    check('a CPP officer reads the month (200)', r.status === 200, r.text.slice(0, 200));
    const byDate = Object.fromEntries((r.body.days || []).map(d => [d.date, d]));
    check('every reported day is listed, oldest first', (r.body.days || []).map(d => d.date).join() === [1, 2, 3, 4, 5, 6, 7].map(D).join());
    check('the all-zero day is visible as such: fields filled, none non-zero',
      byDate[D(1)] && byDate[D(1)].filled === 2 && byDate[D(1)].nonzero === 0, JSON.stringify(byDate[D(1)]));
    check('…`date`, `prepared_by` and blank strings are not counted as figures',
      byDate[D(1)] && byDate[D(1)].filled === 2);
    check('a real day counts its non-zero figures', byDate[D(2)] && byDate[D(2)].nonzero === 2, JSON.stringify(byDate[D(2)]));
    check('a malformed number ("1.2.3") does not 500 the month — it is just not non-zero',
      byDate[D(5)] && byDate[D(5)].nonzero === 1, JSON.stringify(byDate[D(5)]));
    check('who signed is returned, and an unsigned approved day says so',
      byDate[D(1)].human_signed === true && byDate[D(1)].approved_by_name === 'Corr Test cr_hod' && byDate[D(4)].human_signed === false);
    check('the officer may request, and is not the approver', r.body.can_request === true && r.body.you_approve === false
      && r.body.approver_role === 'cpp');
    check('no figures are returned — counts only', !JSON.stringify(r.body).includes('312000'));

    r = await days(T.hod);
    check('the CPP HOD is told they are the approver (so admin/MD decides their asks)', r.status === 200 && r.body.you_approve === true);
    r = await days(T.admin);
    check('admin reads it, and is not offered a request (cannot submit CPP)', r.status === 200 && r.body.can_request === false);
    r = await days(T.logi);
    check('a role with no stake in CPP is refused (403)', r.status === 403, `status ${r.status}`);
    r = await days(T.officer, '1998-01-01', '1998-07-31');
    check('a range over 92 days is refused (400)', r.status === 400, `status ${r.status}`);
    r = await days(T.officer, RANGE[1], RANGE[0]);
    check('from after to is refused (400)', r.status === 400);
    r = await api('GET', `/amendments/days/not-a-form?from=${RANGE[0]}&to=${RANGE[1]}`, { token: T.officer });
    check('an unknown form type is refused (400)', r.status === 400);
    r = await api('GET', `/amendments/cpp/${D(1)}`, { token: T.officer });
    check('the existing per-day read still answers beside the new route', r.status === 200 && Array.isArray(r.body.amendments));

    /* ══ B. A RUN OF BAD DAYS ════════════════════════════════════════════ */
    console.log('\nB. A run of bad days:');
    const hodBefore = await counts(T.hod);
    const ids = {};
    for (const d of [D(6), D(7)]) {
      r = await request(T.officer, d, 'Figures for this day were entered as zero — re-entering from the log sheet');
      check(`the officer asks for ${d} (201)`, r.status === 201, JSON.stringify(r.body));
      ids[d] = r.body && r.body.amendment && r.body.amendment.id;
    }
    r = await days(T.officer);
    check('the day picker shows both requests waiting',
      [D(6), D(7)].every(d => r.body.amendments.some(a => a.record_date === d && a.status === 'requested')));
    let hodNow = await counts(T.hod);
    check('the CPP HOD’s Approvals count rose by exactly two', hodNow.corrections === hodBefore.corrections + 2,
      `${hodBefore.corrections} -> ${hodNow.corrections}`);

    const offBefore = await counts(T.officer);
    check('an officer has nothing to approve: every approver count is 0',
      offBefore.reports === 0 && offBefore.corrections === 0 && offBefore.kpiReopens === 0 && offBefore.total === 0, JSON.stringify(offBefore));
    for (const d of [D(6), D(7)]) {
      r = await grant(T.hod, d, ids[d], 48);
      check(`the HOD grants ${d} (200)`, r.status === 200 && r.body.amendment.status === 'granted', JSON.stringify(r.body));
    }
    const offNow = await counts(T.officer);
    check('the officer now sees two windows open for them', offNow.myWindows === offBefore.myWindows + 2, JSON.stringify(offNow));
    hodNow = await counts(T.hod);
    check('…and they have left the HOD’s count', hodNow.corrections === hodBefore.corrections);

    for (const d of [D(6), D(7)]) {
      r = await api('POST', '/reports/cpp', { token: T.officer, body: { date: d, data: { cpp_gross_gen: 300100, cpp_net_export: 270050 } } });
      check(`the officer resubmits ${d} inside its window (200, back for sign-off)`,
        r.status === 200 && (await report(d)).status === 'pending_approval', JSON.stringify(r.body));
    }
    r = await days(T.officer);
    const d6 = r.body.days.find(x => x.date === D(6));
    check('the day picker now shows real figures, and the correction as applied',
      d6.nonzero === 2 && r.body.amendments.some(a => a.record_date === D(6) && a.status === 'applied'), JSON.stringify(d6));
    r = await api('POST', `/reports/cpp/${D(6)}/approve`, { token: T.hod, body: {} });
    check('the HOD signs the corrected day off', r.status === 200 && (await report(D(6))).status === 'approved');

    /* ══ C. THE SELF-CERTIFYING LOGIN ═══════════════════════════════════ */
    console.log('\nC. The self-certifying login:');
    r = await request(T.hod, D(1));
    check('the HOD login that approved the zero day can ask for its correction (201)', r.status === 201, JSON.stringify(r.body));
    const selfId = r.body && r.body.amendment && r.body.amendment.id;
    r = await grant(T.hod, D(1), selfId);
    check('…but cannot grant it (403 SEPARATION_OF_DUTIES)', r.status === 403 && r.body.code === 'SEPARATION_OF_DUTIES', JSON.stringify(r.body));
    const adminCounts = await counts(T.admin);
    check('admin’s Approvals count includes it', adminCounts.corrections >= 1);
    r = await grant(T.admin, D(1), selfId);
    check('admin grants it (200)', r.status === 200, JSON.stringify(r.body));
    r = await api('POST', '/reports/cpp', { token: T.hod, body: { date: D(1), data: { cpp_gross_gen: 298000, cpp_net_export: 266000, cpp_coal_consumed: 210 } } });
    check('the HOD re-enters the real figures; their submission self-certifies again',
      r.status === 200 && (await report(D(1))).status === 'approved' && Number((await report(D(1))).data.cpp_gross_gen) === 298000,
      JSON.stringify(r.body));
    const rev = await one(`SELECT prior_data FROM report_revisions WHERE form_type = 'cpp' AND record_date = $1 AND action = 'AMENDMENT_GRANT'`, [D(1)]);
    check('the zero figures are kept in the revision trail', rev && Number(rev.prior_data.cpp_gross_gen) === 0);

    /* ══ D. COUNTS SCOPING ═══════════════════════════════════════════════ */
    console.log('\nD. Counts scoping:');
    r = await api('GET', '/approvals/counts');
    check('the counts need a login (401)', r.status === 401);
    const prod = await counts(T.prodhod);
    r = await request(T.officer, D(2), 'Net export was typed against gross generation');
    check('a CPP request is filed', r.status === 201);
    const prod2 = await counts(T.prodhod);
    check('another department’s HOD does not see CPP requests in their count', prod2.corrections === prod.corrections);
    await api('POST', `/amendments/cpp/${D(2)}/${r.body.amendment.id}/withdraw`, { token: T.officer, body: {} });

    /* ══ E. KPI MONTHS ═══════════════════════════════════════════════════ */
    console.log('\nE. KPI months:');
    await db.query(`INSERT INTO kpi_monthly (department, year, month, kpi_key, target, actual, unit, updated_by)
                    VALUES ('powerplant', $1, $2, 'accept_gen', 9000, 10, 'MWh', $3),
                           ('powerplant', $1, $2, 'accept_plf', 80, 75, '%', $3)`, [KY, KM, UID.hod]);
    const kp = `/kpi/powerplant/${KY}/${KM}`;
    r = await api('POST', `${kp}/reopen-request`, { token: T.hod, body: { reason: 'Generation actual entered in kWh not MWh' } });
    check('a month that is not submitted cannot be asked for (409 NOT_LOCKED)', r.status === 409 && r.body.code === 'NOT_LOCKED', JSON.stringify(r.body));
    r = await api('POST', `${kp}/submit`, { token: T.hod });
    check('the HOD submits the month', r.status === 200, JSON.stringify(r.body));

    r = await api('POST', `${kp}/reopen-request`, { token: T.officer, body: { reason: 'Generation actual entered in kWh not MWh' } });
    check('an officer cannot ask (403 — only the department HOD files KPIs)', r.status === 403, `status ${r.status}`);
    r = await api('POST', `${kp}/reopen-request`, { token: T.prodhod, body: { reason: 'Generation actual entered in kWh not MWh' } });
    check('another department’s HOD cannot ask (403)', r.status === 403);
    r = await api('POST', `${kp}/reopen-request`, { token: T.hod, body: { reason: 'wrong' } });
    check('a reason under 10 characters is refused (400)', r.status === 400);
    r = await api('POST', `${kp}/reopen-request`, { token: T.admin, body: { reason: 'Admin tries to ask instead of reopening' } });
    check('admin is told to reopen directly (409 REOPEN_DIRECTLY)', r.status === 409 && r.body.code === 'REOPEN_DIRECTLY');

    const adminK0 = (await counts(T.admin)).kpiReopens;
    r = await api('POST', `${kp}/reopen-request`, { token: T.hod, body: { reason: 'Generation actual entered in kWh not MWh' } });
    check('the HOD asks for the month back (201)', r.status === 201 && r.body.request.status === 'requested', JSON.stringify(r.body));
    const q1 = r.body.request.id;
    r = await api('POST', `${kp}/reopen-request`, { token: T.hod, body: { reason: 'Second ask for the same month' } });
    check('one open request per month (409 REQUEST_ALREADY_OPEN, returns it)',
      r.status === 409 && r.body.code === 'REQUEST_ALREADY_OPEN' && r.body.request.id === q1);
    check('admin’s count shows it', (await counts(T.admin)).kpiReopens === adminK0 + 1);

    r = await api('GET', `${kp}/submission`, { token: T.hod });
    check('the submission state carries the open request (for the KPI page’s button)',
      r.body.status === 'submitted' && r.body.reopen_request && r.body.reopen_request.id === q1);
    r = await api('GET', '/kpi/submissions/powerplant?from=2000-07&to=2000-07', { token: T.hod });
    check('the month picker lists it: locked, 2 KPI rows, request waiting',
      r.status === 200 && r.body.length === 1 && r.body[0].status === 'submitted' && r.body[0].kpi_rows === 2
      && r.body[0].last_request && r.body[0].last_request.status === 'requested', r.text.slice(0, 300));
    r = await api('GET', `/kpi/submissions/powerplant?from=2000-07&to=2000-07`, { token: T.prodhod });
    check('another department’s HOD cannot read the month picker (403)', r.status === 403);
    r = await api('GET', '/kpi/reopen-requests', { token: T.hod });
    check('the HOD sees their department’s request', r.status === 200 && r.body.some(x => x.id === q1));
    r = await api('GET', '/kpi/reopen-requests', { token: T.prodhod });
    check('…another department’s HOD does not', r.status === 200 && !r.body.some(x => x.id === q1));

    r = await api('POST', `${kp}/reopen-request/${q1}/decline`, { token: T.hod, body: { note: 'HOD cannot decide their own ask' } });
    check('the HOD cannot decline (403 — admin/MD decide)', r.status === 403);
    r = await api('POST', `${kp}/reopen-request/${q1}/withdraw`, { token: T.prodhod, body: {} });
    check('someone else cannot withdraw it (403 NOT_REQUESTER)', r.status === 403 && r.body.code === 'NOT_REQUESTER');
    r = await api('POST', `${kp}/reopen-request/${q1}/decline`, { token: T.md, body: { note: 'short' } });
    check('a decline needs a reason (400)', r.status === 400);
    r = await api('POST', `${kp}/reopen-request/${q1}/decline`, { token: T.md, body: { note: 'The MWh figure matches the meter log; no change needed' } });
    check('the MD declines with a reason (200)', r.status === 200, JSON.stringify(r.body));
    r = await api('GET', `${kp}/submission`, { token: T.hod });
    check('…the HOD is told, with the reason, and the month stays locked',
      r.body.status === 'submitted' && !r.body.reopen_request && r.body.last_reopen_request
      && r.body.last_reopen_request.status === 'declined' && /meter log/.test(r.body.last_reopen_request.decision_note));
    r = await api('PUT', kp, { token: T.hod, body: [{ kpi_key: 'accept_gen', actual: 9 }] });
    check('the locked month still refuses an edit (409 KPI_PERIOD_LOCKED)', r.status === 409 && r.body.code === 'KPI_PERIOD_LOCKED');

    r = await api('POST', `${kp}/reopen-request`, { token: T.hod, body: { reason: 'Asking again, then thinking better of it' } });
    const q2 = r.body.request.id;
    r = await api('POST', `${kp}/reopen-request/${q2}/withdraw`, { token: T.hod, body: {} });
    check('the HOD can withdraw their own request (200)', r.status === 200);
    r = await api('POST', `${kp}/reopen-request/${q2}/withdraw`, { token: T.hod, body: {} });
    check('…once (409 NOT_PENDING)', r.status === 409 && r.body.code === 'NOT_PENDING');

    r = await api('POST', `${kp}/reopen-request`, { token: T.hod, body: { reason: 'Generation actual entered in kWh not MWh — 10 should be 10000' } });
    const q3 = r.body.request.id;
    r = await api('POST', `${kp}/reopen`, { token: T.admin, body: { reason: 'Granting the HOD request: unit error on generation' } });
    check('admin reopens the month (200) — granting the open request', r.status === 200 && r.body.request_id === q3 && r.body.snapshot_rows === 2,
      JSON.stringify(r.body));
    const g = await one('SELECT * FROM kpi_reopen_requests WHERE id = $1', [q3]);
    check('the request is granted, by admin, with the month’s figures snapshotted',
      g.status === 'granted' && g.decided_by === UID.admin && Array.isArray(g.snapshot)
      && g.snapshot.find(x => x.kpi_key === 'accept_gen' && Number(x.actual) === 10));
    r = await api('PUT', kp, { token: T.hod, body: [{ kpi_key: 'accept_gen', actual: 10000 }] });
    check('the HOD can now correct the figure (200)', r.status === 200, JSON.stringify(r.body));
    const after = await one(`SELECT actual FROM kpi_monthly WHERE department = 'powerplant' AND year = $1 AND month = $2 AND kpi_key = 'accept_gen'`, [KY, KM]);
    const kept = await one('SELECT snapshot FROM kpi_reopen_requests WHERE id = $1', [q3]);
    check('…and the figure management had read (10) is still on record', Number(after.actual) === 10000
      && kept.snapshot.find(x => x.kpi_key === 'accept_gen').actual == 10);
    r = await api('POST', `${kp}/submit`, { token: T.hod });
    check('the HOD submits it again — locked once more', r.status === 200
      && (await api('GET', `${kp}/submission`, { token: T.hod })).body.status === 'submitted');

    r = await api('POST', `${kp}/reopen`, { token: T.md, body: { reason: 'MD reopens directly to check a figure' } });
    check('a direct reopen with no request is recorded too (born granted, by the MD)', r.status === 200
      && (await one('SELECT status, requested_by FROM kpi_reopen_requests WHERE id = $1', [r.body.request_id])).requested_by === UID.md);

    const actions = (await db.query(`SELECT action FROM audit_log WHERE form_type = $1`, [`powerplant/${KY}/${KM}`])).rows.map(x => x.action);
    check('every step is in the audit trail',
      ['KPI_REOPEN_REQUEST', 'KPI_REOPEN_DECLINE', 'KPI_REOPEN_WITHDRAW', 'KPI_REOPEN', 'KPI_SUBMIT'].every(a => actions.includes(a)),
      actions.join(','));
  } finally {
    child.kill();
    await cleanup();
    await db.end();
  }

  console.log(`\n${failCount === 0 ? '✅' : '❌'} Corrections acceptance: ${passCount} passed, ${failCount} failed.`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Acceptance run crashed:', err);
  try { await cleanup(); await db.end(); } catch { /* best effort */ }
  process.exit(1);
});
