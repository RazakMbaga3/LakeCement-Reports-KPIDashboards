/*
  config/complianceAccess.js — who may do what to a compliance obligation.

  Decided 2026-10-12: EACH DEPARTMENT OWNS ITS OWN obligations; there is no
  central compliance role. The app's four access rules apply as everywhere
  else (docs/ACCESS_MODEL.md):
    boundary     a department sees and maintains only its own obligations
                 (owner_role = the user's role). md / management / admin read
                 every department.
    inheritance  hod ⊇ senior ⊇ officer within the department.
    separation   verifying a record is attesting a department's facts, so
                 admin — IT's break-glass account — may fix data but may
                 NOT verify it.
    least priv.  md / management read everything and edit nothing; the MD
                 alone (besides admin) holds the reminder settings and the
                 central Head list, since that list is an escalation chain.

  Levels: the officer (often the person who actually renews the licence —
  the workbook's "Level 1") can record the work: upload the renewed
  certificate, mark a filing done, record a review, flag a renewal in
  progress. Creating, editing and verifying records is senior and above;
  archiving or moving a record to another department is the HOD's call.

  A small local config, like config/itAssetsAccess.js, rather than an entry
  in forms/access-registry.js: the page asks GET /api/compliance/me for its
  capabilities, so there is no browser-side copy to keep in sync.
*/
const { OWNER_ROLES } = require('./complianceDepartments');

const VIEW_ALL_ROLES = ['admin', 'md', 'management'];
const SETTINGS_ROLES = ['admin', 'md'];
const LEVEL_RANK = { officer: 1, senior: 2, hod: 3 };
const rank = u => LEVEL_RANK[u && u.level] || 0;

const canViewAll = u => !!u && VIEW_ALL_ROLES.includes(u.role);
const isOwnerRole = r => OWNER_ROLES.includes(r);
const ownsDept = (u, ownerRole) => !!u && u.role === ownerRole && isOwnerRole(u.role);

/* null = every department; otherwise the one role whose rows the user sees. */
function scopeRole(u) {
  if (canViewAll(u)) return null;
  return u && isOwnerRole(u.role) ? u.role : '__none__';
}

function complianceAccess(u, item) {
  const admin = !!u && u.role === 'admin';
  const own = !!item && ownsDept(u, item.owner_role);
  const read = canViewAll(u) || own;
  return {
    read,
    act:      admin || own,                          // upload, mark done, assess, renewal flag
    edit:     admin || (own && rank(u) >= 2),        // core fields, responsibles
    verify:   own && rank(u) >= 2,                   // never admin (separation of duties)
    archive:  admin || (own && rank(u) >= 3),
    transfer: admin || (own && rank(u) >= 3),
    retractAny: admin || (own && rank(u) >= 2),
  };
}

function capabilities(u) {
  const admin = !!u && u.role === 'admin';
  return {
    ownRole:       u && isOwnerRole(u.role) ? u.role : null,
    level:         (u && u.level) || null,
    canViewAll:    canViewAll(u),
    canCreate:     admin || (!!u && isOwnerRole(u.role) && rank(u) >= 2),
    canImport:     admin,
    canSettings:   !!u && SETTINGS_ROLES.includes(u.role),
    canContacts:   admin || (!!u && isOwnerRole(u.role) && rank(u) >= 2),
    canEditEmails: admin,
    canRunReminders: admin,
  };
}

module.exports = { VIEW_ALL_ROLES, SETTINGS_ROLES, canViewAll, scopeRole, complianceAccess, capabilities };
