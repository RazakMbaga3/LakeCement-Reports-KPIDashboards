/* ═══════════════════════════════════════════════════════════════════════
   Lake Cement Ltd — MIS Authentication & Role-Based Access Control
   auth.js  |  v1.0  |  2026-06-03
   -----------------------------------------------------------------------
   Provides: login, logout, session management, permission matrix,
             permission helpers, user-header rendering, page enforcement.
═══════════════════════════════════════════════════════════════════════ */
'use strict';

const _SESSION_KEY = 'lcl_mis_session';

/* ══════════════════════════════════════════════════════════════════════
   USER DATABASE
   Admin can edit usernames, passwords, names, roles, departments here.
   Passwords should be changed immediately after first login.
   Roles: md | admin | management | hr | finance | stores | cpp |
          pm | it | logistics | mining | production
══════════════════════════════════════════════════════════════════════ */
const MIS_USERS = [
  { id:1,  username:'admin',      password:'Admin@LCL2026',  name:'System Administrator',        role:'admin',      dept:'IT',             active:true },
  { id:2,  username:'md',         password:'MD@LCL2026',     name:'Managing Director',           role:'md',         dept:'CORPORATE',      active:true },
  { id:3,  username:'management', password:'Mgt@LCL2026',    name:'Senior Management',           role:'management', dept:'CORPORATE',      active:true },
  { id:4,  username:'hr',         password:'HR@LCL2026',     name:'HR & Admin Manager',          role:'hr',         dept:'HR & ADMIN',     active:true },
  { id:5,  username:'finance',    password:'Fin@LCL2026',    name:'Finance & Accounts Manager',  role:'finance',    dept:'FINANCE',        active:true },
  { id:6,  username:'stores',     password:'Str@LCL2026',    name:'Purchase & Stores Manager',   role:'stores',     dept:'STORES',         active:true },
  { id:7,  username:'cpp',        password:'CPP@LCL2026',    name:'Power Plant HOD',             role:'cpp',        dept:'POWER PLANT',    active:true },
  { id:8,  username:'pm',         password:'PM@LCL2026',     name:'Projects & Maintenance HOD',  role:'pm',         dept:'P & M',          active:true },
  { id:9,  username:'it',         password:'IT@LCL2026',     name:'IT Manager',                  role:'it',         dept:'IT',             active:true },
  { id:10, username:'logistics',  password:'Log@LCL2026',    name:'Logistics & Workshops HOD',   role:'logistics',  dept:'LOGISTICS',      active:true },
  { id:11, username:'mining',     password:'Min@LCL2026',    name:'Mining Manager',              role:'mining',     dept:'MINING',         active:true },
  { id:12, username:'production', password:'Prod@LCL2026',   name:'Production & QC Manager',     role:'production', dept:'PRODUCTION & QC',active:true },
];

