/*
  scripts/accept-phase6.js — Phase 6 acceptance tests (see docs/MASTER_BUILD_PROMPT.md).

  Proves monitoring & observability end-to-end:
    1. deep /api/health: db latency, disk space, backup state
    2. a server whose DB is unreachable reports 503/'down'
    3. /api/metrics: protected (401 anon), serves request/pool/submission
       metrics to admin JWT and to the static METRICS_TOKEN
    4. browser error reports land (anonymous + attributed) and appear in
       the admin summary
    5. summary endpoint is role-guarded
    6. watchdog: missed-entry alert fires (email pipeline + alerts table),
       and the same alert does NOT fire twice in one day (dedupe)
    7. watchdog with the DB down still EMAILS a health-down alert
       (scripts/watchdog-once.js against a dead DB port)
    8. structured request logs are being written to backend/logs/

  Cleans up after itself. Exits 0 only if all checks pass.
  Usage: npm run accept:phase6
*/

require('dotenv').config();
const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');
const bcrypt    = require('bcryptjs');
const db        = require('../db');

const PORT      = process.env.ACCEPT_PORT || 5906;
const DOWN_PORT = 5907;
const BASE      = `http://localhost:${PORT}/api`;
const PW        = 'Accept@67890';
const USERS     = { admin: 'p6_admin', production: 'p6_prod' };
const MTOKEN    = 'accept6-metrics-token';
const TEST_DATE = '1999-06-01'; // watchdog checks this day: kiln is missing
const KILN_DATE = '1999-06-02'; // a real kiln submission for the metrics counter

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
  try { json = JSON.parse(text); } catch { /* metrics text etc. */ }
  return { status: res.status, body: json, text };
}

async function loginToken(username) {
  const r = await api('POST', '/auth/login', { body: { username, password: PW } });
  if (r.status !== 200) throw new Error(`login ${username}: ${r.status}`);
  return r.body.token;
}

async function seedTestUsers() {
  const hash = await bcrypt.hash(PW, 6);
  for (const [role, username] of Object.entries(USERS)) {
    await db.query(`
      INSERT INTO users (username, password_hash, full_name, role, department, active, must_change_password)
      VALUES ($1, $2, $3, $4, 'TEST', true, false)
      ON CONFLICT (username) DO UPDATE SET
        password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = true,
        must_change_password = false, failed_attempts = 0, locked_until = NULL, token_version = 0
    `, [username, hash, 'Phase6 Test ' + username, role]);
  }
}

async function cleanup() {
  const names = Object.values(USERS);
  await db.query(
    `DELETE FROM audit_log
     WHERE username = ANY($1)
        OR user_id IN (SELECT id FROM users WHERE username = ANY($1))`, [names]);
  await db.query(`DELETE FROM daily_reports WHERE record_date BETWEEN '1999-06-01' AND '1999-06-30'`);
  await db.query(`DELETE FROM client_errors WHERE message LIKE 'ACCEPT6%'`);
  await db.query(`DELETE FROM alerts WHERE detail LIKE '%1999-06-01%'`);
  await db.query('DELETE FROM users WHERE username = ANY($1)', [names]);
}

function startServer(port, extraEnv) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: port, AUTH_RATE_LIMIT: '500', CLIENT_ERROR_RATE_LIMIT: '500',
      WATCHDOG_CRON: 'off',            // manual trigger only during tests
      DIGEST_TRANSPORT: 'json',
      ALERT_TO: 'ops@test.local',
      MISSED_ENTRY_FORMS: 'kiln',
      MISSED_ENTRY_CUTOFF: '00:00',    // always past the cutoff
      METRICS_TOKEN: MTOKEN,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.output = () => out;
  return child;
}

// 45s: the first boot after an npm install can be slow on Windows while
// the antivirus scans freshly written node_modules files.
async function waitFor(url, timeoutMs = 45000, acceptStatuses = [200]) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (acceptStatuses.includes(res.status)) return res;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

