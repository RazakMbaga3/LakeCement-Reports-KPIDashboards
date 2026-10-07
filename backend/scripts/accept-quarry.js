/*
  scripts/accept-quarry.js — Quarry weighbridge ticket log acceptance tests
  (see the "Quarry Report Redesign" plan — backend/routes/quarry.js,
  db/migrations/005_weighbridge_tickets.sql).

  Proves the new endpoints end-to-end:
    1. import is upsert-by-ticket_no (added vs. updated counts correct on
       a re-import of the same file)
    2. GET with a date range filters correctly; GET with no range returns
       everything
    3. import is role-gated to mining/admin (403 for other roles),
       both endpoints require auth (401 anonymous)
    4. a malformed row (missing movement_type) is rejected (400) and
       doesn't get half-committed
    5. the existing generic daily_reports/'mines' endpoints (reused for
       month config / opening stock / manual daily fields — see the
       'all' vs 'day' shift convention in mines-report.html) still
       round-trip correctly, since the new page depends on them too
    6. GET /tickets/summary (RAID I-19/I-32) aggregates correctly: same
       auth gate, range filter, and — the one that matters — its
       SUM(net_qty) and row-level ticket counts match the raw log
       exactly, since mines-report.html now trusts this instead of the
       raw rows for every figure it renders

  Cleans up after itself. Exits 0 only if all checks pass.
  Usage: node scripts/accept-quarry.js
*/
require('../config/env');
const { spawn } = require('child_process');
const path       = require('path');
const bcrypt     = require('bcryptjs');
const db         = require('../db');

