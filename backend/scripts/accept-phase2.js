/*
  scripts/accept-phase2.js — Phase 2 acceptance tests (see docs/MASTER_BUILD_PROMPT.md).

  Part A — data layer: every one of the 11 form types submits to Postgres via
  the API (using a role allowed to submit it) and reads back identically from
  a SECOND authenticated session (the "two browsers see the same data" rule).

  Part B — offline queue: loads the REAL forms/offline-queue.js the browser
  runs and proves, against the live server:
    B1  server down  → submission stays queued (no data loss, no crash)
    B2  server back  → queued entry auto-flushes into Postgres
    B3  conflict     → server record newer than the queued one is NOT
                       overwritten; the item is flagged for review
    B4  "use mine"   → resolving a conflict pushes the queued data
    B5  "keep server"→ resolving discards the queued data, server intact
    B6  permanent rejection (403 role) → flagged for review, not retried

  Cleans up its users, audit rows and test report rows. Exits 0 only if all
  checks pass.   Usage: npm run accept:phase2
*/

require('../config/env');
const { spawn } = require('child_process');
const path      = require('path');
const bcrypt    = require('bcryptjs');
const db        = require('../db');
const { ROLE_FORM_ACCESS } = require('../config/formAccess');
const { createQueue }      = require('../../forms/offline-queue.js');

const PORT       = process.env.ACCEPT_PORT || 5903;
const BASE       = `http://localhost:${PORT}/api`;
const DEAD_BASE  = `http://localhost:59021/api`; // nothing listens here
const PW         = 'Accept@23456';
const DATE_A     = '1999-02-11'; // round-trip date (all 13 forms)
const DATE_CLEAN = ['1999-02-11', '1999-02-20']; // cleanup range
const USERS      = { production: 'p2_production', cpp: 'p2_cpp', logistics: 'p2_logistics', mining: 'p2_mining',
                     pm: 'p2_pm', stores: 'p2_stores' };
const ALL_FORMS  = ['production', 'mines', 'dispatch', 'quality', 'power-cons',
                    'limestone', 'materials', 'pile-quality', 'cpp', 'stoppage'];

