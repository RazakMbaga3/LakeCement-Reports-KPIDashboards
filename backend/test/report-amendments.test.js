/*
  Correction requests — the rules that need no database, and the invariants
  that must never be quietly broken.

  What is here, and why each is a test rather than a comment:

    - the SEPARATION-OF-DUTIES rule (mayDecide). The lock is advisory if the
      person who asked for a correction can also grant it.
    - the window arithmetic (windowIsOpen, clampHours), including the boundary.
    - DESIGN INVARIANT: a correction never adds a report STATUS. The whole
      feature rests on a grant leaving daily_reports.status alone, so that
      REPORTED_STATUSES is untouched and the day keeps counting in every KPI.
      An 'amending' status "just for this" is the obvious wrong turn, and it
      would blank the day from fifteen call sites.
    - DESIGN INVARIANT: every foreign key from the new tables to users is
      ON DELETE SET NULL. Migration 024 shipped without that and blocked
      deleting any user who had ever touched a report (fixed in 025); an audit
      trail has to outlive the people in it.
    - the write gates in routes/reports.js still contain the pieces that
      honour a window: an autosave EXISTS clause, and a lock check that
      consults the window BEFORE it refuses.

  The end-to-end behaviour — a real server, real rows — is scripts/
  accept-amendments.js and e2e/tests/report-amendment.spec.js.
*/
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const A = require('../services/reportAmendments');
const { REPORTED_STATUSES } = require('../config/forms');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const officer = { id: 7, role: 'production', level: 'officer' };
const hod     = { id: 9, role: 'production', level: 'hod' };
const admin   = { id: 1, role: 'admin',      level: 'hod' };
const md      = { id: 2, role: 'md',         level: 'hod' };

/* ── separation of duties ─────────────────────────────────────────────── */

test('mayDecide: the person who asked can never decide their own request', () => {
  const r = A.mayDecide({ requested_by: 7 }, officer);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SEPARATION_OF_DUTIES');
  assert.match(r.error, /another approver/);
});

test('mayDecide: an HOD who is the requester is blocked too — level does not exempt', () => {
  const r = A.mayDecide({ requested_by: 9 }, hod);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SEPARATION_OF_DUTIES');
});

test('mayDecide: a different approver may decide', () => {
  assert.deepEqual(A.mayDecide({ requested_by: 7 }, hod), { ok: true });
});

test('mayDecide: admin and md are the escalation, even for their own request', () => {
  // The case this exists for: an HOD asks for a correction to their own
  // report and has nobody else at their level. They ask an admin or the MD.
  assert.deepEqual(A.mayDecide({ requested_by: 1 }, admin), { ok: true });
  assert.deepEqual(A.mayDecide({ requested_by: 2 }, md), { ok: true });
  assert.deepEqual(A.mayDecide({ requested_by: 9 }, admin), { ok: true });
});

test('mayDecide: a request whose requester was deleted (null) blocks nobody', () => {
  // requested_by is ON DELETE SET NULL; null must not equal any user id.
  assert.deepEqual(A.mayDecide({ requested_by: null }, hod), { ok: true });
});

test('mayDecide: a missing request or user is refused, not thrown on', () => {
  assert.equal(A.mayDecide(null, hod).ok, false);
  assert.equal(A.mayDecide({ requested_by: 7 }, null).ok, false);
});

test('mayWithdraw: the requester or admin/md only', () => {
  assert.equal(A.mayWithdraw({ requested_by: 7 }, officer), true);
  assert.equal(A.mayWithdraw({ requested_by: 7 }, hod), false);
  assert.equal(A.mayWithdraw({ requested_by: 7 }, admin), true);
  assert.equal(A.mayWithdraw({ requested_by: 7 }, md), true);
  assert.equal(A.mayWithdraw({ requested_by: null }, officer), false);
  assert.equal(A.mayWithdraw(null, officer), false);
});

/* ── the window ───────────────────────────────────────────────────────── */

test('windowIsOpen: only a granted, unexpired amendment is a window', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  const future = '2026-09-24T12:00:01Z';
  const past   = '2026-09-24T11:59:59Z';
  assert.equal(A.windowIsOpen({ status: 'granted', expires_at: future }, now), true);
  assert.equal(A.windowIsOpen({ status: 'granted', expires_at: past }, now), false);
  for (const status of ['requested', 'applied', 'declined', 'withdrawn', 'expired']) {
    assert.equal(A.windowIsOpen({ status, expires_at: future }, now), false, `${status} is not a window`);
  }
});

test('windowIsOpen: the boundary instant is closed, and bad input is closed', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  assert.equal(A.windowIsOpen({ status: 'granted', expires_at: '2026-09-24T12:00:00Z' }, now), false,
    'expires_at == now is expired — the database uses expires_at > NOW()');
  assert.equal(A.windowIsOpen({ status: 'granted', expires_at: null }, now), false);
  assert.equal(A.windowIsOpen(null, now), false);
  assert.equal(A.windowIsOpen(undefined, now), false);
});

test('clampHours: whole hours 1..72, default 24, everything else refused', () => {
  assert.equal(A.clampHours(undefined), 24);
  assert.equal(A.clampHours(null), 24);
  assert.equal(A.clampHours(''), 24);
  assert.equal(A.clampHours(1), 1);
  assert.equal(A.clampHours(72), 72);
  assert.equal(A.clampHours('48'), 48);
  for (const bad of [0, -1, 73, 1.5, 'abc', NaN]) {
    assert.equal(A.clampHours(bad), null, `${String(bad)} must be refused`);
  }
});

