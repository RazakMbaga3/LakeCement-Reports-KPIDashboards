/*
  test/report-revisions.test.js — the pure half of the daily-report
  revision log (services/reportRevisions.js), plus one structural check on
  routes/reports.js that no comment could enforce.

  Two things are being protected here.

  WHAT MUST NEVER BE LOST. shouldSnapshot() is the only thing standing
  between "every change to a reported figure keeps its pre-image" and a
  silent overwrite. Its dangerous branch is not the obvious one: it is
  approved -> approved, where the STATUS does not move and it would be
  easy to conclude nothing happened. Something did happen — a signed-off
  report's figures were rewritten — and it is the one case an "only log
  status changes" rule would miss entirely.

  WHAT MUST NEVER BE LOGGED. The forms autosave in the background every few
  seconds. If a revision were written for each of those, the table would be
  mostly noise within a week and nobody would read it. The route prevents
  that structurally — the autosave branch RETURNS before the transaction
  block that records revisions even exists — and the last test here reads
  routes/reports.js as text to assert that ordering still holds. A comment
  saying "don't call this above here" survives exactly until the first
  refactor; a test does not.

  Pure static checks: no server, no Postgres, no browser.
  Usage: node --test test/report-revisions.test.js   (from backend/)
*/
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const { shouldSnapshot, changedFields } = require(path.join('..', 'services', 'reportRevisions'));
const { REPORTED_STATUSES } = require(path.join('..', 'config', 'forms'));

// ── shouldSnapshot: the anti-bloat rule ──────────────────────────────────

test('shouldSnapshot: no prior row -> always snapshot (revision 1 records the birth)', () => {
  assert.equal(shouldSnapshot(null, { status: 'draft' }), true);
  assert.equal(shouldSnapshot(null, { status: 'approved' }), true);
  assert.equal(shouldSnapshot(undefined, { status: 'pending_approval' }), true);
});

test('shouldSnapshot: draft -> draft is the ONLY case that is skipped', () => {
  assert.equal(shouldSnapshot({ status: 'draft' }, { status: 'draft' }), false,
    'pressing Save Draft twenty times must not write twenty revisions');
});

test('shouldSnapshot: any status change is snapshotted', () => {
  assert.equal(shouldSnapshot({ status: 'draft' }, { status: 'pending_approval' }), true);
  assert.equal(shouldSnapshot({ status: 'draft' }, { status: 'approved' }), true);
  assert.equal(shouldSnapshot({ status: 'rejected' }, { status: 'pending_approval' }), true);
  assert.equal(shouldSnapshot({ status: 'rejected' }, { status: 'draft' }), true,
    'a rejected report being reopened is a workflow event, not a quiet draft save');
  assert.equal(shouldSnapshot({ status: 'pending_approval' }, { status: 'approved' }), true);
  assert.equal(shouldSnapshot({ status: 'approved' }, { status: 'rejected' }), true);
});

/* The branch that matters. Status unchanged, so the cheap "log status
   transitions" rule would skip it — but the DATA of a report that has
   already been reported was just rewritten, which is precisely the event
   this whole table exists to capture. */
test('shouldSnapshot: approved -> approved is TRUE (a reported figure was rewritten)', () => {
  assert.equal(shouldSnapshot({ status: 'approved' }, { status: 'approved' }), true);
});

test('shouldSnapshot: pending_approval -> pending_approval is TRUE for the same reason', () => {
  assert.equal(shouldSnapshot({ status: 'pending_approval' }, { status: 'pending_approval' }), true);
});

test('shouldSnapshot: every REPORTED status snapshots even when it does not move', () => {
  for (const s of REPORTED_STATUSES) {
    assert.equal(shouldSnapshot({ status: s }, { status: s }), true,
      `'${s}' counts as reported data (config/forms.js REPORTED_STATUSES) — it must keep a pre-image`);
  }
});

test('shouldSnapshot: accepts a bare status string as `next`, not only a row', () => {
  assert.equal(shouldSnapshot({ status: 'draft' }, 'draft'), false);
  assert.equal(shouldSnapshot({ status: 'draft' }, 'approved'), true);
});

// ── changedFields: what actually moved ───────────────────────────────────

test('changedFields: identical data -> nothing changed', () => {
  assert.deepEqual(changedFields({ a: 1, b: 'x' }, { a: 1, b: 'x' }), []);
});

test("changedFields: '' , null and undefined are the SAME value (an unfilled field)", () => {
  assert.deepEqual(changedFields({ a: '' },        { a: null }),      []);
  assert.deepEqual(changedFields({ a: null },      { a: '' }),        []);
  assert.deepEqual(changedFields({ a: '' },        { a: undefined }), []);
  assert.deepEqual(changedFields({ a: undefined }, { a: '' }),        []);
  assert.deepEqual(changedFields({ a: null },      { a: undefined }), []);
  assert.deepEqual(changedFields({},               { a: '' }),        [],
    'a form posting a blank field it has always had blank is not a change');
});

test('changedFields: a blank becoming a value, and a value being cleared, both count', () => {
  assert.deepEqual(changedFields({ a: '' },   { a: 5 }),  ['a']);
  assert.deepEqual(changedFields({ a: 5 },    { a: '' }), ['a'],
    'clearing a field is an edit — the form posts an emptied input as ""');
  assert.deepEqual(changedFields({ a: null }, { a: 0 }),  ['a'],
    '0 is a real measurement, not a blank');
});