/* ══════════════════════════════════════════════════════════════════════
   PERMISSION MATRIX
   mis_tabs  : MIS tabs this role can see ('audit' = admin/md only)
   Tab keys  : null = hidden entirely | 'view' = read-only | 'edit' = full
               'own' = restricted to own dept rows (read+edit)
   kpi.depts : 'all' OR array of nav-btn data-dept values
   kpi.fill  : can open "Fill Monthly Data" form
   kpi.daily : can submit daily reports
══════════════════════════════════════════════════════════════════════ */
const PERMISSIONS = {

  md: {
    mis_tabs: ['hr','assets','compliance','store','audit'],
    hr:         { strength:'edit', roster:'view',  contractors:'view', csr:'view' },
    assets:     { it:'view',       vehicles:'view', spares:'view',      capex:'edit', land:'edit' },
    compliance: { certs:'view',    mlpl:'view',     legal:'view',       insurance:'view' },
    store:      { rawmat:'view',   spares:'view',   amc:'view' },
    kpi:        { depts:'all', fill:true,  daily:true  },
    canViewAudit:  true,
    canManageUsers:false,
    canExport:     true,
  },

  admin: {
    mis_tabs: ['hr','assets','compliance','store','audit'],
    hr:         { strength:'view', roster:'view',  contractors:'view', csr:'view' },
    assets:     { it:'edit',       vehicles:'view', spares:'view',      capex:'view', land:'view' },
    compliance: { certs:'view',    mlpl:'view',     legal:'view',       insurance:'view' },
    store:      { rawmat:'view',   spares:'view',   amc:'view' },
    kpi:        { depts:'all', fill:false, daily:false },
    canViewAudit:  true,
    canManageUsers:true,
    canExport:     true,
  },

  management: {
    mis_tabs: ['hr','assets','compliance','store'],
    hr:         { strength:'view', roster:'view',  contractors:'view', csr:'view' },
    assets:     { it:'view',       vehicles:'view', spares:'view',      capex:'view', land:'view' },
    compliance: { certs:'view',    mlpl:'view',     legal:'view',       insurance:'view' },
    store:      { rawmat:'view',   spares:'view',   amc:'view' },
    kpi:        { depts:'all', fill:false, daily:false },
    canViewAudit:  false,
    canManageUsers:false,
    canExport:     true,
  },

  hr: {
    mis_tabs: ['hr','compliance'],
    hr:         { strength:'edit', roster:'edit',  contractors:'edit', csr:'edit' },
    assets:     null,
    compliance: { certs:'edit',    mlpl:null,       legal:'edit',       insurance:'edit' },
    store:      null,
    kpi:        { depts:['summary','overtime'], fill:true, daily:true },
    canViewAudit:  false,
    canManageUsers:false,
    canExport:     true,
  },

  finance: {
    mis_tabs: ['hr','assets','compliance','store'],
    hr:         { strength:'view', roster:'view',  contractors:'view', csr:'view' },
    assets:     { it:'view',       vehicles:'view', spares:'view',      capex:'edit', land:'view' },
    compliance: { certs:'view',    mlpl:'view',     legal:'view',       insurance:'edit' },
    store:      { rawmat:'view',   spares:'view',   amc:'view' },
    kpi:        { depts:'all', fill:false, daily:false },
    canViewAudit:  false,
    canManageUsers:false,
    canExport:     true,
  },

  stores: {
    mis_tabs: ['store'],
    hr:         null,
    assets:     null,
    compliance: null,
    store:      { rawmat:'edit',   spares:'edit',   amc:'edit' },
    kpi:        { depts:['summary','stores'], fill:true, daily:true },
    canViewAudit:  false,
    canManageUsers:false,
    canExport:     true,
  },

  cpp: {
    mis_tabs: ['assets','compliance','store'],
    hr:         null,
    assets:     { it:'own',        vehicles:'own',  spares:'own',       capex:'own',  land:null },
    compliance: { certs:'own',     mlpl:null,        legal:null,         insurance:'own' },
    store:      { rawmat:null,     spares:'own',    amc:'own' },
    kpi:        { depts:['summary','powerplant','overtime'], fill:true, daily:true },
    canViewAudit:  false,
    canManageUsers:false,
    canExport:     false,
  },

  pm: {
    mis_tabs: ['assets','compliance','store'],
    hr:         null,
    assets:     { it:'own',        vehicles:'own',  spares:'own',       capex:'own',  land:null },
    compliance: { certs:'own',     mlpl:null,        legal:null,         insurance:'own' },
    store:      { rawmat:null,     spares:'own',    amc:'own' },
    kpi:        { depts:['summary','ei','mechanical','overtime'], fill:true, daily:true },
    canViewAudit:  false,
    canManageUsers:false,
    canExport:     false,
  },

  it: {
    mis_tabs: ['assets','audit'],
    hr:         null,
    assets:     { it:'edit',       vehicles:null,   spares:null,        capex:'own',  land:null },
    compliance: null,
    store:      null,
    kpi:        { depts:['summary'], fill:false, daily:false },
    canViewAudit:  true,
    canManageUsers:false,
    canExport:     false,
  },

  logistics: {
    mis_tabs: ['assets','compliance'],
    hr:         null,
    assets:     { it:'own',        vehicles:'edit', spares:null,        capex:null,   land:null },
    compliance: { certs:'own',     mlpl:null,        legal:'own',        insurance:'own' },
    store:      null,
    kpi:        { depts:['summary','packing','minesworkshop','overtime'], fill:true, daily:true },
    canViewAudit:  false,
    canManageUsers:false,
    canExport:     false,
  },

  mining: {
    mis_tabs: ['compliance','store'],
    hr:         null,
    assets:     { it:'own',        vehicles:'own',  spares:'own',       capex:'own',  land:'view' },
    compliance: { certs:'own',     mlpl:'edit',     legal:'own',        insurance:'own' },
    store:      { rawmat:'edit',   spares:'own',    amc:null },
    kpi:        { depts:['summary','mines','overtime'], fill:true, daily:true },
    canViewAudit:  false,
    canManageUsers:false,
    canExport:     false,
  },

  production: {
    mis_tabs: ['store'],
    hr:         null,
    assets:     null,
    compliance: null,
    store:      { rawmat:'edit',   spares:'own',    amc:null },
    kpi:        { depts:['summary','production','packing','overtime'], fill:true, daily:true },
    canViewAudit:  false,
    canManageUsers:false,
    canExport:     false,
  },
};