test('the vocabulary is what the schema and the routes agree on', () => {
  assert.deepEqual(A.OPEN_STATUSES, ['requested', 'granted']);
  assert.deepEqual(A.LOCKED_STATUSES, ['approved', 'pending_approval']);
  assert.equal(A.DEFAULT_WINDOW_HOURS, 24);
  assert.equal(A.MAX_WINDOW_HOURS, 72);
});

/* ── design invariant: a correction never adds a report status ────────── */

test('INVARIANT: REPORTED_STATUSES is untouched — a window is not a status', () => {
  assert.deepEqual([...REPORTED_STATUSES].sort(), ['approved', 'pending_approval']);
});

test('INVARIANT: daily_reports.status still has exactly the four original values', () => {
  const schema = read('db/schema.sql');
  const m = schema.match(/status\s+VARCHAR\(20\)\s+NOT NULL\s+DEFAULT\s+'draft'\s+CHECK\s*\(status IN \(([^)]*)\)\)/);
  assert.ok(m, 'could not find the daily_reports status CHECK in schema.sql');
  const values = m[1].split(',').map(v => v.trim().replace(/'/g, '')).sort();
  assert.deepEqual(values, ['approved', 'draft', 'pending_approval', 'rejected'],
    "an 'amending' (or similar) status would either lie about 'approved' or blank the day from every KPI, the MIS pack, completeness and the watchdog — a correction is a window in report_amendments, not a status");
});

test('INVARIANT: no migration after 010 widens the daily_reports status CHECK', () => {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql'))) {
    if (Number(f.slice(0, 3)) <= 10) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(sql, /ALTER TABLE daily_reports[^;]*status[^;]*CHECK/is,
      `${f} alters the daily_reports status CHECK`);
  }
});

/* ── design invariant: the audit trail outlives the people in it ──────── */

function tableBlock(sql, name) {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${name}`);
  assert.ok(start >= 0, `${name} not found`);
  return sql.slice(start, sql.indexOf(');', start));
}

test('INVARIANT: every user foreign key on report_revisions / report_amendments is ON DELETE SET NULL', () => {
  const schema = read('db/schema.sql');
  for (const table of ['report_revisions', 'report_amendments']) {
    const block = tableBlock(schema, table);
    const refs = block.match(/REFERENCES users\(id\)[^,\n]*/g) || [];
    assert.ok(refs.length > 0, `${table} should reference users`);
    for (const ref of refs) {
      assert.match(ref, /ON DELETE SET NULL/,
        `${table}: "${ref.trim()}" blocks deleting any user who ever touched a report. `
        + 'An audit trail has to outlive the people in it (migration 025 fixed exactly this on report_revisions).');
    }
  }
});

test('INVARIANT: the migration itself carries the same rule', () => {
  // DDL only: the migration's own header prose mentions "REFERENCES users(id)"
  // when explaining the mistake, and that is not a foreign key.
  const sql = read('db/migrations/027_report_amendments.sql')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  const refs = sql.match(/REFERENCES users\(id\)[^,\n]*/g) || [];
  assert.equal(refs.length, 2, 'requested_by and decided_by — a new user FK must be added to this test on purpose');
  refs.forEach(r => assert.match(r, /ON DELETE SET NULL/));
});

test('schema: at most ONE open amendment per report-day-shift, and a reason is mandatory', () => {
  const sql = read('db/migrations/027_report_amendments.sql');
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_report_amendments_open[\s\S]*?\(form_type, record_date, shift\)[\s\S]*?WHERE status IN \('requested','granted'\)/);
  assert.match(sql, /reason\s+TEXT\s+NOT NULL/);
  assert.match(sql, /CHECK \(status IN \('requested','granted','applied','declined','withdrawn','expired'\)\)/);
});

test('schema.sql carries the same table as the migration (the runner\'s convention)', () => {
  const schema = read('db/schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS report_amendments/);
  assert.match(schema, /uq_report_amendments_open/);
  assert.match(schema, /report_revisions_amendment_fk/);
});

/* ── the write gates still honour a window ────────────────────────────── */

test('reports.js: a background autosave is let through by a granted window, in the SAME statement', () => {
  const src = read('routes/reports.js');
  const autosave = src.slice(src.indexOf('if (autosave) {'), src.indexOf('const isDraft = intent'));
  assert.match(autosave, /WHERE daily_reports\.status NOT IN \('pending_approval', 'approved'\)\s+OR EXISTS \(SELECT 1 FROM report_amendments/,
    'the window check must be part of the atomic upsert, not a separate read before it');
  assert.match(autosave, /a\.status\s*=\s*'granted'\s+AND a\.expires_at\s*>\s*NOW\(\)/);
});

test('reports.js: the lock consults the window BEFORE it refuses, and a window wins over break-glass', () => {
  const src = read('routes/reports.js');
  const find = src.indexOf('amendments.findActiveWindow(');
  const refuse = src.indexOf('lockedStatus && !viaWindow && !breakGlass');
  assert.ok(find > 0 && refuse > 0, 'the window lookup and the refusal must both be present');
  assert.ok(find < refuse, 'the window must be read before the lock decides');
});

test('reports.js: a Save Draft inside a window keeps the status — it must not un-approve the day', () => {
  const src = read('routes/reports.js');
  assert.match(src, /const keepStatus = viaWindow && isDraft;/);
  // and the keep-status branch must not write status / approval columns
  const keep = src.slice(src.indexOf('const result = keepStatus'), src.indexOf(': await client.query(`\n              INSERT INTO daily_reports'));
  assert.doesNotMatch(keep, /status\s*=/, 'the in-window draft UPDATE must not touch status');
  assert.doesNotMatch(keep, /approved_by/);
});

test('reports.js: a submission inside a window closes it in the same transaction', () => {
  const src = read('routes/reports.js');
  assert.match(src, /viaWindow && !isDraft[\s\S]*?UPDATE report_amendments SET status = 'applied'/);
});
