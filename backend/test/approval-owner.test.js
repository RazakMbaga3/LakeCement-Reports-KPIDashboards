/*
  test/approval-owner.test.js — guards the invariant that middleware/
  approval.js enforces at module load.

  On 2026-09-11 a one-line access change gave 'ei' submit rights on
  'power-cons' while 'pm' still held them. approval.js throws at require()
  when a form type has two submitters and no declared approver, so the
  whole server stopped booting — and every one of the ten unit suites still
  passed green, because nothing here ever required approval.js. That is the
  gap this file closes: an approval-ownership mistake now fails as a test,
  not as an outage.

  Pure static check: no server, no Postgres, no browser.
  Usage: node --test test/approval-owner.test.js   (from backend/)
*/
const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');

const { FORM_APPROVAL_OWNER } = require(path.join('..', 'config', 'formAccess'));

test('middleware/approval.js loads without throwing (the server can boot)', () => {
  assert.doesNotThrow(() => require(path.join('..', 'middleware', 'approval.js')));
});

test('every form type with more than one submitting role declares its approver', () => {
  const { SUBMITTING_ROLES_BY_FORM_TYPE } = require(path.join('..', 'middleware', 'approval.js'));
  const undeclared = Object.entries(SUBMITTING_ROLES_BY_FORM_TYPE)
    .filter(([formType, roles]) => roles.length > 1 && !FORM_APPROVAL_OWNER[formType])
    .map(([formType, roles]) => `${formType} (submitted by ${roles.join(', ')})`);

  assert.deepEqual(undeclared, [],
    'Shared form types with no approver named in FORM_APPROVAL_OWNER — ' +
    'add them to forms/access-registry.js, or the server will refuse to boot.');
});

test('every declared approver is a role that can actually submit that form type', () => {
  const { SUBMITTING_ROLES_BY_FORM_TYPE } = require(path.join('..', 'middleware', 'approval.js'));
  for (const [formType, approver] of Object.entries(FORM_APPROVAL_OWNER)) {
    const submitters = SUBMITTING_ROLES_BY_FORM_TYPE[formType] || [];
    assert.ok(submitters.includes(approver),
      `FORM_APPROVAL_OWNER names '${approver}' for '${formType}', but only ${submitters.join(', ') || 'no role'} may submit it.`);
  }
});

test('an undeclared overlap still throws — the guard was not just removed', () => {
  const cfg = require(path.join('..', 'config', 'formAccess'));
  const approvalPath = require.resolve(path.join('..', 'middleware', 'approval.js'));
  const declared = cfg.FORM_APPROVAL_OWNER;

  cfg.FORM_APPROVAL_OWNER = {};
  delete require.cache[approvalPath];
  try {
    assert.throws(() => require(approvalPath), /power-cons/,
      'approval.js must still refuse to load when a shared form type has no declared approver.');
  } finally {
    cfg.FORM_APPROVAL_OWNER = declared;
    delete require.cache[approvalPath];
  }
});

test("power-cons is approved by E&I's HOD, and P&M keeps submit rights", () => {
  const { OWNING_ROLE_BY_FORM_TYPE, SUBMITTING_ROLES_BY_FORM_TYPE } =
    require(path.join('..', 'middleware', 'approval.js'));

  assert.equal(OWNING_ROLE_BY_FORM_TYPE['power-cons'], 'ei');
  assert.deepEqual(SUBMITTING_ROLES_BY_FORM_TYPE['power-cons'].sort(), ['ei', 'pm']);
});
