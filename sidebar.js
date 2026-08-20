/* ═══════════════════════════════════════════════════════════════════
   Lake Cement Ltd — Global Left Sidebar  |  sidebar.js
   Single persistent navigation shell for every page. Role-aware —
   derives visibility from auth.js's permission accessors (getMyPerms/
   getAllowedKPIDepts/getMyDailyAccess/getMyFormAccess/getDailyNavItems/
   getDailyAccessFor/getFormTypeAccessFor/getStandaloneFormType) rather
   than reaching into its internal data constants directly — no
   hardcoded roles here either.
   Call renderSidebar() inline right after <aside id="app-sidebar">,
   same timing convention as renderTopHeader().
═══════════════════════════════════════════════════════════════════ */
'use strict';

const _SB_GROUPS = {
  kpi:        { label: 'KPI &amp; Analytics',   cls: 'group-kpi'  },
  daily:      { label: 'Daily Reports',     cls: 'group-daily' },
  mis:        { label: 'Management Info.',  cls: 'group-mis'   },
  commercial: { label: 'Sales &amp; Purchases', cls: 'group-comm'  },
  ops:        { label: 'Reports &amp; Tools',   cls: 'group-ops'   },
};

/* Same 9 departments/order as the KPI dashboard used to show in its
   horizontal .dept-nav bar (now retired — see index.html/app.js). */
const _SB_KPI_DEPTS = [
  { dept:'summary',        label:'Executive Summary', icon:'layout-dashboard' },
  { dept:'ei',              label:'E &amp; I',              icon:'zap' },
  { dept:'production',      label:'Production',        icon:'factory' },
  { dept:'mines',            label:'Quarry',            icon:'layers' },
  { dept:'mechanical',      label:'Mechanical',        icon:'wrench' },
  { dept:'powerplant',      label:'Power Plant',       icon:'cog' },
  { dept:'packing',          label:'Packing Plant',     icon:'package' },
  { dept:'stores',            label:'Stores',            icon:'warehouse' },
  { dept:'minesworkshop',    label:'Mines Workshop',    icon:'truck' },
];

/* Standalone KPI/analysis pages — previously reachable only from
   portal.html's card grid, with no nav grouping anywhere else. */
const _SB_KPI_LINKS = [
  { label:'Trends &amp; Analytics',       icon:'trending-up',    page:'analytics.html' },
  { label:'Entry Completeness',       icon:'check-circle',   page:'completeness.html' },
  { label:'Material &amp; Power Balance', icon:'scale',           page:'balance.html' },
  { label:'Operational Insights',     icon:'lightbulb',      page:'insights.html' },
  { label:'Equipment Reliability',    icon:'alert-triangle', page:'reliability.html' },
];

/* Sales is real (see PERMISSIONS[role].commercial.sales in auth.js);
   Purchases has no permission model yet either, so it rides on the same
   canViewSales() gate as the rest of this group — split it out once
   Purchases gets its own check. Page itself is real (purchases.html,
   2026-08-10) — the category breakdown grid on it is honestly stubbed
   pending Odoo field-name confirmation, same as Sales' Receivables tiles. */
const _SB_COMMERCIAL_ITEMS = [
  { label:'Sales',     icon:'trending-up',   page:'sales.html' },
  { label:'Purchases', icon:'shopping-cart', page:'purchases.html' },
];

/* Open to every authenticated role (each page calls requireAuth() only)
   except System Monitor, which is admin/md/it-only — reuses
   perms.canViewAudit rather than a new flag since that's already exactly
   the same ['admin','md','it'] set monitor.html's own client-side guard
   checks. Previously these 3 pages existed and worked but were reachable
   only by typing the URL — not linked from any nav. */
const _SB_OPS_ITEMS = [
  { label:'Plant Memory Search',    icon:'search',   page:'memory.html' },
  { label:'MIS Reports &amp; Exports', icon:'file-down', page:'reports-export.html' },
  { label:'System Monitor',         icon:'activity', page:'monitor.html', auditOnly: true },
];

function _sbBase() {
  return window.location.pathname.includes('/forms/') ? '../' : '';
}
function _sbCurrentPage() {
  return window.location.pathname.split('/').pop() || 'index.html';
}

/* Daily Reports group, built at render time from the existing catalogue
   instead of a second hardcoded list — mirrors buildDailyNav()'s
   fill/view derivation (auth.js), just targeting sidebar rows. */
function _sbBuildDailyGroup() {
  const user = getCurrentUser();
  if (!user) return [];
  const access    = getDailyAccessFor(user.role);
  const formTypes = getFormTypeAccessFor(user.role);
  const items     = getDailyNavItems() || [];

  const visible = access.nav === 'all'
    ? items
    : items.filter(it => access.nav.includes(it.page));

  const canFill = it => access.edit.includes(it.page) ||
                        formTypes.includes(getStandaloneFormType(it.page));

  return visible.map(it => ({ ...it, fill: canFill(it) }));
}

function _sbGroupLabelHTML(groupKey) {
  const g = _SB_GROUPS[groupKey];
  return `<div class="sb-group-label ${g.cls}"><span class="sb-group-dot"></span>${g.label}</div>`;
}

/* opts: {icon, label, active, href, onclick, dept, badgeHTML, stub} */
function _sbItemHTML(opts) {
  const cls = ['sb-item'];
  if (opts.active) cls.push('active');
  if (opts.stub)   cls.push('stub');
  const tag       = opts.stub ? 'span' : 'a';
  const hrefAttr  = (!opts.stub && opts.href) ? ` href="${opts.href}"` : '';
  const clickAttr = opts.onclick ? ` onclick="${opts.onclick}"` : '';
  const deptAttr  = opts.dept ? ` data-dept="${opts.dept}"` : '';
  return `<${tag} class="${cls.join(' ')}"${hrefAttr}${clickAttr}${deptAttr}>` +
         `<span class="sb-item-icon"><i data-lucide="${opts.icon}"></i></span>` +
         `<span class="sb-item-label">${opts.label}</span>` +
         `${opts.badgeHTML || ''}` +
         `</${tag}>`;
}

