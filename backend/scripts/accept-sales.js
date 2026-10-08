/*
  scripts/accept-sales.js — Sales dashboard acceptance tests
  (see the Sales Dashboard plan — backend/routes/sales.js,
  backend/services/{sales,salesRegister}.js, db/migrations/006_sales.sql).

  Proves the new endpoints end-to-end WITHOUT real Odoo credentials —
  that's the point: the dashboard must degrade honestly (not_configured/
  not_mapped, never a fabricated number) when ODOO_URL isn't set, which
  is the state of every dev/CI environment until Phase B credentials land.

    1. auth gating: dashboard/territories require auth; targets POST is
       role-gated to sales/admin/md
    2. a sales-projection entry round-trips through the EXISTING generic
       daily_reports/reports.js plumbing (form_type='sales-projection'),
       proving the new form_type was wired into VALID_FORMS/formAccess
    3. GET /api/sales/territories returns the seeded roster row
    4. GET /api/sales/dashboard: mtd.projected_mt sums the submitted
       projection; mtd.actual_mt/collections/financials.* all report
       ok:false with an honest status (not_configured), never a number
    5. POST /api/sales/targets sets an interim manual target, and the
       dashboard's mtd.target_mt / vs_target_pct / targets.source reflect
       it on the next load

  Cleans up after itself. Exits 0 only if all checks pass.
  Usage: node scripts/accept-sales.js
*/
require('../config/env');
const { spawn } = require('child_process');
const path       = require('path');
const bcrypt     = require('bcryptjs');
const db         = require('../db');

