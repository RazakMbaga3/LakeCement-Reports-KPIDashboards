/*
  scripts/accept-phase1.js — Phase 1 acceptance tests (see docs/MASTER_BUILD_PROMPT.md).

  Boots the real server on a scratch port with a low lockout threshold,
  creates four throwaway users directly in the database, and proves:

    1. login returns a working JWT (+ rate-limit headers present)
    2. a tampered token gets 401
    3. repeated wrong passwords lock the account (423), even with the right password
    4. a role without form access gets 403 from the API
    5. an authorized role can submit and read back a form
    6. logout revokes ALL outstanding tokens (old token → 401)
    7. must_change_password gates every non-auth route (403) until
       change-password succeeds, which also revokes the pre-change token
    8. malformed input (bad date, unknown form, empty body, weak password) → 400

  Cleans up its users, audit rows and test report row afterwards.
  Exits 0 only if every check passes.   Usage: npm run accept:phase1
*/

require('dotenv').config();
const { spawn } = require('child_process');
const path      = require('path');
const bcrypt    = require('bcryptjs');
const db        = require('../db');

const PORT      = process.env.ACCEPT_PORT || 5902;
const BASE      = `http://localhost:${PORT}/api`;
const PW        = 'Accept@12345';
const NEW_PW    = 'Fresh@678901';
const TEST_DATE = '1999-01-09'; // improbable date — deleted afterwards
const USERS     = ['p1_prod', 'p1_hr', 'p1_lock', 'p1_mcp'];

let passCount = 0, failCount = 0;
function check(name, cond, extra) {
  if (cond) { passCount++; console.log(`  ✅ ${name}`); }
  else      { failCount++; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

async function api(method, pathname, { token, body } = {}) {
  const headers = {};
  if (body)  headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + pathname, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty/non-JSON */ }
  return { status: res.status, body: json, headers: res.headers };
}

const login = (username, password) => api('POST', '/auth/login', { body: { username, password } });

async function seedTestUsers() {
  const hash = await bcrypt.hash(PW, 6); // low cost — test-only accounts
  const mk = (username, role, mustChange) => db.query(`
    INSERT INTO users (username, password_hash, full_name, role, department, active, must_change_password)
    VALUES ($1, $2, $3, $4, 'TEST', true, $5)
    ON CONFLICT (username) DO UPDATE SET
      password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = true,
      must_change_password = EXCLUDED.must_change_password,
      failed_attempts = 0, locked_until = NULL, token_version = 0
  `, [username, hash, 'Phase1 Test ' + username, role, mustChange]);

  await mk('p1_prod', 'pm',         false); // may submit kiln (P&M owns it now)
  await mk('p1_hr',   'hr',         false); // may NOT submit kiln
  await mk('p1_lock', 'production', false); // gets locked out
  await mk('p1_mcp',  'production', true);  // must change password
}

async function cleanup() {
  await db.query(
    `DELETE FROM audit_log
     WHERE username = ANY($1)
        OR user_id IN (SELECT id FROM users WHERE username = ANY($1))`,
    [USERS]
  );
  await db.query(
    `DELETE FROM daily_reports WHERE form_type = 'kiln' AND record_date = $1`,
    [TEST_DATE]
  );
  await db.query('DELETE FROM users WHERE username = ANY($1)', [USERS]);
}

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT,
      LOCKOUT_MAX_ATTEMPTS: '3', // shorter path to the lockout check
      LOCKOUT_MINUTES:      '15',
      AUTH_RATE_LIMIT:      '500', // keep the limiter out of the way of the tests
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.output = () => out;
  return child;
}

async function waitForHealth() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

function tamper(token) {
  // Corrupt one character mid-payload — signature check must reject it
  const i = Math.floor(token.length / 2);
  const c = token[i] === 'a' ? 'b' : 'a';
  return token.slice(0, i) + c + token.slice(i + 1);
}