/* ══════════════════════════════════════════════════════════════════════
   SESSION MANAGEMENT
══════════════════════════════════════════════════════════════════════ */
function login(username, password) {
  const u = MIS_USERS.find(u =>
    u.username === username.trim().toLowerCase() &&
    u.password === password &&
    u.active
  );
  if (!u) return false;
  const session = {
    userId:    u.id,
    username:  u.username,
    name:      u.name,
    role:      u.role,
    dept:      u.dept,
    loginTime: Date.now(),
  };
  sessionStorage.setItem(_SESSION_KEY, JSON.stringify(session));
  _writeAudit('LOGIN', '—', '—', '—', '—', u.name + ' logged in from ' + (window.location.pathname.split('/').pop() || 'browser'));
  return true;
}

function logout() {
  const user = getCurrentUser();
  if (user) _writeAudit('LOGOUT', '—', '—', '—', '—', user.name + ' logged out');
  sessionStorage.removeItem(_SESSION_KEY);
  window.location.href = 'login.html';
}

function getCurrentUser() {
  try {
    const s = sessionStorage.getItem(_SESSION_KEY);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

function requireAuth() {
  if (!getCurrentUser()) {
    const page = window.location.pathname.split('/').pop() || 'index.html';
    window.location.href = 'login.html?return=' + encodeURIComponent(page);
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
function canFillKPI()      { return _getPerms().kpi?.fill       === true; }
function canSubmitDaily()  { return _getPerms().kpi?.daily      === true; }

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
      color: white;
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
      font-size: 11.5px; font-weight: 700;
      color: #fff;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      max-width: 130px;
    }
    .auth-user-dept {
      font-size: 9px; font-weight: 600;
      color: rgba(255,255,255,.5);
      text-transform: uppercase; letter-spacing: .5px;
    }
    .auth-logout-btn {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 5px 11px;
      border-radius: 6px;
      background: rgba(255,255,255,.1);
      border: 1px solid rgba(255,255,255,.2);
      color: rgba(255,255,255,.85);
      font-family: inherit; font-size: 10.5px; font-weight: 700;
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
      border-radius:8px; font-size:12px; font-weight:700;
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
      font-family:inherit; font-size:11px; padding:5px 9px;
      border:1.5px solid var(--border,#E2E8F0); border-radius:6px; outline:none;
    }
    .audit-filter-bar input:focus, .audit-filter-bar select:focus {
      border-color:var(--orange,#F49545);
    }
    .audit-action-badge {
      display:inline-block; padding:2px 8px; border-radius:4px;
      font-size:10px; font-weight:700;
    }
    .audit-empty {
      text-align:center; padding:40px; color:var(--text-muted,#64748B); font-size:12px;
    }

    /* ── Audit role badge ── */
    .audit-role-badge {
      display:inline-block; padding:1px 7px; border-radius:4px;
      font-size:9.5px; font-weight:700; text-transform:uppercase; letter-spacing:.4px;
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
      font-size:10.5px; white-space:nowrap; border-collapse:collapse;
    }
    .arm-table th, .arm-table td {
      padding:5px 8px; border:1px solid var(--border,#E2E8F0);
    }
    .arm-role-hdr {
      background:#F1F5F9; font-size:11px; font-weight:800;
      color:var(--navy,#173158); text-align:left;
      position:sticky; left:0; z-index:2;
    }
    .arm-group-hdr {
      background:var(--navy,#173158); color:white;
      font-size:10px; font-weight:800; text-align:center;
      letter-spacing:.5px; text-transform:uppercase;
    }
    .arm-special-grp { background:#4B5563; }
    .arm-col-hdr {
      background:#F8FAFC; font-size:9.5px; font-weight:700;
      color:#475569; text-align:center; text-transform:uppercase;
    }
    .arm-special-col, .arm-kpi-col {
      background:#F0FDF4;
    }
    .arm-role-cell {
      background:#F8FAFC; font-size:11px;
      position:sticky; left:0; z-index:1;
      white-space:nowrap;
    }
    .arm-role-cell strong { display:block; color:var(--navy,#173158); }
    .arm-role-slug {
      font-size:9px; font-weight:600; color:#94A3B8;
      text-transform:uppercase; letter-spacing:.4px;
    }
    .arm-cell { text-align:center; padding:4px 6px; }
    .arm-badge {
      display:inline-block; padding:2px 7px; border-radius:4px;
      font-size:9px; font-weight:800; letter-spacing:.3px;
    }
    .arm-edit  { background:#DCFCE7; color:#166534; border:1px solid #86EFAC; }
    .arm-view  { background:#DBEAFE; color:#1E40AF; border:1px solid #93C5FD; }
    .arm-own   { background:#FEF3C7; color:#92400E; border:1px solid #FCD34D; }
    .arm-none  { background:#F1F5F9; color:#94A3B8; border:1px solid #E2E8F0; }
    .arm-tick  { color:#16A34A; font-weight:800; font-size:12px; }
    .arm-kpi-depts {
      font-size:9px; font-weight:700; color:#0369A1;
      border-bottom:1px dashed #93C5FD; cursor:default;
    }
    .arm-legend {
      display:flex; flex-wrap:wrap; gap:12px; align-items:center;
      padding:10px 16px; font-size:10.5px; color:#475569;
      background:#F8FAFC; border-bottom:1px solid var(--border,#E2E8F0);
    }
  `;
  const tag = document.createElement('style');
  tag.textContent = css;
  document.head.appendChild(tag);
})();

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
        <div class="auth-user-dept">${user.dept}</div>
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

  if (depts !== 'all' && Array.isArray(depts)) {
    document.querySelectorAll('[data-dept]').forEach(btn => {
      const dept = btn.dataset.dept;
      if (!depts.includes(dept)) btn.style.display = 'none';
    });
  }

  const fillBtn = document.querySelector('.fill-monthly-btn');
  if (fillBtn && !p.kpi?.fill) fillBtn.style.display = 'none';

  renderUserHeader();
}

/* ══════════════════════════════════════════════════════════════════════
   DAILY REPORT — ACCESS MATRIX
   Maps each role to:
     edit  : pages this role can fill in (edit inputs + submit)
     nav   : nav links this role may see ('all' or array of filenames)
   'all' means every nav link is visible for that role (view-only access).
══════════════════════════════════════════════════════════════════════ */
const _DAILY_ACCESS = {
  md:         { edit: [],                                                               nav: 'all' },
  admin:      { edit: [],                                                               nav: 'all' },
  management: { edit: [],                                                               nav: 'all' },
  finance:    { edit: [],                                                               nav: 'all' },
  hr:         { edit: ['overtime-form.html'],
                nav:  ['overtime-form.html'] },
  stores:     { edit: ['materials-form.html'],
                nav:  ['daily-report.html','materials-form.html'] },
  cpp:        { edit: ['power-plant-report.html','cpp-form.html','power-form.html'],
                nav:  ['daily-report.html','power-plant-report.html','cpp-form.html','power-form.html'] },
  pm:         { edit: ['stoppage-form.html'],
                nav:  ['daily-report.html','stoppage-form.html'] },
  it:         { edit: [],
                nav:  ['daily-report.html'] },
  logistics:  { edit: ['dispatch-form.html'],
                nav:  ['daily-report.html','dispatch-form.html'] },
  mining:     { edit: ['mines-report.html','limestone-form.html'],
                nav:  ['daily-report.html','mines-report.html','limestone-form.html'] },
  production: { edit: ['daily-report.html','quality-form.html','pile-quality-form.html'],
                nav:  'all' },
};

/* ══════════════════════════════════════════════════════════════════════
   APPLY PERMISSIONS — DAILY REPORT PAGE & ALL SUB-FORMS
   Call this on every daily-report page (daily-report.html,
   power-plant-report.html, mines-report.html, forms/*.html, etc.)
══════════════════════════════════════════════════════════════════════ */
function applyDailyPermissions() {
  const user = getCurrentUser();
  if (!user) return;

  const role       = user.role;
  const access     = _DAILY_ACCESS[role] || { edit: [], nav: [] };
  const currentPage = window.location.pathname.split('/').pop() || 'daily-report.html';
  const canEditPage = access.edit.includes(currentPage);

  /* ── 1. Filter nav links ─────────────────────────────────────────── */
  if (access.nav !== 'all') {
    document.querySelectorAll('.nav-btn[onclick]').forEach(btn => {
      const match = (btn.getAttribute('onclick') || '').match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
      if (!match) return;   /* active page button or print button — no href, keep visible */
      const linkedPage = match[1].split('/').pop();
      if (!access.nav.includes(linkedPage)) {
        btn.style.display = 'none';
      }
    });
  }

  /* ── 2. View-Only mode when role cannot edit this page ──────────── */
  if (!canEditPage) {
    /* Disable every editable input/textarea/select */
    document.querySelectorAll('input, textarea, select').forEach(el => {
      el.disabled = true;
      el.style.cursor = 'not-allowed';
    });

    /* Hide all action buttons (Save Draft, Submit, etc.) */
    document.querySelectorAll(
      '.btn-save, .btn-sub, .btn-out, button[type=submit], .fill-monthly-btn'
    ).forEach(el => el.style.display = 'none');

    /* Add a sticky "View Only" banner below the header */
    if (!document.getElementById('dr-view-only-banner')) {
      const banner = document.createElement('div');
      banner.id = 'dr-view-only-banner';
      banner.style.cssText = [
        'background:#1E3A5F','color:white','padding:9px 24px',
        'font-size:11.5px','font-weight:700','letter-spacing:.3px',
        'display:flex','align-items:center','justify-content:center','gap:10px',
        'position:sticky','top:0','z-index:200','box-shadow:0 2px 8px rgba(0,0,0,.25)',
      ].join(';');
      banner.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">' +
        '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' +
        'VIEW ONLY &mdash; ' + user.dept + ' does not have edit access to this report.' +
        '<span style="font-size:10px;font-weight:500;opacity:.75;margin-left:8px">' +
        'Contact the responsible department to update data.</span>';

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