function renderSidebar() {
  const mount = document.getElementById('app-sidebar');
  if (!mount) return;
  const user = getCurrentUser();
  if (!user) return;

  /* Apply persisted collapse state before first paint — unlike an SPA,
     every nav click here is a full page load, so this must survive
     reload (see toggleSidebar() below). */
  const shell = document.querySelector('.app-shell');
  if (shell && localStorage.getItem('lcl_sidebar_collapsed') === '1') {
    shell.classList.add('sidebar-collapsed');
  }

  const base        = _sbBase();
  const currentPage = _sbCurrentPage();
  const onIndex      = currentPage === 'index.html';

  const perms        = getMyPerms();
  const allowedDepts = getAllowedKPIDepts();
  const hasKPI = allowedDepts === 'all' || (Array.isArray(allowedDepts) && allowedDepts.length > 0);
  const isDeptVisible = d => allowedDepts === 'all' || (Array.isArray(allowedDepts) && allowedDepts.includes(d));
  const hasMIS = Array.isArray(perms.mis_tabs) && perms.mis_tabs.length > 0;

  /* Same fallback rule index.html's own bootstrap uses for an incoming
     ?dept= — kept in sync so the sidebar's initial active row already
     matches what switchDept() will land on, no flash-then-correct. */
  const initialDept = onIndex
    ? (() => {
        const requested = new URLSearchParams(location.search).get('dept');
        return (requested && isDeptVisible(requested)) ? requested : 'summary';
      })()
    : null;

  let html = `
    <div class="sb-top">
      <span class="sb-top-label">Menu</span>
      <button type="button" class="sb-toggle" id="sidebarToggle" onclick="toggleSidebar()" title="Collapse / expand menu">
        <i data-lucide="menu"></i>
      </button>
    </div>
    <nav class="sb-nav">`;

  /* ── KPI & Analytics ─────────────────────────────────────────── */
  const deptRows = _SB_KPI_DEPTS.filter(d => isDeptVisible(d.dept));
  if (deptRows.length || hasKPI) {
    html += _sbGroupLabelHTML('kpi');
    deptRows.forEach(d => {
      if (onIndex) {
        html += _sbItemHTML({
          icon: d.icon, label: d.label, dept: d.dept,
          active: d.dept === initialDept,
          onclick: `switchDept('${d.dept}');return false;`,
        });
      } else {
        html += _sbItemHTML({
          icon: d.icon, label: d.label, dept: d.dept,
          href: `${base}index.html?dept=${d.dept}`,
        });
      }
    });
    if (hasKPI) {
      _SB_KPI_LINKS.forEach(l => {
        html += _sbItemHTML({
          icon: l.icon, label: l.label,
          active: currentPage === l.page,
          href: base + l.page,
        });
      });
    }
  }

  /* ── Daily Reports (FILL/VIEW badge replaces the old two-zone bar) ── */
  const dailyItems = _sbBuildDailyGroup();
  if (dailyItems.length) {
    html += _sbGroupLabelHTML('daily');
    dailyItems.forEach(it => {
      const href  = base ? it.hForm : it.hRoot;
      const badge = `<span class="${it.fill ? 'sb-badge-fill' : 'sb-badge-view'}">${it.fill ? 'FILL' : 'VIEW'}</span>`;
      html += _sbItemHTML({
        icon: it.icon, label: it.label, href, badgeHTML: badge,
        active: it.page === currentPage,
      });
    });
  }

  /* ── MIS ──────────────────────────────────────────────────────── */
  if (hasMIS) {
    html += _sbGroupLabelHTML('mis');
    html += _sbItemHTML({
      icon: 'clipboard-list', label: 'MIS Dashboard',
      active: currentPage === 'mis.html', href: base + 'mis.html',
    });
  }

  /* ── Sales & Purchases ────────────────────────────────────────── */
  if (canViewSales()) {
    html += _sbGroupLabelHTML('commercial');
    _SB_COMMERCIAL_ITEMS.forEach(it => {
      if (it.stub) {
        html += _sbItemHTML({
          icon: it.icon, label: it.label, stub: true,
          badgeHTML: '<span class="sb-stub-tag">SOON</span>',
          onclick: `location.href='${base}${it.page}'`,
        });
      } else {
        html += _sbItemHTML({
          icon: it.icon, label: it.label,
          active: currentPage === it.page,
          href: base + it.page,
        });
      }
    });
  }

  /* ── Reports & Tools (memory search, MIS export, ops monitor) ──── */
  const opsItems = _SB_OPS_ITEMS.filter(it => !it.auditOnly || perms.canViewAudit);
  if (opsItems.length) {
    html += _sbGroupLabelHTML('ops');
    opsItems.forEach(it => {
      html += _sbItemHTML({
        icon: it.icon, label: it.label,
        active: currentPage === it.page,
        href: base + it.page,
      });
    });
  }

  html += `</nav>
    <div class="sidebar-bottom">
      ${_sbItemHTML({ icon: 'log-out', label: 'Logout', onclick: 'logout()' })}
    </div>`;

  mount.innerHTML = html;
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

function toggleSidebar() {
  const shell = document.querySelector('.app-shell');
  if (!shell) return;
  const collapsed = shell.classList.toggle('sidebar-collapsed');
  localStorage.setItem('lcl_sidebar_collapsed', collapsed ? '1' : '0');
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}