async function main() {
  console.log('Phase 1 acceptance — booting server on port ' + PORT + '…\n');
  await seedTestUsers();
  const child = startServer();

  try {
    if (!(await waitForHealth())) {
      console.error('Server did not come up.\n--- output ---\n' + child.output());
      process.exit(1);
    }

    // ── 1. Login works, rate-limit headers present ─────────────────
    const l1 = await login('p1_prod', PW);
    check('login returns 200 + token', l1.status === 200 && !!l1.body.token, `got ${l1.status}`);
    check('login response carries rate-limit header', !!l1.headers.get('ratelimit'));
    check('login reports mustChangePassword=false', l1.body.mustChangePassword === false);
    const prodToken = l1.body.token;

    // ── 2. Tampered token → 401 ────────────────────────────────────
    const t2 = await api('GET', `/reports/kiln/${TEST_DATE}`, { token: tamper(prodToken) });
    check('tampered token → 401', t2.status === 401, `got ${t2.status}`);

    // ── 3. Lockout after repeated failures ─────────────────────────
    for (let i = 0; i < 3; i++) await login('p1_lock', 'Wrong@99999');
    const t3 = await login('p1_lock', PW); // correct password, but locked
    check('locked account rejects even the CORRECT password (423)',
      t3.status === 423, `got ${t3.status}: ${JSON.stringify(t3.body)}`);

    // ── 4. RBAC: hr may not submit kiln → 403 ──────────────────────
    const hrToken = (await login('p1_hr', PW)).body.token;
    const t4 = await api('POST', '/reports/kiln', {
      token: hrToken, body: { date: TEST_DATE, data: { x: 1 } },
    });
    check('unauthorized role submitting a form → 403', t4.status === 403, `got ${t4.status}`);

    // ── 5. Authorized submit + read-back ───────────────────────────
    const t5 = await api('POST', '/reports/kiln', {
      token: prodToken, body: { date: TEST_DATE, data: { _accept: 1 } },
    });
    check('authorized submit → 200', t5.status === 200 && t5.body.success === true, `got ${t5.status}`);
    const t5b = await api('GET', `/reports/kiln/${TEST_DATE}`, { token: prodToken });
    check('submitted form reads back', t5b.status === 200 && t5b.body && t5b.body.data && t5b.body.data._accept === 1);

    // ── 6. Logout revokes the token server-side ────────────────────
    await api('POST', '/auth/logout', { token: prodToken });
    const t6 = await api('GET', `/reports/kiln/${TEST_DATE}`, { token: prodToken });
    check('token used after logout → 401 (revoked server-side)', t6.status === 401, `got ${t6.status}`);

    // ── 7. Forced password change gate ─────────────────────────────
    const l7 = await login('p1_mcp', PW);
    check('flagged account logs in with mustChangePassword=true', l7.body.mustChangePassword === true);
    const mcpToken = l7.body.token;
    const t7a = await api('GET', `/reports/kiln/${TEST_DATE}`, { token: mcpToken });
    check('data routes blocked until password changed (403 + code)',
      t7a.status === 403 && t7a.body.code === 'PASSWORD_CHANGE_REQUIRED', `got ${t7a.status}`);
    const t7b = await api('POST', '/auth/change-password', {
      token: mcpToken, body: { currentPassword: PW, newPassword: NEW_PW },
    });
    check('change-password succeeds and returns a fresh token', t7b.status === 200 && !!t7b.body.token);
    const t7c = await api('GET', `/reports/kiln/${TEST_DATE}`, { token: mcpToken });
    check('pre-change token is revoked (401)', t7c.status === 401, `got ${t7c.status}`);
    const t7d = await api('GET', `/reports/kiln/${TEST_DATE}`, { token: t7b.body.token });
    check('fresh token passes the cleared gate (200)', t7d.status === 200, `got ${t7d.status}`);

    // ── 8. Validation rejects malformed input ──────────────────────
    const prodToken2 = (await login('p1_prod', PW)).body.token; // re-login (revoked in step 6)
    const t8a = await api('POST', '/reports/kiln', {
      token: prodToken2, body: { date: 'not-a-date', data: { x: 1 } },
    });
    check('bad date → 400', t8a.status === 400, `got ${t8a.status}`);
    const t8b = await api('GET', `/reports/not-a-form/${TEST_DATE}`, { token: prodToken2 });
    check('unknown form type → 400', t8b.status === 400, `got ${t8b.status}`);
    const t8c = await api('POST', '/reports/kiln', {
      token: prodToken2, body: { date: TEST_DATE, data: {} },
    });
    check('empty form data → 400', t8c.status === 400, `got ${t8c.status}`);
    const t8d = await api('POST', '/auth/login', { body: { username: 'p1_prod' } });
    check('login without password → 400', t8d.status === 400, `got ${t8d.status}`);
    const t8e = await api('POST', '/auth/change-password', {
      token: prodToken2, body: { currentPassword: PW, newPassword: 'short1' },
    });
    check('weak new password → 400', t8e.status === 400, `got ${t8e.status}`);

  } finally {
    child.kill();
    await cleanup();
    await db.end();
  }

  console.log(`\n${failCount === 0 ? '✅' : '❌'} Phase 1 acceptance: ${passCount} passed, ${failCount} failed.`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Acceptance run crashed:', err);
  try { await cleanup(); await db.end(); } catch { /* best effort */ }
  process.exit(1);
});
