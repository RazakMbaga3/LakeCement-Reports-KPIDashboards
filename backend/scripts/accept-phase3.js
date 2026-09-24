/*
  scripts/accept-phase3.js — Phase 3 acceptance tests (see docs/MASTER_BUILD_PROMPT.md).

  Proves the KPI formula layer end-to-end against a live server + Postgres:
    A. seeds 3 days of kiln/quality/dispatch/power/pile data via the API and
       checks every formula's monthly value against INDEPENDENTLY hand-coded
       arithmetic (not the registry — so the engine is verified, not echoed)
    B. daily series endpoint returns the per-day values
    C. overrides: RBAC (403 for non-admin), mandatory reason (400), set →
       value swaps while computed is preserved + who/why metadata, supersede,
       clear → formula value returns, history rows are PERMANENT, audit_log
       carries the full trail
    D. structural: kpi-data.js and analytics.js contain no formula math —
       the registry + engine are the only place KPIs are defined

  Cleans up after itself. Exits 0 only if all checks pass.
  Usage: npm run accept:phase3
*/

require('../config/env');
const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');
const bcrypt    = require('bcryptjs');
const db        = require('../db');
const { FORMULAS } = require('../../forms/formula-registry.js');

const PORT  = process.env.ACCEPT_PORT || 5904;
const BASE  = `http://localhost:${PORT}/api`;
const PW    = 'Accept@34567';
const YEAR  = 1999, MONTH = 3;
const DATES = ['1999-03-01', '1999-03-02', '1999-03-03'];
const USERS = { production: 'p3_production', logistics: 'p3_logistics', cpp: 'p3_cpp', pm: 'p3_pm', admin: 'p3_admin' };

let passCount = 0, failCount = 0;
function check(name, cond, extra) {
  if (cond) { passCount++; console.log(`  ✅ ${name}`); }
  else      { failCount++; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}
const close = (a, b, eps = 0.01) => a !== null && b !== null && Math.abs(a - b) <= eps;

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
  if (r.status !== 200) throw new Error(`login ${username}: ${r.status}`);
  return r.body.token;
}

