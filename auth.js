/* ═══════════════════════════════════════════════════════════════════════
   Lake Cement Ltd — MIS Authentication & Role-Based Access Control
   auth.js  |  v1.0  |  2026-06-03
   -----------------------------------------------------------------------
   Provides: login, logout, session management, permission matrix,
             permission helpers, user-header rendering, page enforcement.
═══════════════════════════════════════════════════════════════════════ */
'use strict';

const _SESSION_KEY = 'lcl_mis_session';
const _TOKEN_KEY   = 'lcl_mis_token';

/* API base — the one line to change when deploying off localhost.
   Production (any host that isn't localhost) uses a relative '/api' path,
   since Nginx reverse-proxies /api/* to the backend on the same origin
   (see deploy/nginx.digitalocean.conf) — works for an IP, a domain, or a
   domain change later with zero code changes. Local dev talks to the
   backend directly since there's no Nginx in front of it. */
const _API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://localhost:5000/api'
  : '/api';

/* Roles: md | admin | management | hr | finance | stores | cpp |
          pm | it | logistics | mining | production
   User accounts now live server-side (backend/db/seed.js) with bcrypt-hashed
   passwords — the old plaintext MIS_USERS array has been removed. */

/* ══════════════════════════════════════════════════════════════════════
   PERMISSION MATRIX
   mis_tabs  : MIS tabs this role can see ('audit' = admin/md only)
   Tab keys  : null = hidden entirely | 'view' = read-only | 'edit' = full
               'own' = restricted to own dept rows (read+edit)
   kpi.depts     : 'all' OR array of nav-btn data-dept values — VIEW scope
   kpi.editDepts : 'all' OR array of data-dept values this role may actually
                   submit/edit via "Fill Monthly Data" — must be a subset of
                   kpi.depts. Depts in kpi.depts but not kpi.editDepts are
                   view-only for this role.
   kpi.daily : can submit daily reports
══════════════════════════════════════════════════════════════════════ */
const PERMISSIONS = {

  md: {
    mis_tabs: ['hr','assets','compliance','store','audit'],
    hr:         { strength:'edit', roster:'view',  contractors:'view', csr:'view' },
    assets:     { it:'view',       vehicles:'view', spares:'view',      capex:'edit', land:'edit' },
    compliance: { certs:'view',    mlpl:'view',     legal:'view',       insurance:'view' },
    store:      { rawmat:'view',   spares:'view',   amc:'view' },
    kpi:        { depts:'all', editDepts:[], daily:false },
    commercial: { sales:'view', purchase:'view' },
    canViewAudit:  true,
    canManageUsers:false,
    canManageITAssets:false,
    canExport:     true,
  },

  admin: {
    mis_tabs: ['hr','assets','compliance','store','audit'],
    hr:         { strength:'view', roster:'view',  contractors:'view', csr:'view' },
    assets:     { it:'edit',       vehicles:'view', spares:'view',      capex:'view', land:'view' },
    compliance: { certs:'view',    mlpl:'view',     legal:'view',       insurance:'view' },
    store:      { rawmat:'view',   spares:'view',   amc:'view' },
    kpi:        { depts:'all', editDepts:'all', daily:false },
    commercial: { sales:'view', purchase:'view' },   /* Added 2026-10-16 at Razak's request — see COMMERCIAL_VIEW_ROLES/PURCHASE_VIEW_ROLES in forms/access-registry.js */
    canViewAudit:  true,
    canManageUsers:true,
    canManageITAssets:true,
    canExport:     true,
  },

  management: {
    mis_tabs: ['hr','assets','compliance','store'],
    hr:         { strength:'view', roster:'view',  contractors:'view', csr:'view' },
    assets:     { it:'view',       vehicles:'view', spares:'view',      capex:'view', land:'view' },
    compliance: { certs:'view',    mlpl:'view',     legal:'view',       insurance:'view' },
    store:      { rawmat:'view',   spares:'view',   amc:'view' },
    kpi:        { depts:'all', editDepts:[], daily:false },
    commercial: { sales:'view', purchase:'view' },
    canViewAudit:  false,
    canManageUsers:false,
    canManageITAssets:false,
    canExport:     true,
  },

  hr: {
    mis_tabs: [],
    hr:         { strength:'edit', roster:'edit',  contractors:'edit', csr:'edit' },
    assets:     null,
    compliance: { certs:'edit',    mlpl:null,       legal:'edit',       insurance:'edit' },
    store:      null,
    kpi:        { depts:['summary'], editDepts:[], daily:true },
    commercial: { sales:null, purchase:null },
    canViewAudit:  false,
    canManageUsers:false,
    canManageITAssets:false,
    canExport:     true,
  },

  finance: {
    mis_tabs: [],
    hr:         { strength:'view', roster:'view',  contractors:'view', csr:'view' },
    assets:     { it:'view',       vehicles:'view', spares:'view',      capex:'edit', land:'view' },
    compliance: { certs:'view',    mlpl:'view',     legal:'view',       insurance:'edit' },
    store:      { rawmat:'view',   spares:'view',   amc:'view' },
    kpi:        { depts:'all', editDepts:[], daily:false },
    commercial: { sales:null, purchase:null },
    canViewAudit:  false,
    canManageUsers:false,
    canManageITAssets:false,
    canExport:     true,
  },

  stores: {
    mis_tabs: [],
    hr:         null,
    assets:     null,
    compliance: null,
    store:      { rawmat:'edit',   spares:'edit',   amc:'edit' },
    kpi:        { depts:['summary','stores'], editDepts:['stores'], daily:true },
    commercial: { sales:null, purchase:'view' },   /* Stores receives against Purchase's POs — see PURCHASE_VIEW_ROLES in forms/access-registry.js */
    canViewAudit:  false,
    canManageUsers:false,
    canManageITAssets:false,
    canExport:     true,
  },

  cpp: {
    mis_tabs: [],
    hr:         null,
    assets:     { it:'own',        vehicles:'own',  spares:'own',       capex:'own',  land:null },
    compliance: { certs:'own',     mlpl:null,        legal:null,         insurance:'own' },
    store:      { rawmat:null,     spares:'own',    amc:'own' },
    kpi:        { depts:['summary','powerplant'], editDepts:['powerplant'], daily:true },
    commercial: { sales:null, purchase:null },
    canViewAudit:  false,
    canManageUsers:false,
    canManageITAssets:false,
    canExport:     false,
  },

  pm: {
    mis_tabs: [],
    hr:         null,
    assets:     { it:'own',        vehicles:'own',  spares:'own',       capex:'own',  land:null },
    compliance: { certs:'own',     mlpl:null,        legal:null,         insurance:'own' },
    store:      { rawmat:null,     spares:'own',    amc:'own' },
    kpi:        { depts:['summary','ei','mechanical'], editDepts:['mechanical'], daily:true },
    commercial: { sales:null, purchase:null },
    canViewAudit:  false,
    canManageUsers:false,
    canManageITAssets:false,
    canExport:     false,
  },

  it: {
    mis_tabs: [],
    hr:         null,
    assets:     { it:'edit',       vehicles:null,   spares:null,        capex:'own',  land:null },
    compliance: null,
    store:      null,
    kpi:        { depts:['summary'], editDepts:[], daily:false },
    commercial: { sales:null, purchase:null },
    canViewAudit:  true,
    canManageUsers:false,
    canManageITAssets:true,
    canExport:     false,
  },

  logistics: {
    mis_tabs: [],
    hr:         null,
    assets:     { it:'own',        vehicles:'edit', spares:null,        capex:null,   land:null },
    compliance: { certs:'own',     mlpl:null,        legal:'own',        insurance:'own' },
    store:      null,
    kpi:        { depts:['summary','packing','minesworkshop'], editDepts:[], daily:true },
    commercial: { sales:null, purchase:null },
    canViewAudit:  false,
    canManageUsers:false,
    canManageITAssets:false,
    canExport:     false,
  },

  mining: {
    mis_tabs: [],
    hr:         null,
    assets:     { it:'own',        vehicles:'own',  spares:'own',       capex:'own',  land:'view' },
    compliance: { certs:'own',     mlpl:'edit',     legal:'own',        insurance:'own' },
    store:      { rawmat:'edit',   spares:'own',    amc:null },
    kpi:        { depts:['summary','mines'], editDepts:['mines'], daily:true },
    commercial: { sales:null, purchase:null },
    canViewAudit:  false,
    canManageUsers:false,
    canManageITAssets:false,
    canExport:     false,
  },

  production: {
    mis_tabs: [],
    hr:         null,
    assets:     null,
    compliance: null,
    store:      { rawmat:'view',   spares:'own',    amc:null },
    kpi:        { depts:['summary','production','packing'], editDepts:['production'], daily:true },
    commercial: { sales:null, purchase:null },
    canViewAudit:  false,
    canManageUsers:false,
    canManageITAssets:false,
    canExport:     false,
  },

  sales: {
    mis_tabs: [],
    hr:         null,
    assets:     null,
    compliance: null,
    store:      null,
    kpi:        { depts:['summary'], editDepts:[], daily:true },
    commercial: { sales:'edit', purchase:null },
    canViewAudit:  false,
    canManageUsers:false,
    canManageITAssets:false,
    canExport:     true,
  },

  purchase: {
    mis_tabs: [],
    hr:         null,
    assets:     null,
    compliance: null,
    store:      null,
    kpi:        { depts:['summary'], editDepts:[], daily:false },
    commercial: { sales:null, purchase:'view' },
    canViewAudit:  false,
    canManageUsers:false,
    canManageITAssets:false,
    canExport:     true,
  },

  ei: {
    mis_tabs: [],
    hr:         null,
    assets:     null,
    compliance: null,
    store:      null,
    kpi:        { depts:['summary','ei'], editDepts:['ei'], daily:false },
    commercial: { sales:null, purchase:null },
    canViewAudit:  false,
    canManageUsers:false,
    canManageITAssets:false,
    canExport:     false,
  },

  packing: {
    mis_tabs: [],
    hr:         null,
    assets:     null,
    compliance: null,
    store:      null,
    kpi:        { depts:['summary','packing'], editDepts:['packing'], daily:false },
    commercial: { sales:null, purchase:null },
    canViewAudit:  false,
    canManageUsers:false,
    canManageITAssets:false,
    canExport:     false,
  },

  /* Quality Control — the QC Manager and the lab officers under them,
     added 2026-09-22. The three lab reports (Quality/Lab, Limestone %,
     Pile Quality) are their own measurements; until now the only people
     who could file them were Production, who receive those figures rather
     than produce them. See FORM_ACCESS and FORM_APPROVAL_OWNER in
     forms/access-registry.js — Production keeps both the submit right and
     the sign-off, so nobody loses anything and author and approver stay in
     different departments.

     editDepts is empty on purpose: the lab feeds Production's KPIs and
     owns no department section of its own on index.html. `depts` includes
     'production' as VIEW so the QC Manager can see what their own readings
     roll up into. canExport is true — lab results are routinely shared
     with customers and TBS. */
  quality: {
    mis_tabs: [],
    hr:         null,
    assets:     null,
    compliance: null,
    store:      null,
    kpi:        { depts:['summary','production'], editDepts:[], daily:true },
    commercial: { sales:null, purchase:null },
    canViewAudit:  false,
    canManageUsers:false,
    canManageITAssets:false,
    canExport:     true,
  },
};

