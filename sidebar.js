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

/* Group order below is Daily Reports → KPI → Analytics → (utility groups),
   per the 2026-09-15 nav redesign — see project memory. The old standalone
   "Approvals" and "Sales & Purchases" groups are gone: Approvals now opens
   as a tab inside Daily Reports (paired with Entry Summary), and Sales /
   Purchases relocated into the KPI list (see _SB_KPI_ORDER below). */
const _SB_GROUPS = {
  daily:      { label: 'Daily Reports',     cls: 'group-daily' },
  kpi:        { label: 'KPI',               cls: 'group-kpi'  },
  analytics:  { label: 'Analytics',         cls: 'group-analytics' },
  mis:        { label: 'Management Info.',  cls: 'group-mis'   },
  ops:        { label: 'Reports &amp; Tools',   cls: 'group-ops'   },
  admin:      { label: 'Administration',    cls: 'group-ops'   },
};

/* One ordered list mixing the KPI department rows (switchDept() on
   index.html) with two standalone pages that used to live in their own
   "Sales & Purchases" group — Purchases and Sales — so the sidebar reads
   in the plant's manufacturing-flow order instead of "all depts, then all
   links". `type:'link'` rows carry their own `visible` check, same pattern
   the old _SB_COMMERCIAL_ITEMS used.

   "Raw Materials & Purchases" is provisional: it's meant to eventually
   blend the Purchases report with Raw Materials daily-report data into one
   view, but that merge isn't built — this links straight to the existing
   Purchases report for now (2026-09-15 nav redesign; see project memory
   for the deferred merge). Likewise "Sales & Dispatch" here is just the
   existing Sales dashboard relocated, not a new combined report. */
const _SB_KPI_ORDER = [
  { type:'dept', dept:'summary',        label:'Executive Summary', icon:'layout-dashboard' },
  { type:'link', label:'Raw Materials &amp; Purchases', icon:'shopping-cart', page:'purchases.html', visible: canViewPurchases },
  { type:'dept', dept:'mines',          label:'Quarrying',        icon:'layers' },
  { type:'dept', dept:'minesworkshop',  label:'Quarry Workshop',  icon:'truck' },
  { type:'dept', dept:'production',     label:'Production',       icon:'factory' },
  { type:'dept', dept:'packing',        label:'Packing',          icon:'package' },
  { type:'dept', dept:'mechanical',     label:'Mechanical',       icon:'wrench' },
  { type:'dept', dept:'ei',             label:'E &amp; I',             icon:'zap' },
  { type:'link', label:'Sales &amp; Dispatch', icon:'trending-up', page:'sales.html', visible: canViewSales },
  { type:'dept', dept:'stores',         label:'Stores',           icon:'warehouse' },
  { type:'dept', dept:'powerplant',     label:'Power Plant',      icon:'cog' },
];

/* Analytics — read-only dashboards, no permission of their own beyond
   general KPI access (same `hasKPI` gate the old _SB_KPI_LINKS used).
   "Reliability & Stoppage" is one row (index 0 below is the primary,
   linked destination); index 1 (Stoppage Insights) is reached from an
   in-page switcher on that page instead of its own row — see
   report-switcher.js and the render code below. */
