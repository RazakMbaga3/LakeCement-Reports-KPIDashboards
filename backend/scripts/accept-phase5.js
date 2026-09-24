/*
  scripts/accept-phase5.js — Phase 5 acceptance tests (see docs/MASTER_BUILD_PROMPT.md).

  Proves reporting & distribution against a live server:
    A. daily report JSON: submissions + formula KPIs + missing-forms list
    B. daily printable HTML renders the real data
    C. daily XLSX opens as a valid workbook with the right sheets/values
    D-F. the same three for the monthly report (incl. override ⚑ flag)
    G. digest: composes yesterday-style email and sends through nodemailer
       (jsonTransport — no mail server needed to verify the pipeline)
    H. digest trigger is admin/md-only (403 for others)

  Cleans up after itself. Exits 0 only if all checks pass.
  Usage: npm run accept:phase5
*/

require('../config/env');
const { spawn } = require('child_process');
const path      = require('path');
const bcrypt    = require('bcryptjs');
const ExcelJS   = require('exceljs');
const db        = require('../db');

const PORT   = process.env.ACCEPT_PORT || 5905;
const BASE   = `http://localhost:${PORT}/api`;
const PW     = 'Accept@56789';
const YEAR   = 1999, MONTH = 5;
const DATES  = ['1999-05-01', '1999-05-02', '1999-05-03'];
const DAY2   = DATES[1];
const USERS  = { production: 'p5_production', logistics: 'p5_logistics', cpp: 'p5_cpp', admin: 'p5_admin' };
const DIGEST_TO = 'md@test.local';