/* Roles that may open the MIS Dashboard (mis.html — the sidebar's
   "Management Info." group). Management-only as of 2026-09-03: the page
   aggregates HR strength, asset registers, compliance certificates and
   store positions across every department, so under the departmental-
   boundary rule no single department has grounds to read it.

   Kept as an explicit list rather than inferred from mis_tabs.length so
   the page guard states the policy outright — mis_tabs then decides which
   TABS a permitted role sees, not whether it may be here at all. Mirrors
   MIS_VIEW_ROLES in forms/access-registry.js; the pair is diffed by
   backend/test/access-consistency.test.js. */
const MIS_VIEW_ROLES = ['admin', 'management', 'md'];

/* ══════════════════════════════════════════════════════════════════════
   SESSION MANAGEMENT
══════════════════════════════════════════════════════════════════════ */
/* Real backend login — POSTs credentials, stores the JWT + a session object
   shaped exactly like the old client-side one so every existing permission
   helper below (which all read getCurrentUser() synchronously) keeps working
   unchanged. Returns { ok, mustChangePassword, error } — login.html branches
   on it (mustChangePassword shows the set-new-password panel; error carries
   the server's message, e.g. the account-locked countdown). Throws
   Error('unreachable') only when the server can't be reached at all. */
async function login(username, password) {
  let res;
  try {
    res = await fetch(_API_BASE + '/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });
  } catch (networkErr) {
    throw new Error('unreachable'); // distinguish from bad-credentials for login.html
  }

  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error response */ }

  if (!res.ok) {
    return { ok: false, error: (body && body.error) || 'Invalid username or password. Please try again.' };
  }

  const { token, user: u, mustChangePassword } = body;
  sessionStorage.setItem(_TOKEN_KEY, token);
  sessionStorage.setItem(_SESSION_KEY, JSON.stringify({
    userId:    u.id,
    username:  u.username,
    name:      u.name,
    role:      u.role,
    dept:      u.dept,
    level:     u.level,
    loginTime: Date.now(),
  }));
  _writeAudit('LOGIN', '—', '—', '—', '—', u.name + ' logged in from ' + (window.location.pathname.split('/').pop() || 'browser'));
  return { ok: true, mustChangePassword: !!mustChangePassword };
}

/* Change the logged-in user's password. On success the server revokes all
   old tokens (token_version bump) and returns a fresh one, which we swap in
   so the current session continues seamlessly. */
async function changePassword(currentPassword, newPassword) {
  let res;
  try {
    res = await fetch(_API_BASE + '/auth/change-password', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() },
      body:    JSON.stringify({ currentPassword, newPassword }),
    });
  } catch {
    return { ok: false, error: 'Cannot reach the server — is the backend running?' };
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error response */ }
  if (!res.ok) return { ok: false, error: (body && body.error) || 'Password change failed.' };
  sessionStorage.setItem(_TOKEN_KEY, body.token);
  return { ok: true };
}

async function logout() {
  const user = getCurrentUser();
  if (user) _writeAudit('LOGOUT', '—', '—', '—', '—', user.name + ' logged out');
  try {
    await fetch(_API_BASE + '/auth/logout', {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + getAuthToken() },
    });
  } catch { /* best-effort — still log out locally even if server is unreachable */ }
  sessionStorage.removeItem(_SESSION_KEY);
  sessionStorage.removeItem(_TOKEN_KEY);
  window.location.href = window.location.pathname.includes('/forms/') ? '../login.html' : 'login.html';
}

