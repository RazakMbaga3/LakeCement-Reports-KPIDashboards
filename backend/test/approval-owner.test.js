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
    /* Matched on the guard's own instruction, not on a form-type name.
       The message names whichever shared type the iteration reaches
       first, which is an artefact of key order in FORM_ACCESS: it was
       'power-cons' until the QC Manager role made 'quality' shared too
       (2026-09-22), and would move again the next time a form type is
       shared. What this test is actually about is that the guard still
       fires and still tells the reader what to do about it. */
    assert.throws(() => require(approvalPath), /add it to FORM_APPROVAL_OWNER/,
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

/* 2026-09-14: Packing Plant gained submit rights on the Dispatch & SO
   report — it's the report they actually fill. Logistics keeps both submit
   and sign-off: the ask was to let Packing fill it, not to move approval,
   and author-in-one-department / approver-in-another is the Separation-of-
   Duties rule the access model already states. */
test("dispatch is approved by Logistics' HOD, and Packing may submit it", () => {
  const { OWNING_ROLE_BY_FORM_TYPE, SUBMITTING_ROLES_BY_FORM_TYPE } =
    require(path.join('..', 'middleware', 'approval.js'));

  assert.equal(OWNING_ROLE_BY_FORM_TYPE['dispatch'], 'logistics');
  assert.deepEqual(SUBMITTING_ROLES_BY_FORM_TYPE['dispatch'].sort(), ['logistics', 'packing']);
});

/* 2026-09-22: the QC Manager role gained submit rights on the three lab
   reports — Quality/Lab, Limestone % and Pile Quality — which the lab
   measures and which only Production could file until now. Production
   keeps submit AND sign-off on all three, the same shape as the Packing /
   dispatch grant above: nobody loses a right they had, and author and
   approver stay in different departments. */
test("the three lab reports are approved by Production's HOD, and QC may submit them", () => {
  const { OWNING_ROLE_BY_FORM_TYPE, SUBMITTING_ROLES_BY_FORM_TYPE } =
    require(path.join('..', 'middleware', 'approval.js'));

  for (const formType of ['quality', 'limestone', 'pile-quality']) {
    assert.equal(OWNING_ROLE_BY_FORM_TYPE[formType], 'production',
      `${formType} must still be signed off by Production's HOD`);
    assert.deepEqual(SUBMITTING_ROLES_BY_FORM_TYPE[formType].sort(), ['production', 'quality'],
      `${formType} must be submittable by both Production and QC`);
  }
});