test('changedFields: underscore-prefixed keys are ignored (form bookkeeping, not report content)', () => {
  assert.deepEqual(changedFields({ _savedAt: 1, a: 1 }, { _savedAt: 999, a: 1 }), [],
    'routes/approvals.js hides _-keys from the approver for the same reason');
  assert.deepEqual(changedFields({}, { _draftId: 'abc' }), []);
  assert.deepEqual(changedFields({ _savedAt: 1, a: 1 }, { _savedAt: 999, a: 2 }), ['a'],
    'a real change alongside a _-key must still be reported');
});

test('changedFields: added keys are reported', () => {
  assert.deepEqual(changedFields({ a: 1 }, { a: 1, b: 2 }), ['b']);
  assert.deepEqual(changedFields(null, { a: 1, b: 2 }), ['a', 'b'],
    'a brand-new report: every field is an addition');
  assert.deepEqual(changedFields(undefined, { a: 1 }), ['a']);
});

test('changedFields: removed keys are reported', () => {
  assert.deepEqual(changedFields({ a: 1, b: 2 }, { a: 1 }), ['b']);
  assert.deepEqual(changedFields({ a: 1 }, null), ['a']);
  assert.deepEqual(changedFields({ a: 1 }, {}), ['a']);
});

test('changedFields: altered keys are reported', () => {
  assert.deepEqual(changedFields({ a: 1 }, { a: 2 }), ['a']);
  assert.deepEqual(changedFields({ a: 'x' }, { a: 'y' }), ['a']);
  assert.deepEqual(changedFields({ a: false }, { a: true }), ['a']);
});

test('changedFields: a type change IS a change (1 vs "1")', () => {
  assert.deepEqual(changedFields({ a: 1 }, { a: '1' }), ['a'],
    'the stored JSONB really does differ; for an audit trail a false positive beats a missed edit');
});

test('changedFields: nested objects/arrays compare structurally', () => {
  assert.deepEqual(changedFields({ s: { sup: 'A' } }, { s: { sup: 'A' } }), []);
  assert.deepEqual(changedFields({ s: { sup: 'A' } }, { s: { sup: 'B' } }), ['s']);
  assert.deepEqual(changedFields({ s: [1, 2] }, { s: [1, 2] }), []);
  assert.deepEqual(changedFields({ s: [1, 2] }, { s: [2, 1] }), ['s']);
});

test('changedFields: the result is sorted, added/removed/changed all together', () => {
  const out = changedFields(
    { zeta: 1, mid: 'same', gone: 'bye', alpha: 5 },
    { zeta: 2, mid: 'same',              alpha: 5, beta: 'new' });
  assert.deepEqual(out, ['beta', 'gone', 'zeta'],
    'sorted so the stored TEXT[] is stable and diffable between revisions');
});

test('changedFields: two empty/absent payloads produce an empty array, never null', () => {
  assert.deepEqual(changedFields(null, null), []);
  assert.deepEqual(changedFields({}, {}), []);
});

// ── structural: autosave can never reach the revision log ────────────────

/* This is the machine-checkable version of "background autosaves must not
   bloat report_revisions". The route does not guard against it with an
   `if (autosave)` — it is guaranteed by POSITION: the autosave branch
   returns its response before the transaction block that records revisions
   begins. Position is exactly the kind of invariant a refactor breaks
   silently, so it is asserted on the source text itself. */
test('routes/reports.js: the autosave branch returns BEFORE any recordRevision() call', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports.js'), 'utf8');

  const branchAt = src.indexOf('if (autosave) {');
  assert.notEqual(branchAt, -1,
    'the autosave branch was renamed or removed — re-derive this guard before deleting it.');

  const returnAt = src.indexOf('return res.json(', branchAt);
  assert.notEqual(returnAt, -1,
    'the autosave branch no longer returns a response of its own; revisions may now be reachable from it.');

  const firstRecord = src.indexOf('recordRevision(');
  assert.notEqual(firstRecord, -1,
    'routes/reports.js no longer records revisions at all — the pre-image log has been disconnected.');

  assert.ok(firstRecord > returnAt,
    'A recordRevision() call appears at or before the autosave branch\'s return. '
    + 'Unattended autosaves would then write a revision every few seconds and drown the log. '
    + 'Keep every revision write below that return.');
});

test('routes/reports.js: the autosave branch itself contains no revision write', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports.js'), 'utf8');
  const branchAt = src.indexOf('if (autosave) {');
  const returnAt = src.indexOf('return res.json(', branchAt);
  const branchBody = src.slice(branchAt, returnAt);

  assert.equal(branchBody.includes('recordRevision'), false,
    'the autosave branch must not mention recordRevision at all.');
  assert.equal(branchBody.includes('audit_log'), false,
    'and it must still not write audit_log either — a heartbeat is not a decision.');
});

/* The lock is the other half of WS-A1: a reported row may not be silently
   overwritten. If REPORT_LOCKED ever disappears from the route, a
   re-submit goes back to merging over an approved report and resetting its
   approval, which is the exact defect this work stream closed. */
test('routes/reports.js: the REPORT_LOCKED refusal is still wired up', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports.js'), 'utf8');
  assert.ok(src.includes("code:   'REPORT_LOCKED'") || src.includes("'REPORT_LOCKED'"),
    'the submit path no longer returns REPORT_LOCKED — an approved report can be overwritten again.');
  assert.ok(src.includes('amendReason'),
    'the admin/md break-glass reason is gone; there is now either no way past the lock, or an unaudited one.');
});
