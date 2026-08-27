/*
  scripts/accept-purchases.js — Purchase dashboard acceptance tests
  (see backend/routes/purchases.js, backend/services/{purchases,purchasesOdoo}.js).

  Mirrors scripts/accept-sales.js's philosophy: prove the dashboard degrades
  honestly WITHOUT real Odoo credentials, which is the state of every
  dev/CI environment. Purchases has no manual-entry/write path (unlike
  Sales), so there's no RBAC-on-write or daily_reports round-trip to test.

  Read access is role-gated server-side to COMMERCIAL_VIEW_ROLES
  (config/commercialAccess.js) — Purchases reuses the same list as Sales
  (mirrors the frontend's canViewSales() gate, per routes/purchases.js's
  doc comment: Purchases doesn't have its own dedicated PERMISSIONS field
  yet). There is no real 'purchasing' role in auth.js's PERMISSIONS matrix
  today — 'md' stands in as the representative "can view commercial data"
  role for this test until Purchases gets its own permission field.

    1. auth gating: dashboard requires auth (401 anonymous)
    2. a non-commercial role (production) is rejected (403) — reading this
       data used to be open to ANY authenticated role with no server-side
       check at all; this is the regression test for that gap
    3. po_value_trend / po_list report ok:false status:not_configured
       (never a fabricated number) when ODOO_URL is unset
    4. category_grid behaves like the other Odoo metrics — not_configured
       when ODOO_URL is unset, never a fabricated number. (It used to be a
       permanent unconditional not_mapped stub; since the live-Odoo field
       mapping landed it is a real implementation whose genuinely-unknown
       cells carry their own per-cell not_mapped, so the old "permanent
       stub" assertion no longer describes it — see purchasesOdoo.js's
       fetchCategoryGrid doc comment.)
    5. sources.{po_value_trend,po_list} propagate the real status string,
       and sources has no category_grid key (matches services/purchases.js)

  Cleans up after itself. Exits 0 only if all checks pass.
  Usage: node scripts/accept-purchases.js
*/
require('dotenv').config();
const { spawn } = require('child_process');
const path       = require('path');
const bcrypt     = require('bcryptjs');
const db         = require('../db');

const PORT   = process.env.ACCEPT_PORT || 5922;
const BASE   = `http://localhost:${PORT}/api`;
const PW     = 'AcceptPurchases@2026';
const USERS  = { viewer: 'ap_md', production: 'ap_production' };
const TODAY  = new Date().toISOString().slice(0, 10);
const YEAR   = Number(TODAY.slice(0, 4));
const MONTH  = Number(TODAY.slice(5, 7));

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
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}
async function loginToken(username) {
  const r = await api('POST', '/auth/login', { body: { username, password: PW } });
  if (r.status !== 200) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}
async function seedTestUsers() {
  const hash = await bcrypt.hash(PW, 6);
  const rows = [[USERS.viewer, 'md'], [USERS.production, 'production']];
  for (const [username, role] of rows) {
    await db.query(`
      INSERT INTO users (username, password_hash, full_name, role, department, active, must_change_password)
      VALUES ($1, $2, $3, $4, 'TEST', true, false)
      ON CONFLICT (username) DO UPDATE SET
        password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = true,
        must_change_password = false, failed_attempts = 0, locked_until = NULL, token_version = 0
    `, [username, hash, 'Accept-Purchases Test ' + username, role]);
  }
}
async function cleanup() {
  const names = Object.values(USERS);
  await db.query(`DELETE FROM audit_log WHERE username = ANY($1) OR user_id IN (SELECT id FROM users WHERE username = ANY($1))`, [names]);
  await db.query('DELETE FROM users WHERE username = ANY($1)', [names]);
}
function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, AUTH_RATE_LIMIT: '500', ODOO_URL: '', ODOO_DISPATCH_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.output = () => out;
  return child;
}
async function waitFor(url, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(url); if (res.status === 200) return true; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  console.log('Purchases acceptance — booting server on port ' + PORT + ' (ODOO_URL unset)…\n');
  await seedTestUsers();
  const child = startServer();

  try {
    if (!(await waitFor(`http://localhost:${PORT}/api/health`))) {
      console.error('Server did not come up.\n--- output ---\n' + child.output());
      process.exit(1);
    }
    const viewerTok = await loginToken(USERS.viewer);
    const otherTok  = await loginToken(USERS.production);

    // ── auth gating ──────────────────────────────────────────────
    const anonDash = await api('GET', `/purchases/dashboard?year=${YEAR}&month=${MONTH}`);
    check('dashboard rejects anonymous (401)', anonDash.status === 401, `got ${anonDash.status}`);

    // ── non-commercial role is rejected server-side ─────────────────
    const otherDash = await api('GET', `/purchases/dashboard?year=${YEAR}&month=${MONTH}`, { token: otherTok });
    check('dashboard rejects a non-commercial authenticated role (403)', otherDash.status === 403, `got ${otherDash.status}`);

    // ── dashboard: Odoo fields degrade honestly ─────────────────────
    const dash = await api('GET', `/purchases/dashboard?year=${YEAR}&month=${MONTH}`, { token: viewerTok });
    check('dashboard 200s', dash.status === 200, `got ${dash.status}`);
    const d = dash.body || {};
    check('period.year/month echo the request', d.period && d.period.year === YEAR && d.period.month === MONTH, JSON.stringify(d.period));

    check('po_value_trend reports not_configured, not a fabricated number', d.po_value_trend && d.po_value_trend.ok === false && d.po_value_trend.status === 'not_configured', JSON.stringify(d.po_value_trend));
    check('po_list reports not_configured, not a fabricated number', d.po_list && d.po_list.ok === false && d.po_list.status === 'not_configured', JSON.stringify(d.po_list));

    // category_grid is a real implementation now, so with ODOO_URL unset it
    // reports not_configured like the other Odoo metrics. Its per-cell
    // not_mapped entries only appear once Odoo IS reachable, so they can't
    // be asserted here.
    check('category_grid reports not_configured, not a fabricated number', d.category_grid && d.category_grid.ok === false && d.category_grid.status === 'not_configured', JSON.stringify(d.category_grid));

    check('sources.po_value_trend propagates the real status', d.sources && d.sources.po_value_trend === 'not_configured', JSON.stringify(d.sources));
    check('sources.po_list propagates the real status', d.sources && d.sources.po_list === 'not_configured', JSON.stringify(d.sources));
    check('sources has no category_grid key (matches services/purchases.js shape)', d.sources && !('category_grid' in d.sources), JSON.stringify(d.sources));

  } finally {
    child.kill();
    await cleanup();
    await db.end();
  }

  console.log(`\n${failCount === 0 ? '✅' : '❌'} Purchases acceptance: ${passCount} passed, ${failCount} failed.`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Acceptance run crashed:', err);
  try { await cleanup(); await db.end(); } catch { /* best effort */ }
  process.exit(1);
});