let passCount = 0, failCount = 0;
function check(name, cond, extra) {
  if (cond) { passCount++; console.log(`  ✅ ${name}`); }
  else      { failCount++; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

/* Minimal mirror of forms/api-client.js (which is window-scoped): same
   endpoints, same err.status contract the queue depends on. */
function makeApi(base, getToken) {
  async function call(method, pathname, body) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(base + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    return res.json();
  }
  return {
    getForm:    (f, d, s)       => call('GET', `/reports/${f}/${d}` + (s ? `?shift=${s}` : '')),
    submitForm: (f, d, s, data) => call('POST', `/reports/${f}`, { date: d, shift: s || 'day', data }),
  };
}

function fakeStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

async function loginToken(username) {
  const res = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PW }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`login ${username} failed: ${res.status}`);
  return body.token;
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
    `, [username, hash, 'Phase2 Test ' + username, role]);
  }
}

async function cleanup() {
  const names = Object.values(USERS);
  await db.query(
    `DELETE FROM audit_log
     WHERE username = ANY($1)
        OR user_id IN (SELECT id FROM users WHERE username = ANY($1))`, [names]);
  await db.query('DELETE FROM daily_reports WHERE record_date BETWEEN $1 AND $2', DATE_CLEAN);
  /* report_revisions is append-only in production — nothing in the app ever
     deletes from it, by design. An acceptance run is the one exception: it
     writes a revision for every sandbox submit, so without this each run
     leaves rows behind forever. Scoped to exactly the sandbox dates the
     daily_reports delete above uses, so a real revision can never be caught. */
  await db.query('DELETE FROM report_revisions WHERE record_date BETWEEN $1 AND $2', DATE_CLEAN);
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
  console.log('Phase 2 acceptance — booting server on port ' + PORT + '…\n');
  await seedTestUsers();
  const child = startServer();

  try {
    if (!(await waitForHealth())) {
      console.error('Server did not come up.\n--- output ---\n' + child.output());
      process.exit(1);
    }

    const tokens = {};
    for (const [role, username] of Object.entries(USERS)) tokens[role] = await loginToken(username);

    // Which seeded role may submit each form (first match wins)
    const roleFor = {};
    for (const form of ALL_FORMS) {
      roleFor[form] = Object.keys(USERS).find(r => (ROLE_FORM_ACCESS[r] || []).includes(form));
    }
    check('every form type has a submitting role in config', ALL_FORMS.every(f => roleFor[f]),
      ALL_FORMS.filter(f => !roleFor[f]).join(', '));

    // ── Part A: all 11 forms round-trip; second session reads identically ──
    console.log('\nPart A — all 11 form types round-trip through Postgres:');
    for (const form of ALL_FORMS) {
      const api  = makeApi(BASE, () => tokens[roleFor[form]]);
      const data = { _accept2: form, _status: 'submitted' };
      let ok = false, why = '';
      try {
        await api.submitForm(form, DATE_A, 'day', data);
        const back = await api.getForm(form, DATE_A, 'day');
        // Read back from a DIFFERENT authenticated session ("second browser")
        const otherRole = roleFor[form] === 'production' ? 'mining' : 'production';
        const back2 = await makeApi(BASE, () => tokens[otherRole]).getForm(form, DATE_A, 'day');
        ok = back && back.data._accept2 === form &&
             back2 && JSON.stringify(back2.data) === JSON.stringify(back.data);
        if (!ok) why = 'read-back mismatch';
      } catch (e) { why = e.message; }
      check(`${form} submits + identical from a second session`, ok, why);
    }

    // ── Part B: the real offline queue module ──────────────────────────
    console.log('\nPart B — offline queue (forms/offline-queue.js, the shipped code):');
    const prodToken = () => tokens.production;   // production report — owned by Production

    // B1: server down → stays queued
    {
      const storage = fakeStorage();
      const q = createQueue({ storage, api: () => makeApi(DEAD_BASE, prodToken) });
      q.enqueue('production', '1999-02-12', 'day', { _q: 'b1', _status: 'submitted' });
      await q.flush();
      const c = q.counts();
      check('B1: submission while server is down stays queued', c.pending === 1 && c.conflicts === 0,
        JSON.stringify(c));

      // B2: server comes back → same queue flushes into Postgres
      const q2 = createQueue({ storage, api: () => makeApi(BASE, prodToken) });
      await q2.flush();
      const c2 = q2.counts();
      const rec = await makeApi(BASE, prodToken).getForm('production', '1999-02-12', 'day');
      check('B2: queued entry syncs when server returns', c2.pending === 0 && rec && rec.data._q === 'b1',
        JSON.stringify(c2));
    }

    // B3: server record NEWER than queued item → conflict, server wins
    {
      const storage = fakeStorage();
      const live = makeApi(BASE, prodToken);
      const q = createQueue({ storage, api: () => live, now: () => '1999-02-01T00:00:00.000Z' });
      q.enqueue('production', '1999-02-13', 'day', { _q: 'mine-stale', _status: 'submitted' });
      await live.submitForm('production', '1999-02-13', 'day', { _q: 'server-newer', _status: 'submitted' });
      await q.flush();
      const c = q.counts();
      const rec = await live.getForm('production', '1999-02-13', 'day');
      check('B3: newer server record is NOT overwritten; item flagged for review',
        c.pending === 0 && c.conflicts === 1 && rec.data._q === 'server-newer', JSON.stringify(c));

      /* B4: "use mine" against an APPROVED server record is now REFUSED.
         This assertion was inverted on 2026-09-24 and the change is the
         point, not an accommodation. prodToken is a production HOD, so its
         submit self-certifies straight to 'approved' — which means the old
         B4 was asserting that an offline queue item could silently overwrite
         an approved report and clear its approver. That is precisely the
         hole WS-A1 closed (REPORT_LOCKED, routes/reports.js).

         The work is not lost: resolveConflict() returns before its splice,
         so the item stays in the conflict list awaiting a correction. */
      const r = await q.resolveConflict(0, 'mine');
      const rec2 = await live.getForm('production', '1999-02-13', 'day');
      check('B4: "use mine" cannot overwrite an APPROVED report; item stays flagged',
        r.ok === false && r.code === 'REPORT_LOCKED' &&
        q.counts().conflicts === 1 && rec2.data._q === 'server-newer',
        JSON.stringify({ ok: r.ok, code: r.code, conflicts: q.counts().conflicts, stored: rec2.data._q }));

      // B4b: the queue tells the author WHY, not "server unreachable"
      check('B4b: the refusal names the real reason, not a network error',
        /approved/i.test(r.error || '') && !/unreachable/i.test(r.error || ''),
        r.error);
    }

    // B5: resolve "keep server" → discard mine, server intact
    {
      const storage = fakeStorage();
      const live = makeApi(BASE, prodToken);
      const q = createQueue({ storage, api: () => live, now: () => '1999-02-01T00:00:00.000Z' });
      q.enqueue('production', '1999-02-14', 'day', { _q: 'mine-discard', _status: 'submitted' });
      await live.submitForm('production', '1999-02-14', 'day', { _q: 'server-keeps', _status: 'submitted' });
      await q.flush();
      const r = await q.resolveConflict(0, 'server');
      const rec = await live.getForm('production', '1999-02-14', 'day');
      check('B5: resolving "keep server" discards queued data, server intact',
        r.ok && q.counts().conflicts === 0 && rec.data._q === 'server-keeps');
    }

    // B6: permanent rejection (role may not submit) → review, not retry-forever
    {
      const storage = fakeStorage();
      const q = createQueue({ storage, api: () => makeApi(BASE, () => tokens.mining) });
      q.enqueue('production', '1999-02-15', 'day', { _q: 'b6', _status: 'submitted' }); // mining can't submit production
      await q.flush();
      const c = q.counts();
      const conflict = q.list().conflicts[0];
      check('B6: 403-rejected entry moves to review with the reason',
        c.pending === 0 && c.conflicts === 1 && /403/.test(conflict.reason), JSON.stringify(c));
    }

  } finally {
    child.kill();
    await cleanup();
    await db.end();
  }

  console.log(`\n${failCount === 0 ? '✅' : '❌'} Phase 2 acceptance: ${passCount} passed, ${failCount} failed.`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Acceptance run crashed:', err);
  try { await cleanup(); await db.end(); } catch { /* best effort */ }
  process.exit(1);
});