const PORT   = process.env.ACCEPT_PORT || 5921;
const BASE   = `http://localhost:${PORT}/api`;
const PW     = 'AcceptSales@2026';
const USERS  = { sales: 'as_sales', md: 'as_md', other: 'as_other' };
const OFFICER_CODE  = 'as_test_officer';
const OFFICER_CODE2 = 'as_test_officer2'; // second officer, used to test blank-field handling
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
  const rows = [[USERS.sales, 'sales'], [USERS.md, 'md'], [USERS.other, 'production']];
  for (const [username, role] of rows) {
    await db.query(`
      INSERT INTO users (username, password_hash, full_name, role, department, active, must_change_password)
      VALUES ($1, $2, $3, $4, 'TEST', true, false)
      ON CONFLICT (username) DO UPDATE SET
        password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = true,
        must_change_password = false, failed_attempts = 0, locked_until = NULL, token_version = 0
    `, [username, hash, 'Accept-Sales Test ' + username, role]);
  }
}
async function seedTerritory() {
  await db.query(`
    INSERT INTO sales_territories (officer_code, sales_officer, zone, division, divisional_manager)
    VALUES ($1, 'Accept Test Officer', 'ACCEPT-ZONE', 'ACCEPT-DIVISION', 'Accept Test Manager')
    ON CONFLICT (officer_code) DO UPDATE SET active = true
  `, [OFFICER_CODE]);
  await db.query(`
    INSERT INTO sales_territories (officer_code, sales_officer, zone, division, divisional_manager)
    VALUES ($1, 'Accept Test Officer Two', 'ACCEPT-ZONE-2', 'ACCEPT-DIVISION', 'Accept Test Manager')
    ON CONFLICT (officer_code) DO UPDATE SET active = true
  `, [OFFICER_CODE2]);
}
async function cleanup() {
  const names = Object.values(USERS);
  await db.query(`DELETE FROM daily_reports WHERE form_type = 'sales-projection' AND record_date = $1`, [TODAY]);
  await db.query(`DELETE FROM sales_targets WHERE officer_code = ANY($1) OR officer_code = '_company'`, [[OFFICER_CODE, OFFICER_CODE2]]);
  await db.query(`DELETE FROM sales_territories WHERE officer_code = ANY($1)`, [[OFFICER_CODE, OFFICER_CODE2]]);
  await db.query(`DELETE FROM audit_log WHERE username = ANY($1) OR user_id IN (SELECT id FROM users WHERE username = ANY($1))`, [names]);
  await db.query('DELETE FROM users WHERE username = ANY($1)', [names]);
}
function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, AUTH_RATE_LIMIT: '500', ODOO_URL: '', ODOO_DISPATCH_URL: '', ODOO_DASHBOARD_URL: '', ODOO_DASHBOARD_API_KEY: '' },
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
  console.log('Sales acceptance — booting server on port ' + PORT + ' (ODOO_URL unset)…\n');
  await seedTestUsers();
  await seedTerritory();
  const child = startServer();

  try {
    if (!(await waitFor(`http://localhost:${PORT}/api/health`))) {
      console.error('Server did not come up.\n--- output ---\n' + child.output());
      process.exit(1);
    }
    const salesTok = await loginToken(USERS.sales);
    const mdTok    = await loginToken(USERS.md);
    const otherTok = await loginToken(USERS.other);

    // ── auth gating ──────────────────────────────────────────────
    const anonDash = await api('GET', `/sales/dashboard?year=${YEAR}&month=${MONTH}`);
    check('dashboard rejects anonymous (401)', anonDash.status === 401, `got ${anonDash.status}`);

    const anonTerr = await api('GET', '/sales/territories');
    check('territories rejects anonymous (401)', anonTerr.status === 401, `got ${anonTerr.status}`);

    const otherTargets = await api('POST', '/sales/targets', {
      token: otherTok, body: { targetMonth: `${YEAR}-${String(MONTH).padStart(2, '0')}`, officerCode: OFFICER_CODE, targetMt: 100 },
    });
    check('targets POST rejects non sales/admin/md role (403)', otherTargets.status === 403, `got ${otherTargets.status}`);

    // ── sales-projection rides the existing generic daily_reports plumbing ──
    // OFFICER_CODE2's field is submitted as an empty string, matching what
    // form-persist.js actually syncs for an untouched input (Save Draft
    // sends every data-field, blank or not) — regression for the
    // blank-counts-as-reported bug.
    const submit = await api('POST', `/reports/sales-projection`, {
      token: salesTok, body: { date: TODAY, shift: 'day', data: {
        [`sp_${OFFICER_CODE}_proj_total`]: 42.5,
        [`sp_${OFFICER_CODE2}_proj_total`]: '',
        prepared_by: 'Accept Test',
      } },
    });
    check('sales-projection submit accepted (form_type wired into VALID_FORMS/formAccess)', submit.status === 200, `got ${submit.status} ${JSON.stringify(submit.body)}`);

    // ── territories ──────────────────────────────────────────────
    const terr = await api('GET', '/sales/territories', { token: mdTok });
    const found = (terr.body || []).find(t => t.officer_code === OFFICER_CODE);
    check('territories includes the seeded officer', terr.status === 200 && !!found, JSON.stringify(terr.body));

    // ── dashboard: projections sum, Odoo fields degrade honestly ───
    const dash = await api('GET', `/sales/dashboard?year=${YEAR}&month=${MONTH}`, { token: mdTok });
    check('dashboard 200s', dash.status === 200, `got ${dash.status}`);
    const d = dash.body || {};
    check('mtd.projected_mt includes the submitted 42.5 MT', d.mtd && d.mtd.projected_mt >= 42.5, JSON.stringify(d.mtd));
    /* Since 2026-10-08 tonnage comes from the Sale Register mirror (invoiced
       basis), falling back to dispatch notes when the period is unsynced, and
       to null when neither exists. This suite runs against whatever the
       database holds (empty in CI, real mirrored rows on a dev machine), so
       each check asserts the invariant for the basis actually in effect:
       a real, internally consistent number when there is data, and null —
       never a silent 0 — when there is not. */
    const tb = d.tonnage_basis || {};
    check('tonnage_basis names its basis and its day coverage',
      ['invoiced', 'delivered', null].includes(tb.basis) && tb.coverage
        && Number.isInteger(tb.coverage.days_synced) && Number.isInteger(tb.coverage.days_expected),
      JSON.stringify(tb));
    check('mtd.actual_mt is honest: the basis figure when there is data, null when there is none',
      d.mtd && (
        tb.basis === 'invoiced' ? d.mtd.actual_mt === tb.register_mt
          : tb.basis === 'delivered' ? d.mtd.actual_mt === tb.delivered_mt
          : d.mtd.actual_mt === null
      ),
      JSON.stringify({ actual_mt: d.mtd && d.mtd.actual_mt, basis: tb.basis }));
    check('collections: real figures only on the invoiced basis, otherwise an honest status, never zeros',
      d.collections && (
        tb.basis === 'invoiced'
          ? d.collections.ok === true && d.collections.total_collected_tzs + d.collections.outstanding_tzs === d.collections.invoiced_tzs
          : d.collections.ok === false && ['not_configured', 'not_synced'].includes(d.collections.status)
      ),
      JSON.stringify(d.collections));
    check('financials.payable reports not_mapped (no Odoo field for it)', d.financials && d.financials.payable.ok === false && d.financials.payable.status === 'not_mapped', JSON.stringify(d.financials && d.financials.payable));
    check('grades come back with the 4 known product lines', d.grades && d.grades.filter(g => g.key !== 'unmatched').length === 4,
      JSON.stringify(d.grades && d.grades.map(g => g.key)));
    check('grade values are null with no data, else they sum to the headline',
      d.grades && (
        tb.basis === null
          ? d.grades.every(g => g.mtd_actual_mt === null)
          : Math.abs(d.grades.reduce((s, g) => s + (g.mtd_actual_mt || 0), 0) - d.mtd.actual_mt) < 0.15
      ),
      JSON.stringify({ sum: d.grades && d.grades.reduce((s, g) => s + (g.mtd_actual_mt || 0), 0), headline: d.mtd && d.mtd.actual_mt }));
    check('customer figures exist only on the invoiced basis (dispatch notes carry no customer)',
      tb.basis === 'invoiced'
        ? Number.isInteger(d.mtd.active_customers) && Array.isArray(d.top_customers)
        : d.mtd.active_customers === null && d.top_customers.length === 0,
      JSON.stringify({ basis: tb.basis, active: d.mtd && d.mtd.active_customers }));
    check('targets.source defaults to manual before any target is set', d.targets && d.targets.source === 'manual');
    /* This suite boots the server with the Odoo env stripped, so an empty
       mirror must say not_configured; mirrored rows are still real data. */
    check('sources.sales_volume propagates the real status (not hardcoded)',
      d.sources && d.sources.sales_volume === (tb.basis === 'invoiced' ? 'odoo:sale_register' : 'not_configured'),
      JSON.stringify(d.sources));

    // ── regression: a blank field must NOT count as "reported" ─────
    check('today.officers_reported is 1, not 2 (officer 2 left blank)', d.today && d.today.officers_reported === 1, JSON.stringify(d.today));
    check('officer 2 (blank entry) shows up in missing_reporters', d.today && d.today.missing_reporters.includes('Accept Test Officer Two'), JSON.stringify(d.today && d.today.missing_reporters));
    check('officer 1 (real entry) does NOT show up in missing_reporters', d.today && !d.today.missing_reporters.includes('Accept Test Officer'), JSON.stringify(d.today && d.today.missing_reporters));

    // ── targets: set one, confirm it flows through on next load ────
    const setTarget = await api('POST', '/sales/targets', {
      token: salesTok, body: { targetMonth: `${YEAR}-${String(MONTH).padStart(2, '0')}`, officerCode: OFFICER_CODE, targetMt: 500 },
    });
    check('sales role can set an interim target', setTarget.status === 200, `got ${setTarget.status}`);

    // ── regression: '_company' sentinel must be insertable (was an FK 500) ──
    const setCompanyTarget = await api('POST', '/sales/targets', {
      token: salesTok, body: { targetMonth: `${YEAR}-${String(MONTH).padStart(2, '0')}`, officerCode: '_company', targetMt: 3000 },
    });
    check('company-wide (_company) target no longer 500s on the FK', setCompanyTarget.status === 200, `got ${setCompanyTarget.status} ${JSON.stringify(setCompanyTarget.body)}`);

    // ── regression: an unknown officerCode is rejected, not silently inserted ──
    const badOfficer = await api('POST', '/sales/targets', {
      token: salesTok, body: { targetMonth: `${YEAR}-${String(MONTH).padStart(2, '0')}`, officerCode: 'not_a_real_officer', targetMt: 100 },
    });
    check('unknown officerCode rejected with 400', badOfficer.status === 400, `got ${badOfficer.status}`);

    const dash2 = await api('GET', `/sales/dashboard?year=${YEAR}&month=${MONTH}`, { token: mdTok });
    const d2 = dash2.body || {};
    check('mtd.target_mt reflects officer + company targets summed correctly (officer row wins per _getTargets)', d2.mtd && d2.mtd.target_mt === 500, JSON.stringify(d2.mtd));
    check('targets.source is manual for the interim target', d2.targets && d2.targets.source === 'manual');

  } finally {
    child.kill();
    await cleanup();
    await db.end();
  }

  console.log(`\n${failCount === 0 ? '✅' : '❌'} Sales acceptance: ${passCount} passed, ${failCount} failed.`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Acceptance run crashed:', err);
  try { await cleanup(); await db.end(); } catch { /* best effort */ }
  process.exit(1);
});