/* ── Test data — chosen so every aggregate is easy to verify by hand ── */
// prod (production form) / coal_kiln (production form, real field name — see
// formula-registry.js FACTS.kiln_coal_cons) / ncv (limestone form, submitted
// separately below — the two facts live on different forms in the real app)
const KILN = [
  { kiln_prod_mt: 2000, coal_kiln: 250 },
  { kiln_prod_mt: 2100, coal_kiln: 260 },
  { kiln_prod_mt: 1900, coal_kiln: 240 },
];
const NCV = [{ ncv: 4800 }, { ncv: 4900 }, { ncv: 4700 }];
const QUALITY = [
  { free_lime: 2.5, blaine_425r: 3400, strength_28d: 42 },
  { free_lime: 2.8, blaine_425r: 3500, strength_28d: 43 },
  { free_lime: 3.1, blaine_425r: 3600, strength_28d: 44 },
];
// Dispatch form data — still submitted below to exercise its own endpoint, but no
// longer feeds despatch-day (see CEMENT_MILL's cm1_425r_cons_mt, v4 2026-07-31).
const DISPATCH = [
  { dispatch_reg_425r: 1000, dispatch_reg_425n: 200, dispatch_blk_425r: 300, dispatch_bag_425r: 500 },
  { dispatch_reg_425r:  700, dispatch_reg_425n: 300, dispatch_blk_425r: 200, dispatch_bag_425r: 300 },
  { dispatch_reg_425r: 1200, dispatch_reg_425n: 400, dispatch_blk_425r: 400, dispatch_bag_425r: 500 },
];
// pwr_utils_kwh removed 2026-07-24 (Compressed Air/Utilities deleted from
// the power-cons form) — consumed/supplied comments below reflect that.
const POWER = [
  { pwr_crusher_kwh: 5000, pwr_rawmill_kwh: 10000, pwr_coalmill_kwh: 5000, pwr_kiln_kwh: 15000,
    pwr_cm1_kwh: 6000, pwr_cm2_kwh: 8000, pwr_packing_kwh: 3000, pwr_packing2_kwh: 500,
    pwr_lighting_kwh: 2000,
    pwr_tanesco_kwh: 30000, pwr_cpp_kwh: 27200, // supplied 57200 vs consumed 54500 -> +2700 loss
    pwr_kiln_prod_mt: 1500, pwr_cm1_prod_mt: 300, pwr_cm2_prod_mt: 500 }, // clinker subset 35000
  { pwr_crusher_kwh: 5000, pwr_rawmill_kwh: 11000, pwr_coalmill_kwh: 5000, pwr_kiln_kwh: 16000,
    pwr_cm1_kwh: 6000, pwr_cm2_kwh: 8000, pwr_packing_kwh: 1000, pwr_packing2_kwh: 0,
    pwr_lighting_kwh: 1000,
    pwr_tanesco_kwh: 28000, pwr_cpp_kwh: 26500, // supplied 54500 vs consumed 53000 -> +1500 loss
    pwr_kiln_prod_mt: 1600, pwr_cm1_prod_mt: 250, pwr_cm2_prod_mt: 400 }, // clinker subset 37000
  { pwr_crusher_kwh: 5000, pwr_rawmill_kwh: 9000, pwr_coalmill_kwh: 4000, pwr_kiln_kwh: 15000,
    pwr_cm1_kwh: 5000, pwr_cm2_kwh: 7000, pwr_packing_kwh: 1000, pwr_packing2_kwh: 0,
    pwr_lighting_kwh: 500,
    pwr_tanesco_kwh: 24000, pwr_cpp_kwh: 23200, // supplied 47200 vs consumed 46500 -> +700 loss
    pwr_kiln_prod_mt: 1400, pwr_cm1_prod_mt: 200, pwr_cm2_prod_mt: 600 }, // clinker subset 33000
];
// clinker consumed = 80% of total cement produced each day (clean clinker factor),
// split own/purchased to also exercise totalClinkerCons() summing both facts
// cm1_425r_cons_mt doubles as the despatch-day fixture: CM-1's stock-ledger
// "Consumption" column = dispatch out of CM-1's stock (formula-registry.js
// despatch-day v4 — matches the Production Report's TOTAL — CM-1 On Date Consumption cell)
const CEMENT_MILL = [
  { cm_clinker_own_cons: 440, cm_clinker_purch_cons: 200, cm1_425r_mt: 300, cm2_425r_mt: 500, cm1_425r_cons_mt: 2000 }, // total prod 800, total clinker 640
  { cm_clinker_own_cons: 520, cm_clinker_purch_cons:   0, cm1_425r_mt: 250, cm2_425r_mt: 400, cm1_425r_cons_mt: 1500 }, // total prod 650, total clinker 520
  { cm_clinker_own_cons: 300, cm_clinker_purch_cons: 340, cm1_425r_mt: 200, cm2_425r_mt: 600, cm1_425r_cons_mt: 2500 }, // total prod 800, total clinker 640
];
const PILE = [
  { cao_h1: 44, cao_h2: 46 }, // daily avg 45
  { cao_h1: 43 },             // daily avg 43
  {},                          // no samples → null day
];

/* Independently hand-coded expectations (the registry math, re-derived).
   Intentionally a SUBSET of the registry — only the formulas this script
   seeds real fixture data for. The "every formula present" count check
   below compares against the live FORMULAS registry, not this object, so
   adding a new formula here isn't required just to keep that check green;
   add an entry here only when you also want its VALUE hand-verified. */
