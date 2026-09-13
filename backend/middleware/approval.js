/*
  middleware/approval.js — 403s an approve/reject action unless the caller
  is the HOD (level='hod') of the department that owns the given :formType,
  or an admin/md override.

  "Owns" is derived from ROLE_FORM_ACCESS (config/formAccess.js — the same
  FORM_ACCESS map requireFormAccess already uses to gate submission).
  Submitting and approving are different questions: most form types have
  exactly one submitting role, so the reverse lookup answers both at once.
  Where two roles submit the same form type, FORM_APPROVAL_OWNER must name
  which one's HOD approves — and if it doesn't, the build step below still
  throws at startup rather than silently picking one. An overlap has to be
  declared deliberately; it can never happen by accident.
*/
const { ROLE_FORM_ACCESS, FORM_APPROVAL_OWNER } = require('../config/formAccess');

const SUBMITTING_ROLES_BY_FORM_TYPE = {};
Object.entries(ROLE_FORM_ACCESS).forEach(([role, formTypes]) => {
  formTypes.forEach(formType => {
    (SUBMITTING_ROLES_BY_FORM_TYPE[formType] ||= []).push(role);
  });
});

const OWNING_ROLE_BY_FORM_TYPE = {};
Object.entries(SUBMITTING_ROLES_BY_FORM_TYPE).forEach(([formType, roles]) => {
  if (roles.length === 1) {
    OWNING_ROLE_BY_FORM_TYPE[formType] = roles[0];
    return;
  }
  const declared = FORM_APPROVAL_OWNER[formType];
  if (!declared) {
    throw new Error(`approval.js: form type '${formType}' is claimed by ${roles.map(r => `'${r}'`).join(' and ')} in FORM_ACCESS — add it to FORM_APPROVAL_OWNER in forms/access-registry.js naming which role's HOD approves it.`);
  }
  if (!roles.includes(declared)) {
    throw new Error(`approval.js: FORM_APPROVAL_OWNER names '${declared}' as approver for '${formType}', but that role cannot submit it (submitters: ${roles.join(', ')}).`);
  }
  OWNING_ROLE_BY_FORM_TYPE[formType] = declared;
});

function requireApprover(req, res, next) {
  if (req.user.role === 'admin' || req.user.role === 'md') return next();

  const { formType } = req.params;
  const owningRole = OWNING_ROLE_BY_FORM_TYPE[formType];
  if (req.user.level !== 'hod' || req.user.role !== owningRole) {
    return res.status(403).json({
      error: `Only the ${owningRole || 'owning department'}'s HOD (or admin/md) may approve or reject '${formType}' reports.`,
    });
  }
  next();
}

module.exports = { requireApprover, OWNING_ROLE_BY_FORM_TYPE, SUBMITTING_ROLES_BY_FORM_TYPE };
