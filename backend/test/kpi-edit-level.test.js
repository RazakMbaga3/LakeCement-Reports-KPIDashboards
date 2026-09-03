/*
  test/kpi-edit-level.test.js — proves the L1/L2/L3 split on monthly KPI
  writes, as confirmed by the Plant Head 2026-08-28:

    L1 (hod)     — edits monthly KPIs for the departments its role owns,
                   and approves that department's daily reports.
    L2 (senior)  — fills and submits DAILY reports for approval.
                   No monthly KPI editing.
    L3 (officer) — same as L2.

  requireKpiDeptAccess enforces two independent things, and this test keeps
  them from collapsing into one: WHICH departments a role may write
  (ROLE_KPI_EDIT_DEPTS) and WHO within that department may write them
  (level). Before 2026-08-28 only the first existed, so production_senior
  could overwrite Production's monthly targets.

  Pure unit test — no server, no Postgres, no browser.
  Usage: node --test test/kpi-edit-level.test.js   (from backend/)
*/
const test   = require('node:test');
const assert = require('node:assert/strict');

const { requireKpiDeptAccess } = require('../middleware/kpiAccess');

/* Minimal express req/res doubles. `result` ends up as either
   { next: true } or { status, body } so each case reads as one assertion. */
function run(user, dept) {
  const result = {};
  const req = { params: { dept }, user };
  const res = {
    status(code) { result.status = code; return this; },
    json(body)   { result.body = body;  return this; },
  };
  requireKpiDeptAccess(req, res, () => { result.next = true; });
  return result;
}

const allowed = (user, dept) => run(user, dept).next === true;
const denial  = (user, dept) => run(user, dept).body?.error || '';

test('L1 HOD may edit its own department KPIs', () => {
  assert.ok(allowed({ role: 'production', level: 'hod' }, 'production'));
  assert.ok(allowed({ role: 'cpp',        level: 'hod' }, 'powerplant'));
  assert.ok(allowed({ role: 'pm',         level: 'hod' }, 'mechanical'));
  assert.ok(allowed({ role: 'mining',     level: 'hod' }, 'mines'));
  assert.ok(allowed({ role: 'stores',     level: 'hod' }, 'stores'));
  assert.ok(allowed({ role: 'ei',         level: 'hod' }, 'ei'));
  assert.ok(allowed({ role: 'packing',    level: 'hod' }, 'packing'));
});

test('L2 senior may NOT edit KPIs, even for its own department', () => {
  for (const [role, dept] of [
    ['production', 'production'], ['cpp', 'powerplant'], ['pm', 'mechanical'],
    ['mining', 'mines'], ['stores', 'stores'], ['ei', 'ei'], ['packing', 'packing'],
  ]) {
    const r = run({ role, level: 'senior' }, dept);
    assert.equal(r.next, undefined, `${role}/senior should be blocked on ${dept}`);
    assert.equal(r.status, 403);
    assert.match(r.body.error, /HOD \(L1\)/);
  }
});

test('L3 officer may NOT edit KPIs, even for its own department', () => {
  const r = run({ role: 'production', level: 'officer' }, 'production');
  assert.equal(r.next, undefined);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /HOD \(L1\)/);
});

test('the department gate still fires before the level gate', () => {
  // An HOD of the wrong department is refused on department grounds, and the
  // message must say so — not blame their level, which is fine.
  const r = run({ role: 'cpp', level: 'hod' }, 'production');
  assert.equal(r.status, 403);
  assert.match(r.body.error, /may not edit KPIs for department/);
});

test('a non-editing role is refused whatever its level', () => {
  for (const level of ['hod', 'senior', 'officer']) {
    assert.equal(run({ role: 'hr',      level }, 'production').status, 403);
    assert.equal(run({ role: 'finance', level }, 'stores').status,     403);
    assert.equal(run({ role: 'md',      level }, 'production').status, 403);
  }
});

test('admin is the break-glass exemption, at any level', () => {
  assert.ok(allowed({ role: 'admin', level: 'hod' },     'production'));
  assert.ok(allowed({ role: 'admin', level: 'officer' }, 'production'));
});

/* Separation of Duties, confirmed by the Plant Head 2026-09-03: management
   reads every department and writes none. `management` held editDepts:'all'
   until then, so a CFO or GM could overwrite any HOD's submitted figures —
   which is precisely the accountability the approval chain exists to
   create. Whoever reports a number is not whoever reviews it. */
test('management may NOT edit any department KPIs, at any level', () => {
  for (const dept of ['mines', 'production', 'powerplant', 'stores', 'ei', 'packing', 'mechanical']) {
    for (const level of ['hod', 'senior', 'officer']) {
      const r = run({ role: 'management', level }, dept);
      assert.equal(r.next, undefined, `management/${level} must not edit ${dept}`);
      assert.equal(r.status, 403);
      assert.match(r.body.error, /may not edit KPIs for department/);
    }
  }
});

test('a missing level is treated as not-L1, not as a bypass', () => {
  const r = run({ role: 'production' }, 'production');   // no `level` at all
  assert.equal(r.next, undefined);
  assert.equal(r.status, 403);
  assert.match(denial({ role: 'production' }, 'production'), /unknown/);
});