let passCount = 0, failCount = 0;
function check(name, cond, extra) {
  if (cond) { passCount++; console.log(`  ✅ ${name}`); }
  else      { failCount++; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

async function api(method, pathname, { token, body, raw } = {}) {
  const headers = {};
  if (body)  headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') };
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or other */ }
  return { status: res.status, body: json, text, type: res.headers.get('content-type') };
}

async function loginToken(username) {
  const r = await api('POST', '/auth/login', { body: { username, password: PW } });
  if (r.status !== 200) throw new Error(`login ${username}: ${r.status}`);
  return r.body.token;
}

const KILN = [
  { kiln_prod_mt: 2000, kiln_coal_cons: 250, kiln_coal_ncv: 4800 },
  { kiln_prod_mt: 2100, kiln_coal_cons: 260, kiln_coal_ncv: 4900 },
  { kiln_prod_mt: 1900, kiln_coal_cons: 240, kiln_coal_ncv: 4700 },
];
const QUALITY  = [{ free_lime: 2.5 }, { free_lime: 2.8 }, { free_lime: 3.1 }];
const DISPATCH = [
  { dispatch_reg_425r: 1000, dispatch_reg_425n: 200, dispatch_blk_425r: 300, dispatch_bag_425r: 500 },
  { dispatch_reg_425r:  700, dispatch_reg_425n: 300, dispatch_blk_425r: 200, dispatch_bag_425r: 300 },
  { dispatch_reg_425r: 1200, dispatch_reg_425n: 400, dispatch_blk_425r: 400, dispatch_bag_425r: 500 },
];
const POWER = [
  { pwr_crusher_kwh: 5000, pwr_rawmill_kwh: 10000, pwr_coalmill_kwh: 5000, pwr_kiln_kwh: 15000,
    pwr_cm2_kwh: 8000, pwr_packing_kwh: 3000, pwr_lighting_kwh: 2000,
    pwr_kiln_prod_mt: 1500, pwr_cm2_prod_mt: 500 },
  { pwr_crusher_kwh: 5000, pwr_rawmill_kwh: 11000, pwr_coalmill_kwh: 5000, pwr_kiln_kwh: 16000,
    pwr_cm2_kwh: 8000, pwr_packing_kwh: 1000, pwr_lighting_kwh: 1000,
    pwr_kiln_prod_mt: 1600, pwr_cm2_prod_mt: 400 },
  { pwr_crusher_kwh: 5000, pwr_rawmill_kwh: 9000, pwr_coalmill_kwh: 4000, pwr_kiln_kwh: 15000,
    pwr_cm2_kwh: 7000, pwr_packing_kwh: 1000, pwr_lighting_kwh: 500,
    pwr_kiln_prod_mt: 1400, pwr_cm2_prod_mt: 600 },
];

async function seedTestUsers() {
  const hash = await bcrypt.hash(PW, 6);
  for (const [role, username] of Object.entries(USERS)) {
    await db.query(`
      INSERT INTO users (username, password_hash, full_name, role, department, active, must_change_password)
      VALUES ($1, $2, $3, $4, 'TEST', true, false)
      ON CONFLICT (username) DO UPDATE SET
        password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = true,
        must_change_password = false, failed_attempts = 0, locked_until = NULL, token_version = 0
    `, [username, hash, 'Phase5 Test ' + username, role]);
  }
}

async function cleanup() {
  const names = Object.values(USERS);
  await db.query(
    `DELETE FROM audit_log
     WHERE username = ANY($1)
        OR user_id IN (SELECT id FROM users WHERE username = ANY($1))`, [names]);
  await db.query(`DELETE FROM daily_reports WHERE record_date BETWEEN '1999-05-01' AND '1999-05-31'`);
  /* report_revisions is append-only in production — nothing in the app ever
     deletes from it, by design. An acceptance run is the one exception: it
     writes a revision for every sandbox submit, so without this each run
     leaves rows behind forever. Scoped to exactly the sandbox dates the
     daily_reports delete above uses, so a real revision can never be caught. */
  await db.query(`DELETE FROM report_revisions WHERE record_date BETWEEN '1999-05-01' AND '1999-05-31'`);
  await db.query('DELETE FROM kpi_overrides WHERE year = $1 AND month = $2', [YEAR, MONTH]);
  await db.query('DELETE FROM users WHERE username = ANY($1)', [names]);
}

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT, AUTH_RATE_LIMIT: '500',
      SMTP_HOST: '',                 // no real mail server in tests
      DIGEST_TRANSPORT: 'json',      // …but exercise the full send pipeline
      DIGEST_TO,
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
    try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return true; }
    catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  console.log('Phase 5 acceptance — booting server on port ' + PORT + '…\n');
  await seedTestUsers();
  const child = startServer();

  try {
    if (!(await waitForHealth())) {
      console.error('Server did not come up.\n--- output ---\n' + child.output());
      process.exit(1);
    }

    const tok = {};
    for (const [role, username] of Object.entries(USERS)) tok[role] = await loginToken(username);

    const submit = (token, form, date, data) =>
      api('POST', `/reports/${form}`, { token, body: { date, data } });
    for (let i = 0; i < DATES.length; i++) {
      await submit(tok.production, 'production', DATES[i], KILN[i]);
      await submit(tok.production, 'quality',    DATES[i], QUALITY[i]);
      await submit(tok.logistics,  'dispatch',   DATES[i], DISPATCH[i]);
      await submit(tok.cpp,        'power-cons', DATES[i], POWER[i]);
    }

    // ── A. Daily JSON ───────────────────────────────────────────
    console.log('Part A–C — daily report:');
    const dj = await api('GET', `/mis/daily/${DAY2}`, { token: tok.production });
    const kilnForm = dj.body?.forms?.find(f => f.formType === 'production');
    const kilnKpi  = dj.body?.kpis?.find(k => k.key === 'kiln-output');
    check('daily JSON: submissions + KPIs + missing list',
      dj.status === 200 && kilnForm &&
      kilnForm.fields.some(f => f.key === 'kiln_prod_mt' && Number(f.value) === 2100) &&
      kilnKpi && kilnKpi.value === 2100 &&
      dj.body.missing.includes('mines'), `status ${dj.status}`);

    // ── B. Daily HTML ───────────────────────────────────────────
    const dh = await api('GET', `/mis/daily/${DAY2}/html`, { token: tok.production });
    check('daily HTML renders real data (printable view)',
      dh.status === 200 && /text\/html/.test(dh.type) &&
      dh.text.includes('Daily MIS Report') && dh.text.includes('Production Summary') &&
      dh.text.includes('2,100') && dh.text.includes('No submission received'),
      `status ${dh.status}`);

    // ── C. Daily XLSX ───────────────────────────────────────────
    const dx = await api('GET', `/mis/daily/${DAY2}/xlsx`, { token: tok.production, raw: true });
    check('daily XLSX has the right content-type and ZIP magic',
      dx.status === 200 && /spreadsheetml/.test(dx.type) &&
      dx.buffer[0] === 0x50 && dx.buffer[1] === 0x4B, `status ${dx.status}, type ${dx.type}`);
    const dwb = new ExcelJS.Workbook();
    await dwb.xlsx.load(dx.buffer);
    const dKpiWs = dwb.getWorksheet('KPI Summary');
    let dailyKilnCell = null;
    dKpiWs?.eachRow(r => { if (r.getCell(1).value === 'Kiln Output') dailyKilnCell = r.getCell(4).value; });
    check('daily XLSX parses: KPI Summary + Production sheet + correct value',
      !!dKpiWs && !!dwb.getWorksheet('Production Summary') && dailyKilnCell === 2100,
      `kiln cell = ${JSON.stringify(dailyKilnCell)}`);

    // ── Override flows into the monthly report ──────────────────
    await api('POST', '/formula/override', { token: tok.admin, body: {
      kpi_key: 'kiln-output', year: YEAR, month: MONTH, value: 2050,
      reason: 'Weighbridge reconciliation for May test',
    } });

    // ── D. Monthly JSON ─────────────────────────────────────────
    console.log('Part D–F — monthly report:');
    const mj = await api('GET', `/mis/monthly/${YEAR}/${MONTH}`, { token: tok.production });
    const mKiln = mj.body?.kpis?.find(k => k.key === 'kiln-output');
    const mKilnForm = mj.body?.forms?.find(f => f.formType === 'production');
    check('monthly JSON: override applied, computed preserved, 3 day rows',
      mj.status === 200 && mKiln && mKiln.value === 2050 && mKiln.computed === 2000 &&
      mKiln.overridden === true && mKilnForm && mKilnForm.days.length === 3, `status ${mj.status}`);

    // ── E. Monthly HTML ─────────────────────────────────────────
    const mh = await api('GET', `/mis/monthly/${YEAR}/${MONTH}/html`, { token: tok.production });
    check('monthly HTML renders KPI summary + day-by-day + override flag ⚑',
      mh.status === 200 && mh.text.includes('Monthly KPI Summary') &&
      mh.text.includes('day by day') && mh.text.includes('⚑') &&
      mh.text.includes('Weighbridge reconciliation'), `status ${mh.status}`);

    // ── F. Monthly XLSX ─────────────────────────────────────────
    const mx = await api('GET', `/mis/monthly/${YEAR}/${MONTH}/xlsx`, { token: tok.production, raw: true });
    const mwb = new ExcelJS.Workbook();
    await mwb.xlsx.load(mx.buffer);
    const mKilnWs = mwb.getWorksheet('Production Summary');
    let mKpiCell = null;
    // monthly KPI sheet layout (with benchmark cols): 4=Actual … 10=Override note
    mwb.getWorksheet('KPI Summary')?.eachRow(r => {
      if (r.getCell(1).value === 'Kiln Output') mKpiCell = { v: r.getCell(4).value, note: r.getCell(10).value };
    });
    check('monthly XLSX parses: override value + note, 3 day rows on Production sheet',
      mx.status === 200 && mKpiCell && mKpiCell.v === 2050 &&
      /Weighbridge/.test(String(mKpiCell.note)) && mKilnWs && mKilnWs.rowCount === 4,
      JSON.stringify(mKpiCell));

    // ── G. Digest ───────────────────────────────────────────────
    console.log('Part G–H — morning digest:');
    const g1 = await api('POST', '/mis/digest/send', { token: tok.admin, body: { date: DAY2 } });
    check('digest sends through the mail pipeline (jsonTransport)',
      g1.status === 200 && g1.body.sent === true && g1.body.transport === 'json' &&
      g1.body.to.includes(DIGEST_TO), JSON.stringify(g1.body));
    const msg = g1.body.message || {};
    check('digest email carries the day\'s KPIs vs target',
      /1999-05-02/.test(msg.subject || '') &&
      /Kiln Output/.test(msg.html || '') && /2,100/.test(msg.html || ''),
      `subject: ${msg.subject}`);

    // ── H. RBAC ─────────────────────────────────────────────────
    const g2 = await api('POST', '/mis/digest/send', { token: tok.production, body: {} });
    check('digest trigger is admin/md-only (403 for production)', g2.status === 403, `got ${g2.status}`);

  } finally {
    child.kill();
    await cleanup();
    await db.end();
  }

  console.log(`\n${failCount === 0 ? '✅' : '❌'} Phase 5 acceptance: ${passCount} passed, ${failCount} failed.`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Acceptance run crashed:', err);
  try { await cleanup(); await db.end(); } catch { /* best effort */ }
  process.exit(1);
});
