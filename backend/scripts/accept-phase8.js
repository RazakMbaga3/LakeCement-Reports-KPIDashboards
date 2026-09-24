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
const USERS = { production: 'p8_production', admin: 'p8_admin' };

let passCount = 0, failCount = 0;
function check(name, cond, extra) {
  if (cond) { passCount++; console.log(`  ✅ ${name}`); }
  else      { failCount++; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}
const close = (a, b, eps = 0.02) => a !== null && b !== null && Math.abs(a - b) <= eps;

/* A Pareto is only a Pareto if its cumulative curve never dips and lands on
   100% — that single property catches a wrong sort order, a share taken
   against the wrong denominator, and a rounding drift that would draw the
   curve above its own axis, all at once. */
function paretoCumOk(rows) {
  if (!Array.isArray(rows) || !rows.length) return false;
  for (let i = 0; i < rows.length; i++) {
    if (typeof rows[i].cumPct !== 'number' || rows[i].cumPct > 100.01) return false;
    if (i > 0 && rows[i].cumPct < rows[i - 1].cumPct - 1e-9) return false;
  }
  return Math.abs(rows[rows.length - 1].cumPct - 100) <= 0.5;
}
function sortedDesc(rows, key) {
  return rows.every((r, i) => i === 0 || rows[i - 1][key] >= r[key]);
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
    const admin = await loginToken(USERS.admin);
    /* Fails loudly. This helper used to ignore the HTTP status, and the
       Part C comment below records it biting once already (a stale submitter
       403ing silently, seeding the whole section with nothing). It then bit a
       second time when the report lock landed and a re-submit over an
       already-approved day started returning 409 — the seed silently did
       nothing and four downstream checks failed with confusing data rather
       than one check failing at the real cause. A seed that cannot seed is
       never a pass. */
    const submit = async (token, form, date, data) => {
      const r = await api('POST', `/reports/${form}`, { token, body: { date, data } });
      if (r.status >= 300) {
        throw new Error(`seed submit ${form} ${date}: HTTP ${r.status} ` +
          (r.body && r.body.error ? '— ' + r.body.error : ''));
      }
      return r;
    };

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
    // Stoppage submit rights transferred from P&M to Production on
    // 2026-09-22 (Production now fills AND, as sole submitter, its own
    // HOD approves it — see forms/access-registry.js FORM_ACCESS).
    // submit() below doesn't check the HTTP status, so a stale submitter
    // here would 403 silently and leave this whole section seeded with
    // nothing rather than failing loudly at the point of the mistake —
    // exactly what happened when this still said `pm`.
    console.log('Part C — stoppage intelligence:');

    /* The coarse matrix and the named-reason hours are seeded in ONE submit
       per day, because that is how the real form posts them — stoppage-form
       writes stop_<equip>_<cause> and stopr_<reasonId> in the same payload.
       They used to be two passes, the second relying on a re-submit MERGING
       into the already-approved row. The report lock ended that on
       2026-09-24: an approved day can no longer be silently overwritten, so
       the second pass now correctly 409s. Merging the seed is the honest fix
       — re-approving a signed report to add test data is the behaviour the
       lock exists to prevent. */
    const rsn = (await db.query(
      `SELECT id, equipment, cause, label FROM stoppage_reasons
       WHERE equipment IN ('kiln','crusher') AND is_active
       ORDER BY equipment, id`)).rows;
    const rA = rsn.find(r => r.equipment === 'kiln');
    const rB = rsn.find(r => r.equipment === 'crusher');
    if (!rA || !rB) throw new Error('stoppage_reasons catalogue is empty — migration 017 not applied?');

    await submit(prod, 'stoppage', '1999-07-01', {
      stop_kiln_mech: 5 * 60, stop_kiln_ei: 2 * 60, stop_crusher_other: 1 * 60,
      ['stopr_' + rA.id]: 5, ['stopr_' + rB.id]: 1,
    });
    await submit(prod, 'stoppage', '1999-07-02', {
      stop_kiln_mech: 3 * 60,
      ['stopr_' + rA.id]: 3,
    });
    // Reason hours with no coarse matrix — leaves the coarse totals above intact.
    await submit(prod, 'stoppage', '1999-07-03', { ['stopr_' + rA.id]: 2 });

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

    check('cause Pareto pair: both cumulative curves rise monotonically to 100%',
      paretoCumOk(s.pareto) && paretoCumOk(s.paretoByFreq),
      JSON.stringify({ h: s.pareto.map(r => r.cumPct), f: s.paretoByFreq.map(r => r.cumPct) }));

    // ── C2. Reason-level Pareto pair (the named 417-term vocabulary) ──
    // The stoppage form writes one DECIMAL-HOUR field per named reason,
    // stopr_<reasonId>, alongside the coarse matrix above. "Frequency" at
    // this level can only honestly be DAYS WITH DOWNTIME — no table records
    // per-incident start/end times — so the API names the field `days`.
    console.log('Part C2 — reason-level Pareto (stopr_<id> → stoppage_reasons):');
    // Seeded above, in one submit per day. A: 5 + 3 + 2 = 10h over 3 distinct
    // days. B: 1h on 1 day.
    const st2 = await api('GET', '/insights/stoppages?from=1999-07-01&to=1999-07-31', { token: prod });
    const sr = st2.body;
    const rp = sr && sr.reasonPareto, rpf = sr && sr.reasonParetoByFreq;

    check('reasonPareto: available, ranked by hours, reason labels joined from the catalogue',
      st2.status === 200 && rp && rp.available === true && rp.rows.length === 2 &&
      rp.rows[0].reasonId === rA.id && rp.rows[0].label === rA.label &&
      rp.rows[0].equipment === 'kiln' && rp.rows[0].equipmentLabel === 'Kiln' &&
      rp.rows[0].causeLabel && close(rp.rows[0].hours, 10) && rp.rows[0].days === 3,
      rp ? JSON.stringify(rp.rows) : `status ${st2.status}`);

    check('reasonPareto: hours ranking sorted desc with cumPct rising to 100%',
      rp && rp.available && sortedDesc(rp.rows, 'hours') && paretoCumOk(rp.rows) &&
      close(rp.rows[0].pct, 90.91, 0.05),
      rp && JSON.stringify(rp.rows.map(r => ({ h: r.hours, pct: r.pct, cum: r.cumPct }))));

    check('reasonParetoByFreq: ranked by DAYS WITH DOWNTIME (not hours), cumPct to 100%',
      rpf && rpf.available === true && rpf.rows.length === 2 &&
      rpf.rows[0].reasonId === rA.id && rpf.rows[0].days === 3 && rpf.rows[1].days === 1 &&
      sortedDesc(rpf.rows, 'days') && paretoCumOk(rpf.rows) &&
      // share is of the summed DAY counts (3+1), never of hours
      close(rpf.rows[0].pct, 75, 0.05),
      rpf && JSON.stringify(rpf.rows.map(r => ({ d: r.days, pct: r.pct, cum: r.cumPct }))));

    check('reasonParetoByFreq exposes `days` and never an `events` incident count',
      rpf && rpf.rows.every(r => typeof r.days === 'number' && r.events === undefined),
      rpf && JSON.stringify(Object.keys(rpf.rows[0] || {})));

    check('coverage: reports days actually carrying reason data, per source',
      sr && sr.coverage && sr.coverage.daysInRange === 31 &&
      sr.coverage.daysWithReasonData === 3 && sr.coverage.daysFromEntryForm === 3 &&
      sr.coverage.daysFromImport === 0 && sr.coverage.reasonsLogged === 2 &&
      sr.coverage.catalogueSize > 0 && sr.coverage.sources.includes('entry-form'),
      sr && JSON.stringify(sr.coverage));

    // Honest empty state, not a zeroed chart frame, for a range with none.
    const st3 = await api('GET', '/insights/stoppages?from=1999-08-01&to=1999-08-31', { token: prod });
    check('reason Pareto empty state says what would fill it (no fake zeros)',
      st3.body && st3.body.reasonPareto.available === false &&
      st3.body.reasonPareto.rows.length === 0 &&
      /stopr_|import-stoppage-facts/.test(st3.body.reasonPareto.message) &&
      st3.body.coverage.daysWithReasonData === 0,
      st3.body && JSON.stringify(st3.body.reasonPareto).slice(0, 160));

    // ── C3. Per-equipment named-fault Pareto pair ───────────────
    const eq = await api('GET', '/insights/stoppages/kiln?from=1999-07-01&to=1999-07-31', { token: prod });
    check('equipment detail returns faultParetoByFreq beside faultPareto',
      eq.status === 200 && eq.body.faultPareto && eq.body.faultParetoByFreq,
      `status ${eq.status}, keys ${eq.body && Object.keys(eq.body).join(',')}`);
    check('faultParetoByFreq keeps the honest empty state when no workbook covers the range',
      eq.body && eq.body.faultParetoByFreq.available === false &&
      typeof eq.body.faultParetoByFreq.message === 'string',
      eq.body && JSON.stringify(eq.body.faultParetoByFreq).slice(0, 160));

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
