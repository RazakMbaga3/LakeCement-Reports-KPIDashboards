/*
  test/integration-extract.test.js — the Integration Package tab's backend:
  services/integrationExtract.js (runs the collaborator's Python bridge) and
  routes/integration.js (role gate + the /sales-app/ cookie gate).

  The Python bridge is replaced by test/fixtures/fake-web-extract.js, run by
  Node, so this needs neither Python nor Odoo (CI has neither). Route tests
  use real Postgres users, created and removed here.
*/
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const express = require('express');
const jwt    = require('jsonwebtoken');
const db     = require('../db');
const extract = require('../services/integrationExtract');

const FIX = path.join(__dirname, 'fixtures');
const MODE = path.join(FIX, 'fake-web-extract.mode');
const RUNS = path.join(FIX, 'fake-web-extract.runs');
const FAKE = path.join(FIX, 'fake-web-extract.js');

function useFake(mode, extra = {}) {
  fs.writeFileSync(MODE, mode);
  fs.writeFileSync(RUNS, '');
  extract.configure({ python: process.execPath, script: FAKE, dir: FIX, ...extra });
}
const runs = () => fs.readFileSync(RUNS, 'utf8').length;

test.after(() => {
  for (const f of [MODE, RUNS]) fs.rmSync(f, { force: true });
  extract.configure({});
});

// ── service ─────────────────────────────────────────────────────────────

test('not installed (no venv, as in CI): honest status, nothing spawned', async () => {
  extract.configure({ python: path.join(FIX, 'no-such-python'), script: FAKE });
  const r = await extract.getVehicles();
  assert.equal(r.ok, false);
  assert.equal(r.status, 'not_installed');
});

test('ok: returns the bridge JSON and passes the report name as an argument', async () => {
  useFake('ok');
  const r = await extract.getSalesVsTarget('2026-10-14');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.args, ['sales-vs-target', '--date', '2026-10-14']);
  assert.ok(r.cached_at);
});

test('the child never inherits Node secrets or PG_* (minimal environment)', async () => {
  process.env.JWT_SECRET_PROBE = 'must-not-leak';
  process.env.PG_PASSWORD = 'must-not-leak';
  try {
    useFake('ok');
    const r = await extract.getVehicles();
    const keys = r.data.env_keys;
    for (const k of ['JWT_SECRET', 'JWT_SECRET_PROBE', 'DB_PASSWORD', 'PG_PASSWORD', 'GRAPH_CLIENT_SECRET', 'SMTP_PASS']) {
      assert.ok(!keys.includes(k), `${k} leaked into the Python child`);
    }
    assert.ok(keys.includes('PYTHONUTF8'));
  } finally {
    delete process.env.JWT_SECRET_PROBE;
    delete process.env.PG_PASSWORD;
  }
});

test('Odoo down → odoo_unreachable (never a zero-filled ok)', async () => {
  useFake('odoo-down');
  const r = await extract.getVehicles();
  assert.equal(r.ok, false);
  assert.equal(r.status, 'odoo_unreachable');
});

test('not configured (.env missing a key) → not_configured', async () => {
  useFake('not-configured');
  const r = await extract.getVehicles();
  assert.equal(r.status, 'not_configured');
});

test('unreadable output (a traceback) → error, not a crash', async () => {
  useFake('garbage');
  const r = await extract.getVehicles();
  assert.equal(r.ok, false);
  assert.equal(r.status, 'error');
});

test('oversized output is cut off', async () => {
  useFake('huge');
  const r = await extract.getVehicles();
  assert.equal(r.ok, false);
  assert.match(r.message, /unexpectedly large/);
});

test('a hung bridge is killed at the timeout', async () => {
  useFake('slow', { timeoutMs: 800 });
  const t0 = Date.now();
  const r = await extract.getVehicles();
  assert.equal(r.status, 'timeout');
  assert.ok(Date.now() - t0 < 4000, 'killed well before the fake would have answered');
});

test('concurrent callers share one run; a repeat call is served from cache', async () => {
  useFake('ok');
  const [a, b] = await Promise.all([extract.getVehicles(), extract.getVehicles()]);
  assert.equal(runs(), 1, 'two concurrent calls must start ONE Python child');
  assert.equal(a.cached_at, b.cached_at);
  await extract.getVehicles();
  assert.equal(runs(), 1, 'within the TTL the cache answers');
});

test('when Odoo fails after a good run, the last good result is served marked stale', async () => {
  useFake('ok');
  const good = await extract.getSalesVsTarget('2026-10-01');
  assert.equal(good.ok, true);
  // expire the cache entry without waiting 30 minutes
  fs.writeFileSync(MODE, 'odoo-down');
  extract._expireForTests();
  const r = await extract.getSalesVsTarget('2026-10-01');
  assert.equal(r.ok, true);
  assert.equal(r.stale, true);
  assert.equal(r.stale_status, 'odoo_unreachable');
});