const EXPECTED = {
  'kiln-output':        (2000 + 2100 + 1900) / 3,                                     // 2000
  'clinker-free-lime':  (2.5 + 2.8 + 3.1) / 3,                                        // 2.8
  'despatch-day':       (2000 + 1500 + 2500) / 3,      // 2000 — CM-1 cons_mt (dispatch) fixture, see CEMENT_MILL
  'blaine-425r':        (3400 + 3500 + 3600) / 3,                                     // 3500
  'strength-28d':       (42 + 43 + 44) / 3,                                           // 43
  'pile-cao-avg':       (45 + 43) / 2,                                                // 44
  // v3: no longer includes utilities (removed 2026-07-24)
  'total-power-kwh':    54500 + 53000 + 46500,                                        // 154000
  'specific-thermal-energy-consumption':
    (250 * 4800 + 260 * 4900 + 240 * 4700) / (2000 + 2100 + 1900),
  // v3: back to upstream-of-clinker kWh only, no utilities share (fact removed 2026-07-24)
  'specific-power-consumption-up-to-clinker':
    (35000 + 37000 + 33000) / (1500 + 1600 + 1400),
  // v4: both cement mills + both packing plants, no utilities share (fact removed 2026-07-24)
  'specific-power-consumption-cement-grinding':
    (((6000 + 8000) + (3000 + 500)) +
     ((6000 + 8000) + (1000 + 0))   +
     ((5000 + 7000) + (1000 + 0))) / (800 + 650 + 800),
  // v4: downstream no longer includes utilities (was 21500/17000/14000 with utils)
  'specific-power-consumption-total':
    ((35000 / 1500 * 640) + (37000 / 1600 * 520) + (33000 / 1400 * 640) +
     (19500 + 16000 + 13500)) / (800 + 650 + 800),
  // v2: supplied (tanesco+cpp) minus consumed (KWH_ALL, no utilities) as % of consumed
  'power-distribution-loss-pct': (2700 + 1500 + 700) * 100 / (54500 + 53000 + 46500),
  // purchased ÷ (own+purchased) clinker consumed, weighted by total clinker consumed
  'purchased-clinker-share': (200 + 0 + 340) / (640 + 520 + 640) * 100,                 // 30
};

async function seedTestUsers() {
  const hash = await bcrypt.hash(PW, 6);
  for (const [role, username] of Object.entries(USERS)) {
    await db.query(`
      INSERT INTO users (username, password_hash, full_name, role, department, active, must_change_password)
      VALUES ($1, $2, $3, $4, 'TEST', true, false)
      ON CONFLICT (username) DO UPDATE SET
        password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = true,
        must_change_password = false, failed_attempts = 0, locked_until = NULL, token_version = 0
    `, [username, hash, 'Phase3 Test ' + username, role]);
  }
}