const _SB_ANALYTICS_ITEMS = [
  { label:'Operational Summary', icon:'trending-up', page:'analytics.html' },
  { label:'Power &amp; Heat',        icon:'scale',       page:'balance.html' },
];
const _SB_RELIABILITY_PAIR = [
  { label:'Equipment Reliability', icon:'alert-triangle', page:'reliability.html' },
  { label:'Stoppage Insights',     icon:'lightbulb',      page:'insights.html' },
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

/* Lays out 2 _sbItemHTML rows side by side in one compact strip — used
   for Approvals + Entry Summary at the top of Daily Reports. (Quality,
   Sales & Dispatch and Reliability & Stoppage used to share this same
   pairing before 2026-09-16 — each is now a single row instead, with the
   second report reached from an in-page switcher; see report-switcher.js.) */
function _sbPairHTML(itemOptsList) {
  return `<div class="sb-pair">${itemOptsList.map(_sbItemHTML).join('')}</div>`;
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
  /* Daily Reports rows carry the form page they lead to, so forms/nav-status.js
     can hang today's fill-status dot on the right row. */
  const pageAttr  = opts.page ? ` data-page="${opts.page}"` : '';
  return `<${tag} class="${cls.join(' ')}"${hrefAttr}${clickAttr}${deptAttr}${pageAttr}>` +
         `<span class="sb-item-icon"><i data-lucide="${opts.icon}"></i></span>` +
         `<span class="sb-item-label">${opts.label}</span>` +
         `${opts.badgeHTML || ''}` +
         `</${tag}>`;
}

function renderSidebar() {
  const mount = document.getElementById('app-sidebar');
  if (!mount) return;

  /* Embed mode: this page is showing inside another page's in-page report
     switcher (report-switcher.js) via <iframe src="...?embed=1"> — e.g.
     limestone-form.html inside quality-form.html's "Limestone %" tab. The
     embedded page keeps its own full app-shell/header/sidebar markup so it
     still works completely normally at its own URL; embed mode just hides
     that chrome here so it isn't nested inside the HOST page's chrome too
     (see styles.css's html[data-embed="1"] rules for the header/.main
     side of this — sidebar.js only owns the aside itself). */
  if (new URLSearchParams(location.search).get('embed') === '1') {
    document.documentElement.setAttribute('data-embed', '1');
    return;
  }

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
  /* Management-only as of 2026-09-03 — canViewMIS() is the policy, and
     mis_tabs then decides which tabs a permitted role sees. Reading the
     role list rather than mis_tabs.length means a role that keeps a tab
     entry for some other reason can't quietly re-earn the whole group. */
  const hasMIS = canViewMIS();
  /* Sales/Purchase-only user: no plant department of their own. Reorders and
     trims the nav below so their own dashboard leads — see auth.js. */
  const commercialOnly = isCommercialOnly();

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

  /* ── Daily Reports ────────────────────────────────────────────────
     Approvals + Entry Summary sit in one line as two separate tabs at the
     top of the group (2026-09-15 nav redesign). Entry Summary is
     completeness.html, relocated here from the old KPI-links list — same
     `hasKPI` gate it always had, just a new home. Approvals is visible to
     an HOD with something to approve, or admin/md who can approve any
     department's reports. A department with no submittable form
     (getMyFormAccess().length === 0, e.g. hr/it/finance/purchase today)
     correctly gets no link — nothing to approve yet — and this
     self-extends the day such a form is added. */
  const canSeeApprovals = user.role === 'admin' || user.role === 'md' ||
    (user.level === 'hod' && getMyFormAccess().length > 0);
  /* Entry Summary (completeness.html) is a plant-wide daily-fill grid. A
     commercial-only role fills none of those reports, so the row is dropped
     for them (2026-10-02) — see isCommercialOnly() in auth.js. */
  const showEntrySummary = hasKPI && !commercialOnly;
  const dailyItems = _sbBuildDailyGroup();
  /* The Purchase dashboard sits at the foot of this group as the Purchase &
     Stores button (2026-09-22, asked for directly). It is NOT an entry in
     _DAILY_NAV_ITEMS, for two reasons. First, that catalogue is filtered by
     _DAILY_ACCESS[role].nav, and the five roles carrying nav:'all' include
     admin, finance and production — none of whom are in PURCHASE_VIEW_ROLES,
     so they would each get a row the backend then 403s. Its own
     canViewPurchases() gate is the same one routes/purchases.js enforces, so
     the row appears for exactly the roles that can open the page. Second,
     _DAILY_NAV_ITEMS rows carry a `page` key that forms/nav-status.js hangs
     today's filled/not-filled dot on; a dashboard has no daily fill state,
     so this row deliberately passes no `page` and gets no dot. */
  const showPurchases = canViewPurchases();

  if (dailyItems.length || canSeeApprovals || showEntrySummary || showPurchases) {
    html += _sbGroupLabelHTML('daily');

    if (canSeeApprovals || showEntrySummary) {
      const topPair = [];
      if (canSeeApprovals) {
        topPair.push({
          icon: 'check-square', label: 'Approvals',
          active: currentPage === 'approvals.html', href: base + 'approvals.html',
        });
      }
      if (showEntrySummary) {
        topPair.push({
          icon: 'check-circle', label: 'Entry Summary',
          active: currentPage === 'completeness.html', href: base + 'completeness.html',
        });
      }
      html += _sbPairHTML(topPair);
    }

    /* Manufacturing-flow order comes from _DAILY_NAV_ITEMS itself (see
       auth.js). Adjacent rows sharing the same `club` (Quality/Lab +
       Limestone %; Dispatch & SO + Sales Projection) collapse into ONE row
       — labelled with the club name, pointing at the first (primary)
       report — instead of two full-width rows. The second report is
       reached from an in-page switcher ON the primary page (see
       report-switcher.js), not from its own sidebar row.
       If a role's access filters one half out, the survivor just falls
       through to the normal single-row branch below under its own label —
       e.g. the `sales` role, who can reach Sales Projection but not
       Dispatch & SO, sees a plain "Sales Projection" row, not "Sales &
       Dispatch" with a switcher it can't use the second tab of. */
    for (let i = 0; i < dailyItems.length; i++) {
      const it = dailyItems[i];
      const next = dailyItems[i + 1];
      const rowOpts = x => {
        const href     = base ? x.hForm : x.hRoot;
        const hrefPage = String(href).split('/').pop();
        const badge    = `<span class="${x.fill ? 'sb-badge-fill' : 'sb-badge-view'}">${x.fill ? 'FILL' : 'VIEW'}</span>`;
        return {
          icon: x.icon, label: x.label, href, badgeHTML: badge, page: x.page,
          active: x.page === currentPage || hrefPage === currentPage,
        };
      };

      if (it.club && next && next.club === it.club) {
        const opts = rowOpts(it);
        opts.label = it.club;
        html += _sbItemHTML(opts);
        i++; // the partner is reached via the primary page's switcher, not its own row
      } else {
        html += _sbItemHTML(rowOpts(it));
      }
    }

    /* VIEW badge like every other row here — the dashboard is read-only, and
       an unbadged row in a badged list reads as an oversight. Labelled just
       "Purchases" to be findable: the KPI group's row for the same page is
       called "Raw Materials & Purchases" after a merge that was never built,
       which is why it was not recognisable as the Purchase dashboard. */
    if (showPurchases) {
      html += _sbItemHTML({
        icon: 'shopping-cart', label: 'Purchases',
        href: base + 'purchases.html',
        active: currentPage === 'purchases.html',
        badgeHTML: '<span class="sb-badge-view">VIEW</span>',
      });
    }
  }

  /* ── KPI ──────────────────────────────────────────────────────────
     One ordered list mixing department rows with the two relocated
     standalone pages (Purchases, Sales) — see _SB_KPI_ORDER above for why
     "Raw Materials & Purchases" and "Sales & Dispatch" are provisional
     links rather than new combined reports. */
  let kpiRows = _SB_KPI_ORDER.filter(entry =>
    entry.type === 'dept' ? isDeptVisible(entry.dept) : entry.visible()
  );
  /* _SB_KPI_ORDER is in manufacturing-flow order, which puts Sales & Dispatch
     ninth — correct for a plant user reading the flow, wrong for a Sales user
     whose own dashboard it is. For a commercial-only role the commercial rows
     are hoisted to the top of the group, in place, so Sales & Dispatch is the
     first thing they can click (2026-10-02, asked for directly). Flow order is
     untouched for every other role. */
  if (commercialOnly) {
    kpiRows = [
      ...kpiRows.filter(e => e.type === 'link'),
      ...kpiRows.filter(e => e.type !== 'link'),
    ];
  }
  if (kpiRows.length) {
    html += _sbGroupLabelHTML('kpi');
    kpiRows.forEach(entry => {
      if (entry.type === 'dept') {
        if (onIndex) {
          html += _sbItemHTML({
            icon: entry.icon, label: entry.label, dept: entry.dept,
            active: entry.dept === initialDept,
            onclick: `switchDept('${entry.dept}');return false;`,
          });
        } else {
          html += _sbItemHTML({
            icon: entry.icon, label: entry.label, dept: entry.dept,
            href: `${base}index.html?dept=${entry.dept}`,
          });
        }
      } else {
        html += _sbItemHTML({
          icon: entry.icon, label: entry.label,
          active: currentPage === entry.page,
          href: base + entry.page,
        });
      }
    });
  }

  /* ── Analytics ────────────────────────────────────────────────────
     Same `hasKPI` gate the old KPI-links list used. Reliability & Stoppage
     is one row pointing at the primary page (reliability.html); Stoppage
     Insights (insights.html) is reached from an in-page switcher there
     (report-switcher.js), not its own row — see _SB_RELIABILITY_PAIR. */
  if (hasKPI && !commercialOnly) {
    html += _sbGroupLabelHTML('analytics');
    _SB_ANALYTICS_ITEMS.forEach(l => {
      html += _sbItemHTML({
        icon: l.icon, label: l.label,
        active: currentPage === l.page,
        href: base + l.page,
      });
    });
    html += _sbItemHTML({
      icon: _SB_RELIABILITY_PAIR[0].icon, label: 'Reliability &amp; Stoppage',
      active: currentPage === _SB_RELIABILITY_PAIR[0].page,
      href: base + _SB_RELIABILITY_PAIR[0].page,
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

  /* ── Administration ───────────────────────────────────────────────
     canManageUsers is admin-only today. Gated on the permission rather
     than on the role so widening it later is a one-line change in
     auth.js's PERMISSIONS, not an edit here as well. */
  /* canManageITAssets is 'it'+'admin' today (backend/config/itAssetsAccess.js
     mirrors the same two roles for write access) — its own flag rather than
     reusing canManageUsers so the IT department can reach its own register
     without also gaining User Administration. Placed in the same
     Administration group as User Administration since both are "manage a
     company-wide register", not a department's own daily data. */
  const showAdminGroup = perms.canManageUsers || perms.canManageITAssets;
  if (showAdminGroup) html += _sbGroupLabelHTML('admin');
  if (perms.canManageUsers) {
    html += _sbItemHTML({
      icon: 'users', label: 'User Administration',
      active: currentPage === 'admin-users.html', href: base + 'admin-users.html',
    });
  }
  if (perms.canManageITAssets) {
    html += _sbItemHTML({
      // 'monitor', not 'hard-drive' — the self-hosted lucide-icons.js subset
      // (docs/DESIGN_SYSTEM.md) is a generated, pinned 93-icon set and does
      // not include 'hard-drive'; 'monitor' is already in it and used
      // elsewhere for this exact IT-assets concept (mis.html's own tab).
      icon: 'monitor', label: 'IT Asset Register',
      active: currentPage === 'it-assets.html', href: base + 'it-assets.html',
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