function getCurrentUser() {
  try {
    const s = sessionStorage.getItem(_SESSION_KEY);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

function getAuthToken() {
  return sessionStorage.getItem(_TOKEN_KEY);
}

/* login.html lives at the app root; pages inside /forms/ need the ../
   prefix or the redirect 404s on forms/login.html. The return param is
   resolved FROM login.html (at the root), so forms pages must carry their
   forms/ prefix for the post-login bounce-back to land on the right page. */
function _loginUrl() {
  const inForms = window.location.pathname.includes('/forms/');
  const page    = window.location.pathname.split('/').pop() || 'index.html';
  /* Keep the page's own query so a deep link (compliance.html?item=42 from
     a reminder email) survives signing in. login.html accepts only an
     in-app page as the return target. */
  const ret     = (inForms ? 'forms/' + page : page) + (window.location.search || '');
  return (inForms ? '../' : '') + 'login.html?return=' + encodeURIComponent(ret);
}

function requireAuth() {
  if (!getCurrentUser()) {
    window.location.href = _loginUrl();
    return;
  }
  // Fast path above is synchronous (no flash of protected content). Also
  // verify the token is still valid in the background — catches an expired
  // JWT (8h) or a server-side secret rotation without blocking page render.
  _verifySessionOrRedirect();
}

async function _verifySessionOrRedirect() {
  let invalid = false;
  try {
    const res = await fetch(_API_BASE + '/auth/me', {
      headers: { 'Authorization': 'Bearer ' + getAuthToken() },
    });
    invalid = (res.status === 401 || res.status === 403);
    if (res.ok) {
      // Sliding session: server hands back a fresh token near expiry
      const renewed = res.headers.get('X-Renewed-Token');
      if (renewed) sessionStorage.setItem(_TOKEN_KEY, renewed);
      // Flagged accounts must set a new password before using the app —
      // bounce through login, which shows the set-new-password panel.
      const me = await res.json();
      if (me && me.must_change_password) invalid = true;
    }
  } catch {
    // Network failure ≠ invalid session: don't log the user out just
    // because the backend is briefly unreachable — offline fallbacks
    // elsewhere are designed for exactly that case.
  }
  if (invalid) {
    sessionStorage.removeItem(_SESSION_KEY);
    sessionStorage.removeItem(_TOKEN_KEY);
    window.location.href = _loginUrl();
  }
}

/* ══════════════════════════════════════════════════════════════════════
   PERMISSION HELPERS
══════════════════════════════════════════════════════════════════════ */
function _getPerms() {
  const u = getCurrentUser();
  return u ? (PERMISSIONS[u.role] || {}) : {};
}

function canView(tab, section) {
  const p = _getPerms();
  if (!tab) return false;
  if (!section) return !!(p.mis_tabs && p.mis_tabs.includes(tab));
  const level = p[tab] ? p[tab][section] : null;
  return level === 'view' || level === 'edit' || level === 'own';
}

function canEdit(tab, section) {
  const p = _getPerms();
  if (!tab || !section) return false;
  const level = p[tab] ? p[tab][section] : null;
  return level === 'edit' || level === 'own';
}

function canViewAudit()    { return _getPerms().canViewAudit    === true; }
function canExport()       { return _getPerms().canExport       === true; }
function canManageUsers()  { return _getPerms().canManageUsers  === true; }
function canManageITAssets() { return _getPerms().canManageITAssets === true; }
function canSubmitDaily()  { return _getPerms().kpi?.daily      === true; }

/* Sales & Purchases sidebar group — 'view'|'edit'|null, parallel to the
   MIS tab/section model. Not part of `kpi.depts` since Sales isn't
   formula-registry/kpi_monthly-shaped data — it's its own page. */
function canViewSales() { const s = _getPerms().commercial?.sales; return s === 'view' || s === 'edit'; }
function canEditSales() { return _getPerms().commercial?.sales === 'edit'; }

/* Purchases dashboard — split out from canViewSales()/canEditSales() now
   that Purchase has its own role/department (previously rode on the same
   commercial.sales gate for lack of a check of its own). */
function canViewPurchases() { const p = _getPerms().commercial?.purchase; return p === 'view' || p === 'edit'; }
function canEditPurchases() { return _getPerms().commercial?.purchase === 'edit'; }

/* dispatch.html's own gate (same file, canView) reads
   getDailyAccessFor(role).nav for 'dispatch-form.html' directly rather than
   a commercial.* permission — mirrored here, not reimplemented differently,
   so the sidebar row can never show for a role the page itself would deny,
   or hide for one it would allow. Added so dispatch.html has a sidebar
   entry at all (2026-10-16): it previously had none and was reachable only
   by a direct URL or a link from sales.html's report-switcher tab. */
function canViewDispatch() {
  const access = getMyDailyAccess();
  return access.nav === 'all' || (access.nav || []).indexOf('dispatch-form.html') !== -1;
}

/* A commercial-only role: holds a Sales and/or Purchases grant but no
   plant KPI department beyond the shared 'summary' landing dept, and no
   plant daily-report nav of its own. For such a user the plant-wide
   Analytics dashboards (Operational Summary, Power & Heat, Reliability &
   Stoppage) and the Entry Summary completeness grid are all about
   departments they neither fill nor own, so the sidebar drops them and
   leads with their own dashboard instead (2026-10-02, asked for directly
   by Sales). Derived from the permission shape rather than a role name so
   a future commercial role inherits it without another edit here.
   This is a NAVIGATION rule only — those pages remain reachable by URL and
   are still gated by their own checks; nothing here grants or revokes
   access. */
function isCommercialOnly() {
  const p = _getPerms();
  const depts = p.kpi?.depts;
  if (!Array.isArray(depts)) return false;                 // 'all' or absent → not commercial-only
  if (depts.some(d => d !== 'summary')) return false;       // owns a real plant dept
  return (p.commercial?.sales || p.commercial?.purchase) ? true : false;
}

/* MIS Dashboard (mis.html). Management-only — see MIS_VIEW_ROLES above.
   Enforced in three places, because a hidden nav link is not a permission:
   the sidebar hides the group, mis.html redirects on load, and
   backend/routes/mis.js 403s the dashboard's own data routes. */
function canViewMIS() {
  const u = getCurrentUser();
  return !!u && MIS_VIEW_ROLES.includes(u.role);
}

/* Page guard for management-only pages: bounces anyone else to the KPI
   dashboard rather than leaving them on a page rendered empty by the
   per-tab checks. Call right after requireAuth(). */
function requireMISAccess() {
  if (getCurrentUser() && !canViewMIS()) {
    window.location.href = 'index.html';
    return false;
  }
  return true;
}

/* Tier accessors — 'officer' | 'senior' | 'hod' (L3 | L2 | L1).
   Two things are HOD-only:
     • approving/rejecting a department's daily reports
       (backend/middleware/approval.js)
     • editing monthly KPI values
       (backend/middleware/kpiAccess.js — see _canEditKpiAtMyLevel below)
   Officer/Senior keep identical VIEW rights to their HOD, and fill and
   submit the daily reports that feed the KPIs. */
function getMyLevel() { const u = getCurrentUser(); return u ? (u.level || 'hod') : null; }
function isHOD()      { return getMyLevel() === 'hod'; }

/* Mirrors the server's level gate in backend/middleware/kpiAccess.js so the
   Fill button is hidden rather than offering a save the server will 403.
   `admin` is the break-glass exemption there, so it is here too. */
function _canEditKpiAtMyLevel() {
  const u = getCurrentUser();
  if (!u) return false;
  return u.role === 'admin' || getMyLevel() === 'hod';
}

/* Per-department KPI view/edit checks — the KPI dashboard has ONE dept
   selected at a time (currentDept in app.js), and a role's rights can
   differ per department, so these must be checked against a specific dept
   rather than as a single global flag. */
function canViewKPIDept(dept) {
  const depts = _getPerms().kpi?.depts;
  if (!depts) return false;
  return depts === 'all' || (Array.isArray(depts) && depts.includes(dept));
}
function canFillKPIDept(dept) {
  const editDepts = _getPerms().kpi?.editDepts;
  if (!editDepts) return false;
  if (!_canEditKpiAtMyLevel()) return false;   // L1 only — see _canEditKpiAtMyLevel
  return editDepts === 'all' || (Array.isArray(editDepts) && editDepts.includes(dept));
}
/* True if this role may replace a formula-computed KPI with a manual figure.
   Distinct from canFillKPIDept(): an override supersedes a value the engine
   derived from submitted daily reports, is permanently audited with a
   mandatory reason, and is restricted to admin/md server-side
   (POST /api/formula/override, backend/routes/formula.js). Mirrored here so
   the inline editor doesn't invite an edit the server will refuse. */
function canOverrideKPI() {
  const u = getCurrentUser();
  return !!u && (u.role === 'admin' || u.role === 'md');
}

/* True if this role can edit ANY department at all — used only to decide
   whether the Fill button's visibility should ever be re-evaluated. */
function canFillKPI() {
  const editDepts = _getPerms().kpi?.editDepts;
  if (!_canEditKpiAtMyLevel()) return false;   // L1 only — see _canEditKpiAtMyLevel
  return editDepts === 'all' || (Array.isArray(editDepts) && editDepts.length > 0);
}

/* Public permission accessors used by portal.js */
function getMyPerms()      { return _getPerms(); }
function getMyDailyAccess() {
  const u = getCurrentUser();
  return u ? (_DAILY_ACCESS[u.role] || { edit:[], nav:[] }) : { edit:[], nav:[] };
}

/* Which standalone forms/*.html formTypes this role may submit — mirrors
   _FORM_TYPE_ACCESS (declared further down this file). Used by portal.js
   to decide which "Daily Reports" tiles to show, same way getMyDailyAccess()
   drives tile visibility for the 3 hub-style pages. */
function getMyFormAccess() {
  const u = getCurrentUser();
  return u ? (_FORM_TYPE_ACCESS[u.role] || []) : [];
}

function getAllowedKPIDepts() {
  const p = _getPerms();
  return p.kpi?.depts || [];
}

/* ══════════════════════════════════════════════════════════════════════
   INTERNAL AUDIT WRITER
   (standalone — audit.js calls this too once loaded)
══════════════════════════════════════════════════════════════════════ */
function _writeAudit(action, tab, section, field, oldVal, newVal) {
  try {
    const u = getCurrentUser();
    const entry = {
      ts:      new Date().toISOString(),
      user:    u ? u.name     : 'Unknown',
      dept:    u ? u.dept     : '—',
      role:    u ? u.role     : '—',
      action,
      tab:     tab     || '—',
      section: section || '—',
      field:   field   || '—',
      oldVal:  String(oldVal || '').slice(0, 300),
      newVal:  String(newVal || '').slice(0, 300),
    };
    const log = JSON.parse(localStorage.getItem('lcl_audit_log') || '[]');
    log.unshift(entry);
    if (log.length > 2000) log.splice(2000);
    localStorage.setItem('lcl_audit_log', JSON.stringify(log));
  } catch(e) { /* silently fail */ }
}

/* ══════════════════════════════════════════════════════════════════════
   INJECT AUTH CSS
══════════════════════════════════════════════════════════════════════ */
(function injectAuthCSS() {
  const css = `
    /* ── Auth user block in header ── */
    /* ══════════════════════════════════════════════════
       AUTH USER BLOCK — always the rightmost item in
       .header-right, thanks to order:100.
       No DOM manipulation needed.
    ══════════════════════════════════════════════════ */
    #auth-user-info {
      display: flex;
      align-items: center;
      order: 100;               /* always last in header-right */
      flex-shrink: 0;
    }
    #auth-user-info:empty { display: none; }

    .auth-user-block {
      display: flex;
      align-items: center;
      gap: 8px;
      padding-left: 12px;
      border-left: 1px solid rgba(255,255,255,.15);
    }
    .auth-user-avatar {
      width: 30px; height: 30px;
      border-radius: 50%;
      background: var(--orange, #F49545);
      /* Navy, not white. White on Nyati orange is 2.27:1 — the avatar
         was the last place in the app still doing it. --on-orange is
         the paired ink token and clears AA at 5.71:1. */
      color: var(--on-orange, #173158);
      font-size: 13px; font-weight: 800;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      border: 2px solid rgba(255,255,255,.2);
    }
    .auth-user-details {
      display: flex;
      flex-direction: column;
      line-height: 1.2;
    }
    .auth-user-name {
      font-size: 12px; font-weight: 700;
      color: #fff;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      max-width: 130px;
    }
    .auth-logout-btn {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px 12px;
      border-radius: 6px;
      background: rgba(255,255,255,.1);
      border: 1px solid rgba(255,255,255,.2);
      color: rgba(255,255,255,.85);
      font-family: inherit; font-size: 12px; font-weight: 700;
      cursor: pointer;
      transition: background .15s, color .15s;
      white-space: nowrap; flex-shrink: 0;
    }
    .auth-logout-btn:hover {
      background: rgba(255,255,255,.2); color: #fff;
    }

    /* ── Permission-denied flash ── */
    .auth-denied-flash {
      position:fixed; top:80px; right:24px; z-index:9999;
      background:#EF4444; color:white; padding:10px 20px;
      border-radius:6px; font-size:12px; font-weight:700;
      box-shadow:0 4px 16px rgba(0,0,0,.2);
      animation:fadeInOut 2.5s forwards;
    }

    /* ── Audit trail tab styles ── */
    .audit-filter-bar {
      display:flex; flex-wrap:wrap; gap:10px; padding:14px 18px;
      background:#F8FAFC; border-bottom:1px solid var(--border,#E2E8F0);
      align-items:center;
    }
    .audit-filter-bar input, .audit-filter-bar select {
      font-family:inherit; font-size:12px; padding:5px 9px;
      border:1.5px solid var(--border,#E2E8F0); border-radius:6px; outline:none;
    }
    .audit-filter-bar input:focus, .audit-filter-bar select:focus {
      border-color:var(--orange,#F49545);
    }
    .audit-action-badge {
      display:inline-block; padding:2px 8px; border-radius:6px;
      font-size:12px; font-weight:700;
    }
    .audit-empty {
      text-align:center; padding:40px; color:var(--text-muted,#64748B); font-size:12px;
    }

    /* ── Audit role badge ── */
    .audit-role-badge {
      display:inline-block; padding:1px 7px; border-radius:6px;
      font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.4px;
      background:#F1F5F9; color:#475569; border:1px solid #E2E8F0;
    }

    /* ── Audit pagination bar ── */
    .audit-pagination {
      display:flex; align-items:center; justify-content:center; gap:12px;
      padding:10px 18px;
      border-top:1px solid var(--border,#E2E8F0);
      background:#F8FAFC;
    }
    .audit-pagination .mis-edit-btn:disabled {
      opacity:.4; cursor:not-allowed;
    }

    /* ── Access Rights Matrix ── */
    .arm-table-wrap {
      overflow-x:auto; max-height:480px;
    }
    .arm-table {
      font-size:12px; white-space:nowrap; border-collapse:collapse;
    }
    .arm-table th, .arm-table td {
      padding:5px 8px; border:1px solid var(--border,#E2E8F0);
    }
    .arm-role-hdr {
      background:#F1F5F9; font-size:12px; font-weight:800;
      color:var(--navy,#173158); text-align:left;
      position:sticky; left:0; z-index:2;
    }
    .arm-group-hdr {
      background:var(--navy,#173158); color:white;
      font-size:12px; font-weight:800; text-align:center;
      letter-spacing:.5px; text-transform:uppercase;
    }
    .arm-special-grp { background:#4B5563; }
    .arm-col-hdr {
      background:#F8FAFC; font-size:12px; font-weight:700;
      color:#475569; text-align:center; text-transform:uppercase;
    }
    .arm-special-col, .arm-kpi-col {
      background:var(--st-good-bg);
    }
    .arm-role-cell {
      background:#F8FAFC; font-size:12px;
      position:sticky; left:0; z-index:1;
      white-space:nowrap;
    }
    .arm-role-cell strong { display:block; color:var(--navy,#173158); }
    .arm-role-slug {
      font-size:12px; font-weight:600; color:var(--text-muted);
      text-transform:uppercase; letter-spacing:.4px;
    }
    .arm-cell { text-align:center; padding:4px 6px; }
    .arm-badge {
      display:inline-block; padding:2px 7px; border-radius:6px;
      font-size:12px; font-weight:800; letter-spacing:.3px;
    }
    .arm-edit  { background:var(--st-good-bg); color:#166534; border:1px solid #86EFAC; }
    .arm-view  { background:#DBEAFE; color:#1E40AF; border:1px solid #93C5FD; }
    .arm-own   { background:var(--st-warn-bg); color:#92400E; border:1px solid var(--st-warn-bd); }
    .arm-none  { background:#F1F5F9; color:var(--text-muted); border:1px solid #E2E8F0; }
    .arm-tick  { color:#16A34A; font-weight:800; font-size:12px; }
    .arm-kpi-depts {
      font-size:12px; font-weight:700; color:#0369A1;
      border-bottom:1px dashed #93C5FD; cursor:default;
    }
    .arm-legend {
      display:flex; flex-wrap:wrap; gap:12px; align-items:center;
      padding:10px 16px; font-size:12px; color:#475569;
      background:#F8FAFC; border-bottom:1px solid var(--border,#E2E8F0);
    }
  `;
  const tag = document.createElement('style');
  tag.textContent = css;
  document.head.appendChild(tag);
})();

/* ══════════════════════════════════════════════════════════════════════
   RENDER TOP HEADER — home button + Nyati/Lake Cement logos.
   Single source for markup that used to be copy-pasted into
   <header class="top-header"> on every page; call it inline right after
   <header id="app-header"></header> so it fills in before any later
   script (e.g. applyDailyPermissions -> renderUserHeader) touches
   #auth-user-info. portal.html omits the Home button (it IS home).
══════════════════════════════════════════════════════════════════════ */
function renderTopHeader() {
  const mount = document.getElementById('app-header');
  if (!mount) return;
  const path     = window.location.pathname;
  const base     = path.includes('/forms/') ? '../' : '';
  const isPortal = (path.split('/').pop() || '') === 'portal.html';

  const homeBtn = isPortal ? '' : `
      <a href="${base}portal.html" class="home-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19 12H5M5 12l7-7M5 12l7 7"/></svg>
        Home
      </a>
      <span class="sh-sep"></span>`;

  mount.innerHTML = `
    <div class="header-left">${homeBtn}
      <div class="logo-block">
        <img class="nyati-logo" src="${base}NYATI-LOGO.png" alt="Nyati Cement" />
        <div class="logo-text">
          <img class="lc-wordmark" src="${base}lake-cement-ltd logo (Good Times Regular).png" alt="Lake Cement Ltd" />
        </div>
      </div>
    </div>
    <div class="header-right">
      <div id="auth-user-info"></div>
    </div>`;
}

/* ══════════════════════════════════════════════════════════════════════
   RENDER USER INFO IN HEADER
══════════════════════════════════════════════════════════════════════ */
function renderUserHeader() {
  const user = getCurrentUser();
  const container = document.getElementById('auth-user-info');
  if (!container) return;
  if (!user) { container.innerHTML = ''; return; }

  container.innerHTML = `
    <div class="auth-user-block">
      <div class="auth-user-avatar">${user.name.charAt(0).toUpperCase()}</div>
      <div class="auth-user-details">
        <div class="auth-user-name">${user.name}</div>
      </div>
      <button class="auth-logout-btn" onclick="logout()">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
        Logout
      </button>
    </div>`;

  /* Move auth block to be the last child of header-right so it always
     sits at the far right — CSS order:100 is the primary mechanism,
     this is a belt-and-suspenders DOM move as fallback. */
  const parent = container.parentNode;
  if (parent && container !== parent.lastElementChild) {
    parent.appendChild(container);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   APPLY PERMISSIONS — MIS PAGE (mis.html)
══════════════════════════════════════════════════════════════════════ */
function applyMISPermissions() {
  const user = getCurrentUser();
  if (!user) return;
  const p = _getPerms();

  /* ── Tab visibility ── */
  const tabIdMap = {
    hr:         'tab-hr',
    assets:     'tab-assets',
    compliance: 'tab-compliance',
    store:      'tab-store',
    audit:      'tab-audit',
  };
  let firstVisible = null;
  Object.entries(tabIdMap).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const allowed = Array.isArray(p.mis_tabs) && p.mis_tabs.includes(key);
    el.style.display = allowed ? '' : 'none';
    if (allowed && !firstVisible) firstVisible = key;
  });

  /* ── If current active tab is hidden, switch to first allowed ── */
  if (firstVisible) {
    const activeTab = document.querySelector('.mis-tab.active');
    const activePanelId = activeTab ? 'panel-' + activeTab.id.replace('tab-','') : null;
    const activePanel = activePanelId ? document.getElementById(activePanelId) : null;
    if (!activePanel || activePanel.style.display === 'none' || (activeTab && activeTab.style.display === 'none')) {
      if (typeof showMisTab === 'function') showMisTab(firstVisible);
    }
  }

  /* ── Edit-button visibility ──
     Format: [ querySelector, tab, section ]              */
  const editBtnRules = [
    ['#legal-edit-btn',                    'compliance', 'legal'],
    ['#ins-edit-btn',                      'compliance', 'insurance'],
    ['button[onclick*="openAddClaimModal"]','compliance', 'insurance'],
    ['button[onclick*="exportLegal"]',     'compliance', 'legal'],
    ['button[onclick*="exportInsurance"]', 'compliance', 'insurance'],
    ['button[onclick*="exportAmc"]',       'store',      'amc'],
  ];
  editBtnRules.forEach(([sel, tab, section]) => {
    document.querySelectorAll(sel).forEach(el => {
      if (!canEdit(tab, section)) el.style.display = 'none';
    });
  });

  /* ── Hide export buttons for roles without canExport ── */
  if (!canExport()) {
    document.querySelectorAll('button[onclick*="export"], button[onclick*="download"], button[onclick*="Export"]').forEach(el => {
      el.style.display = 'none';
    });
  }

  /* ── Render user header ── */
  renderUserHeader();

  /* ── Intercept localStorage saves for audit logging ── */
  _hookLocalStorageAudit();
}

/* ══════════════════════════════════════════════════════════════════════
   APPLY PERMISSIONS — KPI / INDEX PAGE (index.html)
══════════════════════════════════════════════════════════════════════ */
function applyKPIPermissions() {
  const p = _getPerms();
  const depts = p.kpi?.depts || [];

  /* The sidebar (sidebar.js) already only ever renders departments this
     role can view, so nothing to hide there. The Executive Summary's
     .sc-chip cross-department scorecard is a second, independent way to
     reach a department view, still needs the same filtering. */
  if (depts !== 'all' && Array.isArray(depts)) {
    document.querySelectorAll('.sc-chip[data-dept]').forEach(chip => {
      if (!depts.includes(chip.dataset.dept)) chip.style.display = 'none';
    });
  }

  refreshFillButtonVisibility();
  renderUserHeader();
}

/* Show/hide the "Fill Monthly Data" button based on whether the CURRENTLY
   SELECTED department is one this role may edit — not just whether the
   role can edit *some* department. Must be re-run every time the selected
   department changes (see switchDept() in app.js), otherwise a role could
   open the editor for a department by switching to it while the button's
   stale visibility state from page-load still says "visible". */
/* Two departments have edit rights on paper but nothing this modal can fill:
   Executive Summary has no KPI rows at all, and Mines Workshop's
   per-equipment TARGET/ACTUAL matrix has no kpi_monthly rows behind it —
   openMonthlyModal() refuses both with an alert. Showing the button there
   (which it did for admin/management, whose editDepts is 'all') offers an
   action that can only fail. */
const _NON_FILLABLE_KPI_DEPTS = ['summary', 'minesworkshop'];

function refreshFillButtonVisibility() {
  const fillBtn = document.querySelector('.fill-monthly-btn');
  if (!fillBtn) return;
  const dept = (typeof currentDept !== 'undefined') ? currentDept : 'summary';
  const fillable = canFillKPIDept(dept) && !_NON_FILLABLE_KPI_DEPTS.includes(dept);
  fillBtn.style.display = fillable ? '' : 'none';
}

/* ══════════════════════════════════════════════════════════════════════
   DAILY REPORT — ACCESS MATRIX
   Maps each role to:
     edit  : pages this role can fill in (edit inputs + submit)
     nav   : nav links this role may see ('all' or array of filenames)
   'all' means every nav link is visible for that role (view-only access).
══════════════════════════════════════════════════════════════════════ */
const _DAILY_ACCESS = {
  md:         { edit: [],                                                          nav: 'all' },
  admin:      { edit: [],                                                          nav: 'all' },
  management: { edit: [],                                                          nav: 'all' },
  finance:    { edit: [],                                                          nav: 'all' },
  hr:         { edit: [],
                nav:  ['daily-report.html'] },
  stores:     { edit: [],
                nav:  ['daily-report.html','materials-form.html'] },
  cpp:        { edit: ['power-plant-report.html'],
                nav:  ['daily-report.html','power-plant-report.html'] },
  pm:         { edit: [],
                nav:  ['stoppage-form.html','power-form.html'] },
  it:         { edit: [],
                nav:  ['daily-report.html'] },
  logistics:  { edit: [],
                nav:  ['daily-report.html','dispatch-form.html'] },
  mining:     { edit: ['mines-report.html'],
                nav:  ['daily-report.html','mines-report.html'] },
  production: { edit: ['daily-report.html'],
                nav:  'all' },
  /* Dispatch & SO is read-only for Sales: the nav row grants the VIEW
     badge and dispatch.html's own canView gate, while submit rights stay
     with Logistics and Packing (_FORM_TYPE_ACCESS has no `dispatch` for
     sales), so the entry CTA stays hidden. Sales owns the orders this
     report fulfils and needs to see what actually shipped against them —
     dispatch.html's denial copy already named sales as an intended
     audience, but the nav row backing that claim was never added. */
  sales:      { edit: [],
                nav:  ['sales-projection-form.html','dispatch-form.html'] },
  /* Raw Materials is the Purchase & Stores department's daily report (see
     FORM_ACCESS.stores), so Purchase gets the nav row for it — before this
     the role's nav was empty and a purchase user opened the app to a Daily
     Reports group with no report in it at all. Read-only: the row carries a
     VIEW badge, because submit rights stay with `stores`. Adding purchase
     to FORM_ACCESS.materials as well would make `materials` a shared form
     type, and middleware/approval.js then refuses to boot until someone
     declares in FORM_APPROVAL_OWNER whose HOD signs the report off — an
     accountability call for the business, not a side effect of adding a
     button. GET /api/reports/* is requireAuth only, so the page reads its
     data normally; only POST is gated by requireFormAccess. */
  purchase:   { edit: [],
                nav:  ['materials-form.html'] },
  ei:         { edit: [],
                nav:  ['daily-report.html','power-form.html'] },
  packing:    { edit: [],
                nav:  ['daily-report.html','dispatch-form.html'] },
  /* The three lab reports plus Daily Reports itself, so the QC Manager
     lands somewhere with their own work on it rather than an empty hub.
     `edit` stays empty: it keys the 3 HUB pages, and none of these three
     is one — the standalone forms/*.html pages are gated by form type via
     _FORM_TYPE_ACCESS below, which is where `quality` gets its edit
     rights. */
  quality:    { edit: [],
                nav:  ['daily-report.html','quality-form.html','limestone-form.html','pile-quality-form.html'] },
};

/* ══════════════════════════════════════════════════════════════════════
   DAILY NAV CATALOGUE — single source of truth for the reports stripe
══════════════════════════════════════════════════════════════════════ */
/* Order follows the plant's manufacturing flow (quarry → pile → raw
   materials → production → quality → stoppages → power → dispatch →
   power plant), per the 2026-09-15 nav redesign — see project memory.
   An optional `club` groups adjacent rows under one sidebar sub-heading
   (sidebar.js pairs consecutive entries sharing the same `club`) without
   merging the underlying forms — that merge is tracked as follow-up work. */
const _DAILY_NAV_ITEMS = [
  { page:'mines-report.html',       label:'Quarrying',      icon:'pickaxe',   hRoot:'mines-report.html',       hForm:'../mines-report.html' },
  { page:'pile-quality-form.html',  label:'Pile Quality',   icon:'layers-3',  hRoot:'forms/pile-quality-form.html', hForm:'pile-quality-form.html' },
  { page:'materials-form.html',     label:'Raw Materials',  icon:'package',   hRoot:'forms/materials-form.html', hForm:'materials-form.html' },
  /* Production is the second report split into a read-only review page and
     an entry form (2026-09-15, same pattern as Dispatch & SO above). The
     nav leads to the REVIEW page (production.html); `page` stays
     'daily-report.html' since that is the permission key
     (_DAILY_ACCESS[role].nav) and the key forms/nav-status.js hangs
     today's fill-status dot on — only the destination moved. */
  { page:'daily-report.html',       label:'Production',     icon:'factory',   hRoot:'production.html',       hForm:'../production.html' },
  { page:'quality-form.html',       label:'Quality / Lab',  icon:'flask-conical', hRoot:'forms/quality-form.html', hForm:'quality-form.html', club:'Quality' },
  { page:'limestone-form.html',     label:'Limestone %',    icon:'mountain',      hRoot:'forms/limestone-form.html', hForm:'limestone-form.html', club:'Quality' },
  { page:'stoppage-form.html',      label:'Stoppages',      icon:'alert-triangle', hRoot:'forms/stoppage-form.html', hForm:'stoppage-form.html' },
  { page:'power-form.html',         label:'Power Consumption', icon:'activity', hRoot:'forms/power-form.html',    hForm:'power-form.html' },
  /* Dispatch & SO is the first report split into a read-only review page
     and an entry form (2026-09-15). The nav leads to the REVIEW page, which
     is what most people opening "Dispatch & SO" want — the review page then
     offers "Enter today's data" to whoever has the right to file it.

     `page` deliberately stays 'dispatch-form.html': it is the permission key
     (_DAILY_ACCESS[role].nav) and the key forms/nav-status.js hangs today's
     fill-status dot on. Only the destination moved, so access and the
     entered/not-entered dot both keep working unchanged. */
  { page:'dispatch-form.html',      label:'Dispatch & SO',  icon:'truck',     hRoot:'dispatch.html', hForm:'../dispatch.html', club:'Sales & Dispatch' },
  { page:'sales-projection-form.html', label:'Sales Projection', icon:'trending-up', hRoot:'forms/sales-projection-form.html', hForm:'sales-projection-form.html', club:'Sales & Dispatch' },
  /* Power Plant (CPP) is the third report split into a read-only review
     page and an entry form (2026-09-16, same pattern as Dispatch & SO and
     Production above). `page` deliberately stays 'power-plant-report.html':
     it is the permission key (_DAILY_ACCESS.cpp.nav) and the key
     forms/nav-status.js hangs today's fill-status dot on. Only the
     destination moved. */
  { page:'power-plant-report.html', label:'Power Plant',    icon:'zap',       hRoot:'power-plant.html', hForm:'../power-plant.html' },
];

/* ══════════════════════════════════════════════════════════════════════
   FORM-TYPE ACCESS — which roles may SUBMIT which formType (daily_reports
   rows). Distinct from _DAILY_ACCESS (which gates the 3 hub pages) and
   _IE_BTN_ROLES (which gates inline sub-panels on daily-report.html) —
   this covers the 10 standalone forms/*.html pages, which previously had
   no role mapping at all and were stuck permanently view-only for everyone.
   Mirrored server-side in backend/config/formAccess.js — keep both in sync.
══════════════════════════════════════════════════════════════════════ */
const _FORM_TYPE_ACCESS = {
  production: ['production','quality','limestone','pile-quality','stoppage'],   /* Stoppage transferred from P&M 2026-09-22 — Production now fills it (and, as sole submitter, its own HOD approves it) */
  quality:    ['quality','limestone','pile-quality'],   /* QC Manager, 2026-09-22 — the lab files its own three reports; Production keeps them too and signs them off, see FORM_APPROVAL_OWNER */
  pm:         ['power-cons'],   /* Stoppage moved to Production 2026-09-22 — P&M keeps read/view access to stoppage-form.html and reliability.html but no submit right. Power Cons. still shared with E&I below */
  logistics:  ['dispatch'],   /* Dispatch & SO submitted by both Logistics and Packing — Logistics approves, see FORM_APPROVAL_OWNER */
  cpp:        ['cpp'],   // 'power-plant' retired 2026-08-31 — see backend/config/forms.js
  mining:     ['mines'],
  stores:     ['materials'],   /* Raw Materials report is owned by Purchase & Stores */
  sales:      ['sales-projection'],
  ei:         ['power-cons'],   /* E&I owns Power Cons. readings (kWh/meters) — P&M keeps it too, see pm above */
  packing:    ['dispatch'],     /* Packing Plant fills the Dispatch & SO report — it's their core daily report; Logistics keeps it and signs it off, see logistics above */
  hr: [], it: [], md: [], admin: [], management: [], finance: [], purchase: [],
};

/* Standalone forms/*.html pages don't carry their formId in the URL, and
   applyDailyPermissions() runs before initFormPersist() sets
   window._nyatiFormId — so map filename → formType statically instead. */
const _STANDALONE_FORM_TYPE = {
  'quality-form.html':      'quality',
  'dispatch-form.html':     'dispatch',
  'limestone-form.html':    'limestone',
  'materials-form.html':    'materials',
  'pile-quality-form.html': 'pile-quality',
  'power-form.html':        'power-cons',
  'stoppage-form.html':     'stoppage',
  'sales-projection-form.html': 'sales-projection',
};

/* ══════════════════════════════════════════════════════════════════════
   NAV/SIDEBAR ACCESSORS — narrow, documented entry points onto the four
   data constants above (_DAILY_ACCESS, _DAILY_NAV_ITEMS,
   _FORM_TYPE_ACCESS, _STANDALONE_FORM_TYPE), so consumers like sidebar.js
   read through a named function instead of reaching into auth.js's
   internal shape directly — the internals can then change their
   representation later without every consumer needing to change too.
   Purely additive: the constants themselves are unchanged and still
   exist, so nothing that already references them directly breaks.
══════════════════════════════════════════════════════════════════════ */
function getDailyAccessFor(role) { return _DAILY_ACCESS[role] || { edit: [], nav: [] }; }
function getDailyNavItems() { return _DAILY_NAV_ITEMS; }
function getFormTypeAccessFor(role) { return _FORM_TYPE_ACCESS[role] || []; }
function getStandaloneFormType(page) { return _STANDALONE_FORM_TYPE[page]; }

/* ══════════════════════════════════════════════════════════════════════
   APPLY PERMISSIONS — DAILY REPORT PAGE & ALL SUB-FORMS
   Call this on every daily-report page (daily-report.html,
   power-plant-report.html, mines-report.html, forms/*.html, etc.)
══════════════════════════════════════════════════════════════════════ */
/* Human names for the departments that own a daily report. The banner
   tells a reader who to go to, so it needs the name people actually use,
   not the internal role key. */
const _DEPT_LABELS = {
  production: 'Production',
  pm: 'Mechanical (P&amp;M)',
  logistics: 'Logistics',
  cpp: 'Power Plant (CPP)',
  mining: 'Mining / Quarry',
  stores: 'Purchase &amp; Stores',
  sales: 'Sales',
  ei: 'E&amp;I',
  packing: 'Packing Plant',
  quality: 'Quality / Lab',
};

/* Which department owns the report on this page. Derived from the SAME
   _FORM_TYPE_ACCESS map that decides who may edit it, so the banner can
   never name a department the access rules disagree with. Returns null
   where there is no single owner — a hub page, or a form type two
   departments share (dispatch, power-cons) — because naming one of two
   owners would send the reader to the wrong desk half the time. */
function _viewOnlyOwnerLabel(page) {
  const formType = _STANDALONE_FORM_TYPE[page];
  if (!formType) return null;
  const owners = Object.keys(_FORM_TYPE_ACCESS)
    .filter(r => (_FORM_TYPE_ACCESS[r] || []).includes(formType));
  if (owners.length !== 1) return null;
  return _DEPT_LABELS[owners[0]] || owners[0];
}

function applyDailyPermissions() {
  const user = getCurrentUser();
  if (!user) return;

  const role       = user.role;
  const access     = _DAILY_ACCESS[role] || { edit: [], nav: [] };
  const currentPage = window.location.pathname.split('/').pop() || 'daily-report.html';

  // Standalone forms/*.html pages are gated by formType (_FORM_TYPE_ACCESS),
  // not by the page-filename-keyed _DAILY_ACCESS (that only ever lists the
  // 3 hub pages, so every standalone form used to be forced view-only).
  const standaloneFormType = _STANDALONE_FORM_TYPE[currentPage];
  const canEditPage = standaloneFormType
    ? (_FORM_TYPE_ACCESS[role] || []).includes(standaloneFormType)
    : access.edit.includes(currentPage);

  /* ── 1b. Show inline-edit buttons only to the owning department ──── */
  const _IE_BTN_ROLES = {
    'ie-btn-quality':   ['production'],
    'ie-btn-stoppages': ['production'],   /* Production owns stoppage data as of 2026-09-22 (moved from P&M) — P&M views only */
  };
  Object.entries(_IE_BTN_ROLES).forEach(([btnId, allowedRoles]) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.style.display = allowedRoles.includes(role) ? '' : 'none';
  });

  /* ── 2. View-Only mode when role cannot edit this page ──────────── */
  if (!canEditPage) {
    /* Disable every editable input/textarea/select EXCEPT inline-edit panel
       inputs and navigation controls (the toolbar's date field, and the
       Stoppage Dashboard tab's month/year pickers) — "can't edit this
       report's data" must not also mean "can't pick which day/month's
       report to look at". Without this exception a view-only role (e.g.
       Plant Head) is stuck on whatever date/month the page happened to
       load with, with no way to browse history through the page's own
       navigation. */
    document.querySelectorAll(
      'input:not(.ie-input):not([data-field="date"]), textarea:not(.ie-input), select:not(.ie-input):not(#sd-month):not(#sd-year)'
    ).forEach(el => {
      el.disabled = true;
      el.style.cursor = 'not-allowed';
    });

    /* Hide all action buttons (Save Draft, Submit, etc.).
       As a body STATE, not a one-time sweep: excel-import.js injects its
       "Import Excel" button into the toolbar after this runs, so a
       querySelectorAll here walked straight past it and every view-only
       user was shown a prominent Import button on a report they cannot
       write to. A class on <body> covers whatever arrives later too. */
    document.body.classList.add('is-readonly');
    document.querySelectorAll(
      '.btn-save, .btn-sub, .btn-out, button[type=submit], .fill-monthly-btn'
    ).forEach(el => el.style.display = 'none');

    /* Add a sticky "View Only" banner below the header */
    if (!document.getElementById('dr-view-only-banner')) {
      /* One message, not two flex columns. The old banner laid an icon,
         a sentence and a second sentence out as three flex children with
         no wrapping, so on a phone the two sentences became two narrow
         columns that each wrapped internally and started at different
         heights — it read as a layout bug on the one element whose whole
         job is to explain calmly why the Save button is missing. */
      const banner = document.createElement('div');
      banner.id = 'dr-view-only-banner';
      banner.className = 'ds-viewonly';
      banner.innerHTML =
        '<svg class="ds-viewonly-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
          'stroke="currentColor" stroke-width="2.2" aria-hidden="true">' +
          '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' +
        '<span class="ds-viewonly-text">' +
          /* Name the report's OWNER, not the reader's department. The old
             wording interpolated user.dept, which rendered "View only — IT
             cannot edit this report" for the admin account: that reads as a
             claim about the report (it belongs to IT, and IT is locked out),
             when the truth is the opposite — the report belongs to Purchase &
             Stores, and `admin` has no reporting department of its own,
             because FORM_ACCESS.admin is [] deliberately (it is the IT/system
             account, not a plant department). Saying who DOES own it is both
             true and the thing a reader needs in order to act. */
          (_viewOnlyOwnerLabel(currentPage)
            ? '<strong>View only &mdash; this report is owned by '
                + _viewOnlyOwnerLabel(currentPage) + '.</strong>'
              + '<span>Ask them to update the figures; you can still browse any date.</span>'
            : '<strong>View only &mdash; you cannot edit this report.</strong>'
              + '<span>Contact the department that owns it to have the data updated.</span>') +
        '</span>';

      /* Insert after the <header> element */
      const header = document.querySelector('header');
      if (header && header.nextSibling) {
        header.parentNode.insertBefore(banner, header.nextSibling);
      } else {
        document.body.insertBefore(banner, document.body.firstChild);
      }
    }

    /* Style the toolbar to signal read-only state */
    const toolbar = document.querySelector('.toolbar');
    if (toolbar) {
      toolbar.style.background = '#F1F5F9';
      toolbar.style.borderBottom = '2px solid #CBD5E1';
    }
  }

  /* ── 3. Render user info in header ──────────────────────────────── */
  renderUserHeader();
}

/* ══════════════════════════════════════════════════════════════════════
   APPLY PERMISSIONS — ANALYTICS PAGE (analytics.html)
══════════════════════════════════════════════════════════════════════ */
function applyAnalyticsPermissions() {
  renderUserHeader();
}

/* ══════════════════════════════════════════════════════════════════════
   APPLY PERMISSIONS — COMPLETENESS PAGE (completeness.html)
   Read-only, cross-department view — same as analytics.html, no
   role-based content filtering, just the shared header. ═══════════════ */
function applyCompletenessPermissions() {
  renderUserHeader();
}

/* ══════════════════════════════════════════════════════════════════════
   APPLY PERMISSIONS — BALANCE PAGE (balance.html)
   Read-only reconciliation view — same as analytics.html. ══════════════ */
function applyBalancePermissions() {
  renderUserHeader();
}

/* ══════════════════════════════════════════════════════════════════════
   APPLY PERMISSIONS — INSIGHTS PAGE (insights.html)
   Read-only correlation view — same as analytics.html. ═══════════════ */
function applyInsightsPermissions() {
  renderUserHeader();
}

/* ══════════════════════════════════════════════════════════════════════
   APPLY PERMISSIONS — RELIABILITY PAGE (reliability.html)
   Read-only equipment reliability / downtime report — same as
   analytics.html, no role-based content filtering. Stoppage data entry
   stays gated by _FORM_TYPE_ACCESS (production role, moved from pm
   2026-09-22) on forms/stoppage-form.html; this page only ever reads
   the aggregated numbers. ═══════════════════════════════════════════ */
function applyReliabilityPermissions() {
  renderUserHeader();
}

/* ══════════════════════════════════════════════════════════════════════
   APPLY PERMISSIONS — APPROVALS PAGE (approvals.html)
   No content filtering here — GET /api/approvals already scopes the list
   server-side (admin/md see everything, an HOD sees only their own
   department, everyone else gets []), so an Officer/Senior who navigates
   here directly just sees an empty state, not a redirect. ═══════════════ */
function applyApprovalsPermissions() {
  renderUserHeader();
}

/* ══════════════════════════════════════════════════════════════════════
   APPLY PERMISSIONS — SALES DASHBOARD (sales.html)
══════════════════════════════════════════════════════════════════════ */
function applySalesPermissions() {
  renderUserHeader();
  document.querySelectorAll('[data-sales-edit-only]').forEach(el => {
    el.style.display = canEditSales() ? '' : 'none';
  });
}

/* ══════════════════════════════════════════════════════════════════════
   AUDIT HOOK — intercept localStorage writes for key MIS actions
══════════════════════════════════════════════════════════════════════ */
function _hookLocalStorageAudit() {
  if (localStorage.__lcl_hooked) return;
  localStorage.__lcl_hooked = true;

  const keyMap = {
    'mis-edit-legal':    ['EDIT',   'Compliances', 'Legal Cases',       'Legal data updated'],
    'mis-amc-overrides': ['EDIT',   'Store',       'AMC Contracts',     'AMC record updated'],
    'mis-ins-edits':     ['EDIT',   'Compliances', 'Insurance Claims',  'Insurance claim updated'],
    'mis-ins-extra':     ['ADD',    'Compliances', 'Insurance Claims',  'New insurance claim added'],
    'mis-cert-upload':   ['UPLOAD', 'Compliances', 'Certificates',      'Certificates uploaded from Excel'],
  };

  const origSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function(key, value) {
    origSet(key, value);
    const mapped = keyMap[key];
    if (mapped) {
      _writeAudit(mapped[0], mapped[1], mapped[2], key, '—', mapped[3]);
    }
  };
}

/* ══════════════════════════════════════════════════════════════════════
   APPLY EDIT BUTTON PERMISSIONS — called after MIS_EDIT.init()
   Hides Edit buttons injected by mis-edit.js for sections the current
   role cannot edit.
══════════════════════════════════════════════════════════════════════ */
function applyEditButtonPermissions() {
  /* mis-edit.js stores permTab/permSection in its internal registry.
     Expose a check function that mis-edit.js calls when building buttons,
     but also sweep all injected .me-edit-btn-wrap elements after init. */
  document.querySelectorAll('.me-edit-btn-wrap').forEach(wrap => {
    /* Retrieve the table and its registry opts */
    const tableId = wrap.id.replace('edit-btn-', '');
    if (!tableId) return;
    const table = document.getElementById(tableId);
    if (!table) return;
    /* Find perm attributes on nearest mis-section (or rely on MIS_EDIT._reg) */
    const reg = (window.MIS_EDIT && window.MIS_EDIT._reg) ? window.MIS_EDIT._reg[tableId] : null;
    if (reg && reg.permTab && reg.permSection) {
      if (!canEdit(reg.permTab, reg.permSection)) {
        wrap.style.display = 'none';
      }
    }
  });

  /* Also hide Add Row bars for restricted roles */
  document.querySelectorAll('[id^="add-bar-"]').forEach(bar => {
    const tableId = bar.id.replace('add-bar-', '');
    const reg = (window.MIS_EDIT && window.MIS_EDIT._reg) ? window.MIS_EDIT._reg[tableId] : null;
    if (reg && reg.permTab && reg.permSection) {
      if (!canEdit(reg.permTab, reg.permSection)) {
        bar.style.display = 'none';
      }
    }
  });

  /* AMC edit button */
  if (!canEdit('store', 'amc')) {
    const amcBtn = document.getElementById('amc-edit-btn');
    if (amcBtn) amcBtn.style.display = 'none';
  }

  /* CSR add button */
  if (!canEdit('hr', 'csr')) {
    const csrBtn = document.getElementById('csr-add-btn');
    if (csrBtn) csrBtn.style.display = 'none';
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SHOW PERMISSION DENIED TOAST
══════════════════════════════════════════════════════════════════════ */
function showPermDenied(msg) {
  const div = document.createElement('div');
  div.className = 'auth-denied-flash';
  div.textContent = msg || 'Access denied — insufficient permissions';
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 2500);
}

/* ══════════════════════════════════════════════════════════════════════
   HUMAN ERROR TEXT
   ──────────────────────────────────────────────────────────────────────
   Pages were putting raw exception text in front of people. A quarry
   manager opening the report saw

     "Could not load quarry data from the server: submitForm(mines)
      failed: HTTP 403"

   which names an internal function, quotes a status code, and does not
   say the one thing that is true and useful: they can read this report
   but not change it. The original is still written to the console, where
   the person who needs it is looking.
══════════════════════════════════════════════════════════════════════ */
function humanError(err, fallback) {
  const raw = (err && (err.message || err.toString())) || '';
  if (raw) console.error('[lcl]', raw, err);
  const t = raw.toLowerCase();

  if (/\b403\b|forbidden|not permitted|access denied/.test(t)) {
    return 'You do not have permission to change this. Contact the department that owns it.';
  }
  if (/\b401\b|unauthor|token|session/.test(t)) {
    return 'Your session has ended. Sign in again to continue.';
  }
  if (/\b404\b|not found/.test(t)) {
    return 'That record could not be found — it may have been removed.';
  }
  if (/failed to fetch|networkerror|network request failed|load failed|econnrefused/.test(t)) {
    return 'Cannot reach the server. Check the plant network connection and try again.';
  }
  if (/\b5\d\d\b|internal server/.test(t)) {
    return 'The server could not complete that. Try again in a moment.';
  }
  return fallback || 'Something went wrong. Try again, and tell IT if it keeps happening.';
}
