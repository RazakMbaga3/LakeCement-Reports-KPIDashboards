/*
  middleware/approval.js — 403s an approve/reject action unless the caller
  is the HOD (level='hod') of the department that owns the given :formType,
  or an admin/md override.

  "Owns" is derived from ROLE_FORM_ACCESS (config/formAccess.js — the same
  FORM_ACCESS map requireFormAccess already uses to gate submission):
  today exactly one role owns each form type, so a reverse lookup built
  once at module load is enough. If a form type is ever shared by two
  roles, this map's build step below will throw at startup rather than
  silently picking one — surfacing the ambiguity instead of masking it.
*/
const { ROLE_FORM_ACCESS } = require('../config/formAccess');

const OWNING_ROLE_BY_FORM_TYPE = {};
Object.entries(ROLE_FORM_ACCESS).forEach(([role, formTypes]) => {
  formTypes.forEach(formType => {
    if (OWNING_ROLE_BY_FORM_TYPE[formType]) {
      throw new Error(`approval.js: form type '${formType}' is claimed by both '${OWNING_ROLE_BY_FORM_TYPE[formType]}' and '${role}' in FORM_ACCESS — requireApprover needs a single owning role per form type.`);
    }
    OWNING_ROLE_BY_FORM_TYPE[formType] = role;
  });
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

module.exports = { requireApprover, OWNING_ROLE_BY_FORM_TYPE };