async function main() {
  console.log('Phase 6 acceptance — booting server on port ' + PORT + '…\n');
  await seedTestUsers();
  const child = startServer(PORT);

  try {
    if (!(await waitFor(`http://localhost:${PORT}/api/health`))) {
      console.error('Server did not come up.\n--- output ---\n' + child.output());
      process.exit(1);
    }

    const adminTok = await loginToken(USERS.admin);
    const prodTok  = await loginToken(USERS.production);

    // ── 1. Deep health ──────────────────────────────────────────
    const h = await api('GET', '/health');
    check('deep health: ok + db latency + disk free + backup state',
      h.status === 200 && h.body.status === 'ok' &&
      h.body.checks.db.ok === true && typeof h.body.checks.db.latency_ms === 'number' &&
      typeof h.body.checks.disk.free_gb === 'number' &&
      h.body.checks.backup === 'not_configured', JSON.stringify(h.body && h.body.status));

    // ── 2. DB down → 503 'down' ─────────────────────────────────
    const downChild = startServer(DOWN_PORT, { DB_PORT: '59999' });
    const downRes = await waitFor(`http://localhost:${DOWN_PORT}/api/health`, 15000, [503]);
    const downBody = downRes ? await downRes.json() : null;
    check('DB unreachable → /api/health returns 503 + status "down"',
      downRes && downRes.status === 503 && downBody.status === 'down' && downBody.checks.db.ok === false,
      downRes ? `status ${downRes.status}` : 'no 503 within 15s');
    downChild.kill();

    // ── 3. Metrics ──────────────────────────────────────────────
    await api('POST', '/reports/kiln', { token: prodTok, body: { date: KILN_DATE, data: { kiln_prod_mt: 1234 } } });

    const mAnon = await api('GET', '/metrics');
    check('metrics endpoint rejects anonymous (401)', mAnon.status === 401, `got ${mAnon.status}`);
    const mAdmin = await api('GET', '/metrics', { token: adminTok });
    check('metrics serve request/pool counters to admin JWT',
      mAdmin.status === 200 && mAdmin.text.includes('http_requests_total') &&
      mAdmin.text.includes('pg_pool_total_clients'), `status ${mAdmin.status}`);
    check('metrics count form submissions per form type',
      /form_submissions_total\{[^}]*form_type="kiln"[^}]*\}\s+[1-9]/.test(mAdmin.text));
    const mTok = await api('GET', '/metrics', { token: MTOKEN });
    check('static METRICS_TOKEN works for scrapers', mTok.status === 200 && mTok.text.includes('http_requests_total'),
      `got ${mTok.status}`);

    // ── 4. Client error reporting ───────────────────────────────
    const e1 = await api('POST', '/client-errors', { body: { message: 'ACCEPT6 anonymous boom', page: 'login.html' } });
    const e2 = await api('POST', '/client-errors', {
      token: prodTok,
      body: { message: 'ACCEPT6 attributed boom', page: 'kiln-form.html', source: 'kiln-form.html', line: 42, stack: 'Error: boom\n  at test' },
    });
    check('browser errors accepted (anonymous + attributed)',
      e1.status === 200 && e1.body.logged === true && e2.status === 200 && e2.body.logged === true);

    const sum = await api('GET', '/monitor/summary', { token: adminTok });
    const errs = (sum.body && sum.body.clientErrors) || [];
    check('errors appear in the admin summary with attribution',
      sum.status === 200 &&
      errs.some(e => e.message === 'ACCEPT6 anonymous boom' && e.username === null) &&
      errs.some(e => e.message === 'ACCEPT6 attributed boom' && e.username === USERS.production),
      `status ${sum.status}, ${errs.length} errors`);
    check('summary carries health + logins + overrides + alerts blocks',
      sum.body && sum.body.health && Array.isArray(sum.body.logins) &&
      Array.isArray(sum.body.overrides) && Array.isArray(sum.body.alerts) &&
      sum.body.logins.some(l => l.username === USERS.admin && l.action === 'LOGIN'));

    // ── 5. RBAC ─────────────────────────────────────────────────
    const sumProd = await api('GET', '/monitor/summary', { token: prodTok });
    check('monitor summary is admin/md/it-only (403 for production)', sumProd.status === 403, `got ${sumProd.status}`);

    // ── 6. Missed-entry alert + dedupe ──────────────────────────
    const w1 = await api('POST', '/monitor/watchdog/run', { token: adminTok, body: { date: TEST_DATE } });
    const fired = (w1.body && w1.body.fired) || [];
    check('watchdog fires missed-entry alert for kiln',
      w1.status === 200 && fired.some(a => a.kind === 'missed-entry:kiln'), JSON.stringify(fired.map(f => f.kind)));
    check('missed-entry alert is emailed (pipeline verified via jsonTransport)',
      w1.body.email && w1.body.email.sent === true && w1.body.email.transport === 'json' &&
      /kiln/.test(w1.body.email.message.html || ''), JSON.stringify(w1.body.email));

    const w2 = await api('POST', '/monitor/watchdog/run', { token: adminTok, body: { date: TEST_DATE } });
    check('same alert does not fire twice in one day (dedupe)',
      w2.status === 200 && !(w2.body.fired || []).some(a => a.kind === 'missed-entry:kiln') &&
      (w2.body.skipped || []).includes('missed-entry:kiln'), JSON.stringify(w2.body && w2.body.skipped));

    const alerts = await api('GET', '/monitor/alerts', { token: adminTok });
    check('fired alert recorded in the alerts table (emailed=true)',
      alerts.status === 200 && alerts.body.some(a => a.kind === 'missed-entry:kiln' && a.emailed === true));

    // ── 7. DB down → watchdog still emails health-down ──────────
    const wd = spawn(process.execPath, [path.join(__dirname, 'watchdog-once.js')], {
      env: { ...process.env, DB_PORT: '59999', DIGEST_TRANSPORT: 'json', ALERT_TO: 'ops@test.local' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let wdOut = '';
    wd.stdout.on('data', d => { wdOut += d; });
    wd.stderr.on('data', d => { wdOut += d; });
    await new Promise(resolve => wd.on('exit', resolve));
    const line = wdOut.split('\n').find(l => l.startsWith('WATCHDOG_RESULT '));
    const wdRes = line ? JSON.parse(line.slice('WATCHDOG_RESULT '.length)) : null;
    check('watchdog with DB down still emails a health-down alert',
      wdRes && wdRes.health.status === 'down' &&
      wdRes.fired.some(a => a.kind === 'health-down') && wdRes.email.sent === true,
      line ? undefined : 'no WATCHDOG_RESULT line:\n' + wdOut.slice(0, 400));

    // ── 8. Structured logs on disk ──────────────────────────────
    await new Promise(r => setTimeout(r, 800)); // let the pino transport flush
    const logsDir = path.join(__dirname, '..', 'logs');
    const logFiles = fs.existsSync(logsDir) ? fs.readdirSync(logsDir).filter(f => f.includes('.log')) : [];
    const hasContent = logFiles.some(f => {
      try { return fs.readFileSync(path.join(logsDir, f), 'utf8').includes('"url":'); } catch { return false; }
    });
    check('structured request logs written to backend/logs/ (daily-rotated files)',
      logFiles.length > 0 && hasContent, `files: ${logFiles.join(', ') || 'none'}`);

  } finally {
    child.kill();
    await cleanup();
    await db.end();
  }

  console.log(`\n${failCount === 0 ? '✅' : '❌'} Phase 6 acceptance: ${passCount} passed, ${failCount} failed.`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Acceptance run crashed:', err);
  try { await cleanup(); await db.end(); } catch { /* best effort */ }
  process.exit(1);
});