test('only one Python child at a time across reports', async () => {
  useFake('slow', { timeoutMs: 20000 });
  fs.writeFileSync(MODE, 'slow');
  const t0 = Date.now();
  await Promise.all([extract.getVehicles(), extract.getSalesVsTarget('2026-10-02')]);
  assert.ok(Date.now() - t0 >= 9000, 'two 5 s runs must be sequential, not parallel');
});

// ── routes: role gate and the /sales-app/ cookie gate ───────────────────

const users = {};
let server, base;

async function mkUser(username, role) {
  await db.query('DELETE FROM users WHERE username = $1', [username]);
  const { rows } = await db.query(
    `INSERT INTO users (username, password_hash, full_name, role, department, level, active)
     VALUES ($1,'x',$1,$2,'TEST','hod',true) RETURNING id, username, role, token_version`, [username, role]);
  const u = rows[0];
  u.token = jwt.sign({ id: u.id, username: u.username, role: u.role, ver: u.token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' });
  return u;
}

test.before(async () => {
  users.sales = await mkUser('int_pkg_sales', 'sales');
  users.prod = await mkUser('int_pkg_production', 'production');
  const app = express();
  app.use('/api/integration', require('../routes/integration'));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/integration`;
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  await db.query("DELETE FROM users WHERE username LIKE 'int_pkg_%'");
});

const call = (p, { token, method = 'GET', cookie } = {}) => fetch(base + p, {
  method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(cookie ? { Cookie: cookie } : {}) },
});

test('routes: no token 401, wrong role 403, sales role allowed', async () => {
  useFake('ok');
  assert.equal((await call('/vehicles')).status, 401);
  assert.equal((await call('/vehicles', { token: users.prod.token })).status, 403);
  assert.equal((await call('/sales-vs-target', { token: users.prod.token })).status, 403);
  assert.equal((await call('/status', { token: users.prod.token })).status, 403);
  assert.equal((await call('/sales-app-session', { token: users.prod.token, method: 'POST' })).status, 403);
  const ok = await call('/vehicles', { token: users.sales.token });
  assert.equal(ok.status, 200);
});

test('routes: a bad or future date is refused before Python runs', async () => {
  useFake('ok');
  for (const d of ['2026-13-01', 'yesterday', '2025-12-31', '2099-01-01']) {
    const r = await call('/sales-vs-target?date=' + d, { token: users.sales.token });
    assert.equal(r.status, 400, d);
  }
  assert.equal(runs(), 0);
});

test('routes: an Odoo failure is a 503 with a reason, not a 200 with zeros', async () => {
  useFake('odoo-down');
  const r = await call('/vehicles', { token: users.sales.token });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).status, 'odoo_unreachable');
});

async function cookieFor(token) {
  const r = await call('/sales-app-session', { token, method: 'POST' });
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Strict/);
  assert.match(sc, /Path=\/sales-app\//);
  return sc.split(';')[0];
}

test('gate: no cookie 401, valid cookie 204, tampered cookie 401', async () => {
  assert.equal((await call('/sales-app-gate')).status, 401);
  const ck = await cookieFor(users.sales.token);
  assert.equal((await call('/sales-app-gate', { cookie: ck })).status, 204);
  assert.equal((await call('/sales-app-gate', { cookie: ck + 'x' })).status, 401);
});

test('gate: the cookie is not usable as an API Bearer token', async () => {
  const ck = await cookieFor(users.sales.token);
  const value = ck.split('=').slice(1).join('=');
  assert.equal((await call('/vehicles', { token: value })).status, 401);
});

/* The gate caches a GOOD answer for up to a minute, so each cookie below is
   revoked before the gate has ever seen it — that is what is under test. */
test('gate: logging out (token_version bump) revokes the cookie', async () => {
  const u = await mkUser('int_pkg_sales2', 'sales');
  const ck = await cookieFor(u.token);
  await db.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [u.id]);
  assert.equal((await call('/sales-app-gate', { cookie: ck })).status, 401);
});

test('gate: deactivating the account revokes the cookie', async () => {
  const u = await mkUser('int_pkg_sales3', 'sales');
  const ck = await cookieFor(u.token);
  await db.query('UPDATE users SET active = false WHERE id = $1', [u.id]);
  assert.equal((await call('/sales-app-gate', { cookie: ck })).status, 401);
});

test('gate: moving the user out of Sales revokes the cookie', async () => {
  const u = await mkUser('int_pkg_sales4', 'sales');
  const ck = await cookieFor(u.token);
  await db.query("UPDATE users SET role = 'production' WHERE id = $1", [u.id]);
  assert.equal((await call('/sales-app-gate', { cookie: ck })).status, 401);
});
