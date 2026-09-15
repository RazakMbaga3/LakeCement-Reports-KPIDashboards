/*
  scripts/accept-phase8.js — Phase 8 acceptance tests (see docs/MASTER_BUILD_PROMPT.md).

  Proves the moat features against a live server:
    A. field baseline: mean/σ over a trailing window match hand-coded stats
       (the numbers behind the unusual-value prompt at submit time)
    B. benchmarking: KPI vs previous month / same month last year / best-ever /
       rolling-3, and the benchmark columns flow into the monthly MIS report
    C. stoppage intelligence: Pareto by cause, per-equipment MTTR/MTBF
    D. institutional memory: text search hits form entries, override reasons
       and the audit trail
    E. structural: form-persist.js performs the baseline check at submit

  Cleans up after itself. Exits 0 only if all checks pass.
  Usage: npm run accept:phase8
*/

require('../config/env');
const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');
const bcrypt    = require('bcryptjs');
const db        = require('../db');

const PORT  = process.env.ACCEPT_PORT || 5910;
const BASE  = `http://localhost:${PORT}/api`;
const PW    = 'Accept@89012';
const USERS = { production: 'p8_production', pm: 'p8_pm', admin: 'p8_admin' };

let passCount = 0, failCount = 0;
function check(name, cond, extra) {
  if (cond) { passCount++; console.log(`  ✅ ${name}`); }
  else      { failCount++; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}
const close = (a, b, eps = 0.02) => a !== null && b !== null && Math.abs(a - b) <= eps;

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

async function seedTestUsers() {
  const hash = await bcrypt.hash(PW, 6);
  for (const [role, username] of Object.entries(USERS)) {
    await db.query(`
      INSERT INTO users (username, password_hash, full_name, role, department, active, must_change_password)
      VALUES ($1, $2, $3, $4, 'TEST', true, false)
      ON CONFLICT (username) DO UPDATE SET
        password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = true,
        must_change_password = false, failed_attempts = 0, locked_until = NULL, token_version = 0
    `, [username, hash, 'Phase8 Test ' + username, role]);
  }
}

async function cleanup() {
  const names = Object.values(USERS);
  await db.query(
    `DELETE FROM audit_log
     WHERE username = ANY($1)
        OR user_id IN (SELECT id FROM users WHERE username = ANY($1))
        OR details LIKE '%ACCEPT8%'`, [names]);
  await db.query(`DELETE FROM daily_reports WHERE record_date BETWEEN '1998-07-01' AND '1998-07-31'
                  OR record_date BETWEEN '1999-06-01' AND '1999-07-31'`);
  await db.query(`DELETE FROM kpi_overrides WHERE reason LIKE '%ACCEPT8%'`);
  await db.query('DELETE FROM users WHERE username = ANY($1)', [names]);
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

async function main() {
  console.log('Phase 8 acceptance — booting server on port ' + PORT + '…\n');
  await seedTestUsers();
  const child = startServer();

  try {
    if (!(await waitForHealth())) {
      console.error('Server did not come up.\n--- output ---\n' + child.output());
      process.exit(1);
    }

    const prod  = await loginToken(USERS.production);
    const pm    = await loginToken(USERS.pm);   // stoppage is P&M-owned
    const admin = await loginToken(USERS.admin);
    const submit = (token, form, date, data) =>
      api('POST', `/reports/${form}`, { token, body: { date, data } });

    // ── Seed: production (kiln fields) 1999-07-01..10 → mean 2000, population σ ≈ 70.71 ──
    const PRODS = [2000, 2100, 1900, 2050, 1950, 2000, 2100, 1900, 2050, 1950];
    for (let i = 0; i < PRODS.length; i++) {
      await submit(prod, 'production', `1999-07-${String(i + 1).padStart(2, '0')}`, { kiln_prod_mt: PRODS[i] });
    }
    // benchmark months: 1999-06 (avg 2000) and 1998-07 (avg 1800)
    for (const [d, v] of [['1999-06-10', 1950], ['1999-06-11', 2000], ['1999-06-12', 2050]]) {
      await submit(prod, 'production', d, { kiln_prod_mt: v });
    }
    for (const [d, v] of [['1998-07-10', 1750], ['1998-07-11', 1800], ['1998-07-12', 1850]]) {
      await submit(prod, 'production', d, { kiln_prod_mt: v });
    }

    // ── A. Baseline stats ───────────────────────────────────────
    console.log('Part A — field baseline (anomaly-at-entry math):');
    const bl = await api('GET', '/insights/baseline/production?days=15&before=1999-07-11', { token: prod });
    const f = bl.body?.fields?.kiln_prod_mt;
    check('baseline returns n / mean / σ for kiln_prod_mt',
      bl.status === 200 && f && f.n === 10, f ? JSON.stringify(f) : `status ${bl.status}`);
    check('mean = 2000, population σ ≈ 70.71',
      f && close(f.mean, 2000) && close(f.sd, 70.7107), f && `mean ${f.mean}, sd ${f.sd}`);

    // ── B. Benchmarking ─────────────────────────────────────────
    console.log('Part B — historical benchmarking:');
    // 1999-07 mean = (sum PRODS)/10 = 2000 — bump it so it differs from prev month
    await submit(prod, 'production', '1999-07-11', { kiln_prod_mt: 4200 }); // pulls avg to ≈2200
    const bm = await api('GET', '/insights/benchmark/1999/7', { token: prod });
    const kb = (bm.body || []).find(b => b.key === 'kiln-output');
    check('benchmark: current / prev month / same month last year',
      bm.status === 200 && kb && close(kb.current, 2200) &&
      kb.prevMonth.period === '1999-06' && close(kb.prevMonth.value, 2000) &&
      kb.lastYear.period === '1998-07' && close(kb.lastYear.value, 1800),
      kb ? JSON.stringify({ c: kb.current, p: kb.prevMonth, ly: kb.lastYear }) : `status ${bm.status}`);
    check('benchmark: best-ever tracked with its period',
      kb && kb.bestEver && kb.bestEver.value >= 2200 && /^\d{4}-\d{2}$/.test(kb.bestEver.period),
      kb && JSON.stringify(kb.bestEver));
    check('benchmark: rolling 3-month average present',
      kb && typeof kb.rolling3 === 'number' && close(kb.rolling3, (2200 + 2000) / 2),
      kb && `rolling3 ${kb.rolling3}`);

    // benchmarks flow into the monthly MIS report
    const mh = await api('GET', '/mis/monthly/1999/7/html', { token: prod });
    check('monthly MIS report shows Prev month / Last year / Best ever columns',
      mh.status === 200 && mh.text.includes('Prev month') && mh.text.includes('Same month LY') &&
      mh.text.includes('Best ever') && mh.text.includes('1999-06'), `status ${mh.status}`);

    // ── C. Stoppage intelligence ────────────────────────────────
    // Stoppage fields are persisted in MINUTES (see services/insights.js
    // stoppageInsights(): `const h = mins / 60`, matching the real
    // stoppage-form.html — each field is a per-day minute ledger, up to
    // 1440). Values below are hours × 60 so the expected totals further
    // down (in hours) come out to round numbers.
    console.log('Part C — stoppage intelligence:');
    await submit(pm, 'stoppage', '1999-07-01',
      { stop_kiln_mech: 5 * 60, stop_kiln_ei: 2 * 60, stop_crusher_other: 1 * 60 });
    await submit(pm, 'stoppage', '1999-07-02', { stop_kiln_mech: 3 * 60 });

    const st = await api('GET', '/insights/stoppages?from=1999-07-01&to=1999-07-31', { token: prod });
    const s = st.body;
    check('stoppage totals + Pareto ordered by hours (mech first)',
      st.status === 200 && close(s.totalHours, 11) &&
      s.pareto[0].cause === 'mech' && close(s.pareto[0].hours, 8) &&
      close(s.pareto[0].pct, 72.7, 0.2), s ? JSON.stringify(s.pareto) : `status ${st.status}`);
    const kilnEq = s.equipment.find(e => e.key === 'kiln');
    check('per-equipment MTTR/MTBF/availability (kiln: 10h over 3 events)',
      kilnEq && close(kilnEq.hours, 10) && kilnEq.events === 3 &&
      close(kilnEq.mttrHours, 3.33, 0.01) && kilnEq.availabilityPct < 100,
      kilnEq && JSON.stringify(kilnEq));

    // ── D. Institutional memory search ──────────────────────────
    console.log('Part D — institutional memory:');
    await submit(prod, 'quality', '1999-07-05',
      { free_lime: 2.6, shift_remarks: 'ACCEPT8 cooler fan tripped, reduced kiln feed for 2 hours' });
    await api('POST', '/formula/override', { token: admin, body: {
      kpi_key: 'kiln-output', year: 1999, month: 7, value: 2210,
      reason: 'ACCEPT8 weighbridge recalibration adjustment' } });

    const s1 = await api('GET', '/insights/search?q=' + encodeURIComponent('ACCEPT8 cooler'), { token: prod });
    check('search finds the form entry with a field snippet',
      s1.status === 200 && s1.body.forms.length === 1 &&
      s1.body.forms[0].formType === 'quality' && s1.body.forms[0].date === '1999-07-05' &&
      /cooler fan tripped/.test(s1.body.forms[0].snippets.join(' ')),
      JSON.stringify(s1.body && s1.body.forms));

    const s2 = await api('GET', '/insights/search?q=ACCEPT8', { token: prod });
    check('search finds override reasons and audit trail entries',
      s2.body.overrides.some(o => /weighbridge recalibration/.test(o.reason)) &&
      s2.body.audit.some(a => /ACCEPT8/.test(a.details || '')),
      JSON.stringify({ ov: s2.body.overrides.length, audit: s2.body.audit.length }));

    const s3 = await api('GET', '/insights/search?q=ab', { token: prod });
    check('search rejects too-short queries (400)', s3.status === 400, `got ${s3.status}`);

    // ── E. Structural: entry-time anomaly check is wired ────────
    const fp = fs.readFileSync(path.join(__dirname, '..', '..', 'forms', 'form-persist.js'), 'utf8');
    check('form-persist.js runs the baseline check at submit time',
      /getBaseline/.test(fp) && /_unusualValues/.test(fp) && /2 \* s\.sd/.test(fp) &&
      /UNUSUAL VALUES/.test(fp));

  } finally {
    child.kill();
    await cleanup();
    await db.end();
  }

  console.log(`\n${failCount === 0 ? '✅' : '❌'} Phase 8 acceptance: ${passCount} passed, ${failCount} failed.`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Acceptance run crashed:', err);
  try { await cleanup(); await db.end(); } catch { /* best effort */ }
  process.exit(1);
});