const PORT   = process.env.ACCEPT_PORT || 5920;
const BASE   = `http://localhost:${PORT}/api`;
const PW     = 'AcceptQuarry@2026';
const USERS  = { mining: 'aq_mining', admin: 'aq_admin', other: 'aq_other' };
const DATE_A = '1998-05-01';
const DATE_B = '1998-05-02';

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
  const rows = [[USERS.mining, 'mining'], [USERS.admin, 'admin'], [USERS.other, 'production']];
  for (const [username, role] of rows) {
    await db.query(`
      INSERT INTO users (username, password_hash, full_name, role, department, active, must_change_password)
      VALUES ($1, $2, $3, $4, 'TEST', true, false)
      ON CONFLICT (username) DO UPDATE SET
        password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = true,
        must_change_password = false, failed_attempts = 0, locked_until = NULL, token_version = 0
    `, [username, hash, 'Accept-Quarry Test ' + username, role]);
  }
}
async function cleanup() {
  const names = Object.values(USERS);
  await db.query(`DELETE FROM weighbridge_tickets WHERE ticket_no LIKE 'AQ-%'`);
  await db.query(`DELETE FROM daily_reports WHERE form_type = 'mines' AND record_date BETWEEN '1998-05-01' AND '1998-05-31'`);
  await db.query(`DELETE FROM audit_log WHERE username = ANY($1) OR user_id IN (SELECT id FROM users WHERE username = ANY($1))`, [names]);
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
async function waitFor(url, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(url); if (res.status === 200) return true; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

function ticket(no, overrides) {
  return Object.assign({
    ticketNo: no, vendor: 'Test Vendor', vehicle: 'T123',
    transferType: 'Production', movementType: 'South Mine to Pile (through Crusher)',
    product: 'HG', date: DATE_A, netQty: 12.5, grossDatetime: '',
  }, overrides);
}

async function main() {
  console.log('Quarry acceptance — booting server on port ' + PORT + '…\n');
  await seedTestUsers();
  const child = startServer();

  try {
    if (!(await waitFor(`http://localhost:${PORT}/api/health`))) {
      console.error('Server did not come up.\n--- output ---\n' + child.output());
      process.exit(1);
    }
    const miningTok = await loginToken(USERS.mining);
    const adminTok  = await loginToken(USERS.admin);
    const otherTok  = await loginToken(USERS.other);

    // ── auth gating ──────────────────────────────────────────────
    const anonImport = await api('POST', '/quarry/tickets/import', { body: { rows: [ticket('AQ-1')] } });
    check('import rejects anonymous (401)', anonImport.status === 401, `got ${anonImport.status}`);

    const otherImport = await api('POST', '/quarry/tickets/import', { token: otherTok, body: { rows: [ticket('AQ-1')] } });
    check('import rejects non mining/admin role (403)', otherImport.status === 403, `got ${otherImport.status}`);

    const anonGet = await api('GET', '/quarry/tickets');
    check('GET tickets rejects anonymous (401)', anonGet.status === 401, `got ${anonGet.status}`);

    // ── malformed row rejected, nothing half-committed ──────────
    const badImport = await api('POST', '/quarry/tickets/import', {
      token: miningTok, body: { rows: [ticket('AQ-BAD', { movementType: '' })] },
    });
    check('malformed row (empty movementType) rejected with 400', badImport.status === 400, `got ${badImport.status}`);
    const afterBad = await api('GET', '/quarry/tickets', { token: miningTok });
    check('rejected import left nothing behind', !(afterBad.body || []).some(t => t.ticket_no === 'AQ-BAD'));

    // ── import: added vs updated, dedupe by ticket_no ──────────
    const rows1 = [
      ticket('AQ-1', { movementType: 'South Mine to Pile (through Crusher)', product: 'HG', netQty: 100, date: DATE_A }),
      ticket('AQ-2', { movementType: 'Stock Yard to Pile (through Crusher)', product: 'HG', transferType: 'Internal', netQty: 50, date: DATE_A }),
      ticket('AQ-3', { movementType: 'South Mine to Golani Waste dump', product: 'WASTE', netQty: 40, date: DATE_B }),
    ];
    const imp1 = await api('POST', '/quarry/tickets/import', { token: miningTok, body: { rows: rows1 } });
    check('first import: all 3 added', imp1.status === 200 && imp1.body.added === 3 && imp1.body.updated === 0,
      JSON.stringify(imp1.body));
    check('first import: dmin/dmax span the batch', imp1.body && imp1.body.dmin === DATE_A && imp1.body.dmax === DATE_B);

    const rows2 = [ ticket('AQ-1', { netQty: 111, date: DATE_A }), ticket('AQ-4', { netQty: 5, date: DATE_A }) ];
    const imp2 = await api('POST', '/quarry/tickets/import', { token: adminTok, body: { rows: rows2 } });
    check('second import: 1 added (AQ-4) + 1 updated (AQ-1), admin role also allowed',
      imp2.status === 200 && imp2.body.added === 1 && imp2.body.updated === 1, JSON.stringify(imp2.body));

    // ── GET: range filter + qty actually updated ────────────────
    const ranged = await api('GET', `/quarry/tickets?from=${DATE_A}&to=${DATE_A}`, { token: miningTok });
    const byNo = {}; (ranged.body || []).forEach(t => { byNo[t.ticket_no] = t; });
    check('ranged GET returns only DATE_A rows (AQ-1, AQ-2, AQ-4 - not AQ-3)',
      ranged.status === 200 && byNo['AQ-1'] && byNo['AQ-2'] && byNo['AQ-4'] && !byNo['AQ-3'],
      JSON.stringify((ranged.body || []).map(t => t.ticket_no)));
    check('updated ticket reflects the new net_qty (upsert, not duplicate row)',
      byNo['AQ-1'] && Number(byNo['AQ-1'].net_qty) === 111);

    const all = await api('GET', '/quarry/tickets', { token: miningTok });
    const allNos = new Set((all.body || []).map(t => t.ticket_no));
    check('unranged GET returns the whole log, including DATE_B (AQ-3)',
      all.status === 200 && ['AQ-1', 'AQ-2', 'AQ-3', 'AQ-4'].every(n => allNos.has(n)));

    // ── GET /tickets/summary — collapses to one row per date+movement+
    //    product+vendor, SUM(net_qty) == the raw rows it stands in for
    //    (RAID I-19/I-32: this is what mines-report.html's bulk load now
    //    calls instead of GET /tickets with no range) ──
    const anonSummary = await api('GET', '/quarry/tickets/summary');
    check('GET tickets/summary rejects anonymous (401)', anonSummary.status === 401, `got ${anonSummary.status}`);

    const summaryA = await api('GET', `/quarry/tickets/summary?from=${DATE_A}&to=${DATE_A}`, { token: miningTok });
    const crusherRow = (summaryA.body || []).find(r => r.movement_type === 'South Mine to Pile (through Crusher)' && r.product === 'HG');
    const stockRow   = (summaryA.body || []).find(r => r.movement_type === 'Stock Yard to Pile (through Crusher)' && r.product === 'HG');
    check('ranged summary collapses AQ-1 (111) + AQ-4 (5) into one 116 MT / 2-ticket row',
      summaryA.status === 200 && crusherRow && Number(crusherRow.net_qty) === 116 && crusherRow.n === 2,
      JSON.stringify(summaryA.body));
    check('ranged summary keeps AQ-2 (different movement_type) as its own 50 MT row',
      stockRow && Number(stockRow.net_qty) === 50 && stockRow.n === 1);
    check('ranged summary excludes DATE_B (AQ-3, WASTE)',
      !(summaryA.body || []).some(r => r.product === 'WASTE'));

    const summaryAll = await api('GET', '/quarry/tickets/summary', { token: miningTok });
    const wasteRow = (summaryAll.body || []).find(r => r.product === 'WASTE');
    const summedTickets = (summaryAll.body || []).reduce((n, r) => n + r.n, 0);
    const summedQty     = (summaryAll.body || []).reduce((s, r) => s + Number(r.net_qty), 0);
    const rawTotalQty = (all.body || []).reduce((s, t) => s + Number(t.net_qty), 0);
    check('unranged summary includes DATE_B (AQ-3, WASTE, 40 MT)',
      summaryAll.status === 200 && wasteRow && Number(wasteRow.net_qty) === 40 && wasteRow.n === 1);
    check('summary ticket count matches the raw log\'s row count (4)',
      summedTickets === (all.body || []).length, `summary counted ${summedTickets}, raw log has ${(all.body || []).length}`);
    // This DB is shared with whatever real data a prior backfill left in
    // it (not wiped between runs), so both totals are sums over tens of
    // thousands of rows — the two summation orders (Postgres NUMERIC
    // server-side vs. JS float64 reduce here) can differ in the last
    // couple of decimal places of a million-plus MT total. 0.001 MT is
    // still six orders of magnitude tighter than that noise floor.
    check('summary net_qty total matches the raw log\'s total (aggregation loses no tonnage)',
      Math.abs(summedQty - rawTotalQty) < 1e-3, `summary ${summedQty} vs raw ${rawTotalQty}`);

    // ── reused daily_reports/'mines' endpoints (month config + daily manual) ──
    const monthSubmit = await api('POST', '/reports/mines', {
      token: miningTok, body: { date: '1998-05-01', shift: 'all', data: { openings: { HG: 10, LG1: 20 }, monthConfig: { day1Rule: true } } },
    });
    check('month-config record (shift=all) accepted on the existing mines form_type', monthSubmit.status === 200, `got ${monthSubmit.status}`);
    const monthGet = await api('GET', '/reports/mines/1998-05-01?shift=all', { token: miningTok });
    check('month-config round-trips', monthGet.status === 200 && monthGet.body && monthGet.body.data.openings.HG === 10);

    const daySubmit = await api('POST', '/reports/mines', {
      token: miningTok, body: { date: '1998-05-02', shift: 'day', data: { aw: 3, ax: 0, ay: 0, signoff: { sup: 'A. Tester' } } },
    });
    check('daily-manual record (shift=day) accepted on the existing mines form_type', daySubmit.status === 200, `got ${daySubmit.status}`);
    const dayGet = await api('GET', '/reports/mines/1998-05-02?shift=day', { token: miningTok });
    check('daily-manual round-trips', dayGet.status === 200 && dayGet.body && dayGet.body.data.signoff.sup === 'A. Tester');

  } finally {
    child.kill();
    await cleanup();
    await db.end();
  }

  console.log(`\n${failCount === 0 ? '✅' : '❌'} Quarry acceptance: ${passCount} passed, ${failCount} failed.`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Acceptance run crashed:', err);
  try { await cleanup(); await db.end(); } catch { /* best effort */ }
  process.exit(1);
});