async function cleanup() {
  const names = Object.values(USERS);
  await db.query(
    `DELETE FROM audit_log
     WHERE username = ANY($1)
        OR user_id IN (SELECT id FROM users WHERE username = ANY($1))`, [names]);
  await db.query(`DELETE FROM daily_reports WHERE record_date BETWEEN '1999-03-01' AND '1999-03-31'`);
  /* report_revisions is append-only in production — nothing in the app ever
     deletes from it, by design. An acceptance run is the one exception: it
     writes a revision for every sandbox submit, so without this each run
     leaves rows behind forever. Scoped to exactly the sandbox dates the
     daily_reports delete above uses, so a real revision can never be caught. */
  await db.query(`DELETE FROM report_revisions WHERE record_date BETWEEN '1999-03-01' AND '1999-03-31'`);
  await db.query('DELETE FROM kpi_overrides WHERE year = $1 AND month = $2', [YEAR, MONTH]);
  await db.query('DELETE FROM users WHERE username = ANY($1)', [names]);
}

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, AUTH_RATE_LIMIT: '500' },
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
    try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return true; }
    catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  console.log('Phase 3 acceptance — booting server on port ' + PORT + '…\n');
  await seedTestUsers();
  const child = startServer();

  try {
    if (!(await waitForHealth())) {
      console.error('Server did not come up.\n--- output ---\n' + child.output());
      process.exit(1);
    }

    const tok = {};
    for (const [role, username] of Object.entries(USERS)) tok[role] = await loginToken(username);

    // Seed the month's daily data via the real reports API
    const submit = async (token, form, date, data) => {
      const r = await api('POST', `/reports/${form}`, { token, body: { date, data } });
      if (r.status >= 300) throw new Error(`seed submit ${form} ${date}: HTTP ${r.status}`);
      return r;
    };
    for (let i = 0; i < DATES.length; i++) {
      // kiln + cement-mill fields now live on the Production Report — one combined submit
      await submit(tok.production, 'production',   DATES[i], { ...KILN[i], ...CEMENT_MILL[i] });
      await submit(tok.production, 'limestone',    DATES[i], NCV[i]);
      await submit(tok.production, 'quality',      DATES[i], QUALITY[i]);
      await submit(tok.logistics,  'dispatch',     DATES[i], DISPATCH[i]);
      await submit(tok.pm,         'power-cons',   DATES[i], POWER[i]);
      if (Object.keys(PILE[i]).length) {
        await submit(tok.production, 'pile-quality', DATES[i], PILE[i]);
      }
    }

    // ── A. Monthly evaluation matches hand-coded arithmetic ────────
    console.log('Part A — formula engine vs independent hand math:');
    const evalRes = await api('GET', `/formula/eval/${YEAR}/${MONTH}`, { token: tok.production });
    // Compared against the REAL registry's formula count, not
    // Object.keys(EXPECTED).length — EXPECTED only covers the formulas
    // this script seeds hand-verifiable fixture data for (13); the
    // registry has grown to include stoppage/materials-consumption sumOf()
    // formulas and the (currently unwired, provisional — see
    // forms/formula-registry.js) CPP ones that this script doesn't seed
    // data for. Deriving from FORMULAS directly means this check can't go
    // stale the way a hand-copied count already did once (found 2026-08-19:
    // asserted 13 while the endpoint correctly returned 20).
    check('eval endpoint returns 200 + every formula in the registry',
      evalRes.status === 200 && Array.isArray(evalRes.body) &&
      evalRes.body.length === Object.keys(FORMULAS).length,
      `status ${evalRes.status}, got ${evalRes.body && evalRes.body.length} formulas, registry has ${Object.keys(FORMULAS).length}`);

    const byKey = new Map((evalRes.body || []).map(r => [r.key, r]));
    for (const [key, expected] of Object.entries(EXPECTED)) {
      const r = byKey.get(key);
      const rounded = r ? parseFloat(expected.toFixed(r.dp)) : null;
      check(`${key} = ${r ? r.value : '∅'} (expect ≈ ${rounded})`,
        r && close(r.value, rounded), r ? `computed=${r.computed}` : 'missing');
    }
    check('results carry registry metadata (unit, target, version)',
      byKey.get('clinker-free-lime')?.unit === '%' &&
      byKey.get('clinker-free-lime')?.target === 3.0 &&
      byKey.get('clinker-free-lime')?.version >= 1);

    // ── B. Daily series ─────────────────────────────────────────────
    const daily = await api('GET', `/formula/daily?from=${DATES[0]}&to=${DATES[2]}`, { token: tok.production });
    const kilnSeries = daily.body?.['kiln-output']?.series || [];
    check('daily series returns per-day kiln output (2000, 2100, 1900)',
      daily.status === 200 && kilnSeries.length === 3 &&
      kilnSeries[0].value === 2000 && kilnSeries[1].value === 2100 && kilnSeries[2].value === 1900,
      JSON.stringify(kilnSeries));

    // ── C. Overrides ────────────────────────────────────────────────
    console.log('Part C — audited manual overrides:');
    const ovBody = { kpi_key: 'kiln-output', year: YEAR, month: MONTH, value: 2050, reason: 'Manual weighbridge reconciliation for March' };

    const c1 = await api('POST', '/formula/override', { token: tok.production, body: ovBody });
    check('non-admin override → 403', c1.status === 403, `got ${c1.status}`);

    const c2 = await api('POST', '/formula/override', { token: tok.admin, body: { ...ovBody, reason: 'ok' } });
    check('override without a meaningful reason → 400', c2.status === 400, `got ${c2.status}`);

    const c3 = await api('POST', '/formula/override', { token: tok.admin, body: ovBody });
    check('admin override with reason → 200', c3.status === 200, `got ${c3.status}: ${JSON.stringify(c3.body)}`);

    const e2 = await api('GET', `/formula/eval/${YEAR}/${MONTH}`, { token: tok.production });
    const k2 = (e2.body || []).find(r => r.key === 'kiln-output');
    check('eval shows override value, preserves computed, carries who/why',
      k2 && k2.value === 2050 && k2.computed === 2000 && k2.overridden === true &&
      k2.override && /weighbridge/i.test(k2.override.reason) && /p3_admin/.test(k2.override.by || ''),
      JSON.stringify(k2));

    const c4 = await api('POST', '/formula/override', {
      token: tok.admin, body: { ...ovBody, value: 2075, reason: 'Corrected weighbridge figure (second pass)' } });
    const e3 = await api('GET', `/formula/eval/${YEAR}/${MONTH}`, { token: tok.production });
    const k3 = (e3.body || []).find(r => r.key === 'kiln-output');
    check('second override supersedes the first', c4.status === 200 && k3 && k3.value === 2075);

    const hist = await api('GET', `/formula/overrides/${YEAR}/${MONTH}`, { token: tok.admin });
    check('override history keeps BOTH rows (permanent, superseded one cleared)',
      hist.body && hist.body.length === 2 &&
      hist.body.filter(o => o.cleared_at === null).length === 1, JSON.stringify(hist.body?.length));

    const activeId = hist.body.find(o => o.cleared_at === null).id;
    const c5 = await api('DELETE', `/formula/override/${activeId}`, { token: tok.admin });
    const e4 = await api('GET', `/formula/eval/${YEAR}/${MONTH}`, { token: tok.production });
    const k4 = (e4.body || []).find(r => r.key === 'kiln-output');
    check('clearing the override restores the formula value',
      c5.status === 200 && k4 && k4.value === 2000 && k4.overridden === false, JSON.stringify(k4 && k4.value));

    const hist2 = await api('GET', `/formula/overrides/${YEAR}/${MONTH}`, { token: tok.admin });
    check('cleared overrides remain in history (nothing deleted)',
      hist2.body && hist2.body.length === 2 && hist2.body.every(o => o.cleared_at !== null));

    const audit = await db.query(
      `SELECT action, COUNT(*)::int AS c FROM audit_log
       WHERE action IN ('KPI_OVERRIDE_SET','KPI_OVERRIDE_CLEARED') AND form_type LIKE 'kiln-output%'
       GROUP BY action`);
    const auditMap = Object.fromEntries(audit.rows.map(r => [r.action, r.c]));
    check('audit_log carries the full override trail (2 set, 1 cleared)',
      auditMap.KPI_OVERRIDE_SET === 2 && auditMap.KPI_OVERRIDE_CLEARED === 1, JSON.stringify(auditMap));

    // ── D. Structural: no formula math left in page JS ──────────────
    console.log('Part D — formulas live ONLY in the registry:');
    const kpiJs = fs.readFileSync(path.join(__dirname, '..', '..', 'kpi-data.js'), 'utf8');
    check('kpi-data.js contains no formula math (coal/ncv/kwh strings gone)',
      !/kiln_coal|kwhFields|pwr_.*_kwh/.test(kpiJs));
    const anJs = fs.readFileSync(path.join(__dirname, '..', '..', 'analytics.js'), 'utf8');
    check('analytics.js metric block has no inline formulas (registry-driven)',
      !/coal \* ncv|kwhFields/.test(anJs) && /NyatiFormulas/.test(anJs));

  } finally {
    child.kill();
    await cleanup();
    await db.end();
  }

  console.log(`\n${failCount === 0 ? '✅' : '❌'} Phase 3 acceptance: ${passCount} passed, ${failCount} failed.`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Acceptance run crashed:', err);
  try { await cleanup(); await db.end(); } catch { /* best effort */ }
  process.exit(1);
});
