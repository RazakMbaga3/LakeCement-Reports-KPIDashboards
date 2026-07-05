/*
  middleware/formAccess.js — 403s a report submit if this role isn't
  allowed to submit the given :formType. Closes the gap where any
  authenticated user could previously POST any of the 13 form types.
*/
const { ROLE_FORM_ACCESS } = require('../config/formAccess');

function requireFormAccess(req, res, next) {
  const { formType } = req.params;
  const allowed = ROLE_FORM_ACCESS[req.user.role] || [];
  if (!allowed.includes(formType)) {
    return res.status(403).json({ error: `Role '${req.user.role}' may not submit '${formType}' reports.` });
  }
  next();
}

module.exports = { requireFormAccess };
