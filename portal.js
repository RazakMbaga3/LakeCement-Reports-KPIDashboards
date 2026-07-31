/* ═══════════════════════════════════════════════════════════════════
   Lake Cement Ltd — Portal Home  |  portal.js
   Role-aware module launcher. Derives card visibility from auth.js
   permission data — no hardcoding per role.
═══════════════════════════════════════════════════════════════════ */
'use strict';

/* ── Category metadata ────────────────────────────────────────── */
const _CATS = {
  kpi:     { label: 'KPI & Analytics',   accent: '#173158' },
  reports: { label: 'Daily Reports',     accent: '#239557' },
  forms:   { label: 'Daily Reports',     accent: '#F49545' },
  mis:     { label: 'Management Info.',  accent: '#173158' },
};

/* ── Master card catalogue ────────────────────────────────────── */
const _CARDS = [

  /* ── KPI & Analytics ───────────────────────────────── */
  { id:'kpi', cat:'kpi', badge:'VIEW',
    title:'KPI Dashboard',
    sub:'Monthly targets & actuals by department',
    url:'index.html',
    d:'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },

  { id:'trends', cat:'kpi', badge:'VIEW',
    title:'Trends & Analytics',
    sub:'Historical charts & performance analysis',
    url:'analytics.html',
    d:'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6' },

  { id:'completeness', cat:'kpi', badge:'VIEW',
    title:'Entry Completeness',
    sub:'Which forms were entered by cutoff, by day',
    url:'completeness.html',
    d:'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },

  { id:'balance', cat:'kpi', badge:'VIEW',
    title:'Material & Power Balance',
    sub:'Clinker stock, power and coal/heat reconciliation',
    url:'balance.html',
    d:'M4 6h16M4 12h10M4 18h16' },

  { id:'insights', cat:'kpi', badge:'VIEW',
    title:'Operational Insights',
    sub:'Output vs. downtime, energy vs. quality trade-off',
    url:'insights.html',
    d:'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2' },

  { id:'reliability', cat:'kpi', badge:'VIEW',
    title:'Equipment Reliability',
    sub:'Availability (NAI), MTBF, paired downtime Pareto & RCFA flags',
    url:'reliability.html',
    d:'M12 9v4m0 4h.01M4.93 19h14.14a1 1 0 00.86-1.5L12.86 4.5a1 1 0 00-1.72 0L4.07 17.5a1 1 0 00.86 1.5z' },

  /* ── Reports (view-only) ───────────────────────────── */
  { id:'rpt-daily', cat:'reports', badge:'VIEW',
    title:'Daily Production Report',
    sub:'View today\'s production data',
    url:'daily-report.html',
    d:'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },

  { id:'rpt-power', cat:'reports', badge:'VIEW',
    title:'Power Plant Report',
    sub:'View daily power generation data',
    url:'power-plant-report.html',
    d:'M13 10V3L4 14h7v7l9-11h-7z' },

  { id:'rpt-mines', cat:'reports', badge:'VIEW',
    title:'Mines Daily Report',
    sub:'View material movement summary',
    url:'mines-report.html',
    d:'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10' },

  { id:'rpt-power-cons', cat:'reports', badge:'VIEW', formType:'power-cons',
    title:'Power Consumption Report',
    sub:'View section-wise power consumption & SPC',
    url:'forms/power-form.html',
    d:'M13 10V3L4 14h7v7l9-11h-7z' },

  { id:'rpt-dispatch', cat:'reports', badge:'VIEW', formType:'dispatch',
    title:'Dispatch & SO Report',
    sub:'View dispatch, SO pendency & vehicle queue',
    url:'forms/dispatch-form.html',
    d:'M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v9a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l2.414 2.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 11-4 0' },

  { id:'rpt-materials', cat:'reports', badge:'VIEW', formType:'materials',
    title:'Raw Materials Report',
    sub:'View stock movement — coal by supplier, bags, grinding aid & diesel',
    url:'forms/materials-form.html',
    d:'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4' },

  { id:'rpt-stoppage', cat:'reports', badge:'VIEW', formType:'stoppage',
    title:'Stoppage Report',
    sub:'View section-wise equipment stoppage log',
    url:'forms/stoppage-form.html',
    d:'M12 9v4m0 4h.01M4.93 19h14.14a1 1 0 00.86-1.5L12.86 4.5a1 1 0 00-1.72 0L4.07 17.5a1 1 0 00.86 1.5z' },

  /* ── Daily Reports with inline fill access ─────────────── */
  { id:'frm-daily', cat:'forms', badge:'SUBMIT',
    title:'Production Report',
    sub:'Fill today\'s production & quality; view stoppages & dispatch',
    url:'daily-report.html',
    d:'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },

  { id:'frm-power-rpt', cat:'forms', badge:'SUBMIT',
    title:'Power Plant Report',
    sub:'Fill & view daily power generation data',
    url:'power-plant-report.html',
    d:'M13 10V3L4 14h7v7l9-11h-7z' },

  { id:'frm-mines-rpt', cat:'forms', badge:'SUBMIT',
    title:'Mines Report',
    sub:'Fill & view mines movement data',
    url:'mines-report.html',
    d:'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10' },

  { id:'frm-power-cons', cat:'forms', badge:'SUBMIT', formType:'power-cons',
    title:'Power Consumption Report',
    sub:'Fill section-wise power consumption & SPC data',
    url:'forms/power-form.html',
    d:'M13 10V3L4 14h7v7l9-11h-7z' },

  { id:'frm-dispatch', cat:'forms', badge:'SUBMIT', formType:'dispatch',
    title:'Dispatch & SO Report',
    sub:'Fill dispatch, SO pendency & vehicle queue data',
    url:'forms/dispatch-form.html',
    d:'M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v9a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l2.414 2.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 11-4 0' },

  /* ── Other standalone daily-entry forms — submit-only tiles.
     No enforced "view" whitelist exists for these in auth.js (any
     authenticated user can navigate straight to a forms/*.html page and
     see it read-only), so — unlike the hub-style pages above — these only
     appear here for roles that can actually submit them. ───────────── */
  { id:'frm-quality', cat:'forms', badge:'SUBMIT', formType:'quality',
    title:'Quality / Lab Report',
    sub:'Fill cement physical tests & chemistry data',
    url:'forms/quality-form.html',
    d:'M9 3v6l-5 9a1 1 0 00.9 1.5h14.2a1 1 0 00.9-1.5L15 9V3M9 3h6' },
  { id:'frm-materials', cat:'forms', badge:'SUBMIT', formType:'materials',
    title:'Raw Materials Report',
    sub:'Fill full stock movement — every material, coal supplier, bags, grinding aid & diesel',
    url:'forms/materials-form.html',
    d:'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4' },
  { id:'frm-limestone', cat:'forms', badge:'SUBMIT', formType:'limestone',
    title:'Limestone % Report',
    sub:'Fill daily limestone quality percentage data',
    url:'forms/limestone-form.html',
    d:'M12 2l8 5v10l-8 5-8-5V7l8-5z' },
  { id:'frm-pile-quality', cat:'forms', badge:'SUBMIT', formType:'pile-quality',
    title:'Pile Quality Report',
    sub:'Fill hourly CaO/MgO pile chemistry samples',
    url:'forms/pile-quality-form.html',
    d:'M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z' },
  { id:'frm-stoppage', cat:'forms', badge:'SUBMIT', formType:'stoppage',
    title:'Stoppage Report',
    sub:'Fill section-wise equipment stoppage log',
    url:'forms/stoppage-form.html',
    d:'M12 9v4m0 4h.01M4.93 19h14.14a1 1 0 00.86-1.5L12.86 4.5a1 1 0 00-1.72 0L4.07 17.5a1 1 0 00.86 1.5z' },

  /* ── MIS ───────────────────────────────────────────── */
  { id:'mis', cat:'mis', badge:'VIEW',
    title:'MIS Dashboard',
    sub:'Management Information System',
    url:'mis.html',
    d:'M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z' },
];

/* ── Visibility — derived from permissions, no role hardcoding ── */
function _visibleIds(user) {
  const perms      = getMyPerms();
  const da         = getMyDailyAccess();
  const formAccess = getMyFormAccess();

  const nav        = p => da.nav === 'all' || (Array.isArray(da.nav)  && da.nav.includes(p));
  const submit     = p => Array.isArray(da.edit) && da.edit.includes(p);
  const submitForm = ft => Array.isArray(formAccess) && formAccess.includes(ft);
  const hasKPI = !!(perms.kpi && (perms.kpi.depts === 'all' ||
                   (Array.isArray(perms.kpi.depts) && perms.kpi.depts.length > 0)));
  const hasMIS = !!(Array.isArray(perms.mis_tabs) && perms.mis_tabs.length > 0);

  const ids = new Set();

  /* KPI + Trends + the other view-only KPI/analytics hub pages. (Fixing a
     pre-existing gap here: 'completeness', 'balance' and 'insights' were
     defined in _CARDS with cat:'kpi' but never added to `ids` by this
     function, so they never actually appeared on the portal for any role —
     matching that behavior for the new 'reliability' card would just make
     it equally unreachable, so all four are wired up together here.) */
  if (hasKPI) {
    ids.add('kpi'); ids.add('trends'); ids.add('completeness');
    ids.add('balance'); ids.add('insights'); ids.add('reliability');
  }

  /* View-only reports (excluded if this role can also submit) — covers
     the 3 original hub pages plus Power Cons./Dispatch & SO, which are
     now first-class nav destinations too (see _DAILY_NAV_ITEMS). */
  if (nav('daily-report.html')       && !submit('daily-report.html'))       ids.add('rpt-daily');
  if (nav('power-plant-report.html') && !submit('power-plant-report.html')) ids.add('rpt-power');
  if (nav('mines-report.html')       && !submit('mines-report.html'))       ids.add('rpt-mines');
  if (nav('power-form.html')         && !submitForm('power-cons'))          ids.add('rpt-power-cons');
  if (nav('dispatch-form.html')      && !submitForm('dispatch'))            ids.add('rpt-dispatch');
  if (nav('materials-form.html')     && !submitForm('materials'))           ids.add('rpt-materials');
  if (nav('stoppage-form.html')      && !submitForm('stoppage'))            ids.add('rpt-stoppage');

  /* Submittable report pages (inline editing now lives inside the reports) */
  if (submit('daily-report.html'))       ids.add('frm-daily');
  if (submit('power-plant-report.html')) ids.add('frm-power-rpt');
  if (submit('mines-report.html'))       ids.add('frm-mines-rpt');

  /* Standalone daily-entry forms — submit-only tiles, driven entirely by
     _FORM_TYPE_ACCESS (getMyFormAccess()) so a new role/form mapping there
     shows up here automatically without touching this file again. */
  _CARDS.forEach(c => {
    if (c.cat === 'forms' && c.formType && submitForm(c.formType)) ids.add(c.id);
  });

  /* MIS */
  if (hasMIS) ids.add('mis');

  return ids;
}

/* ── Render ────────────────────────────────────────────────── */
function _renderCards(user) {
  const ids   = _visibleIds(user);
  const cards = _CARDS.filter(c => ids.has(c.id));
  const main  = document.getElementById('portal-main');

  if (!cards.length) {
    main.innerHTML = '<div class="portal-empty">No modules assigned. Contact your system administrator.</div>';
    return;
  }

  const grouped = {};
  cards.forEach(c => { (grouped[c.cat] = grouped[c.cat] || []).push(c); });

  let html = '';
  ['kpi', 'reports', 'forms', 'mis'].forEach(cat => {
    if (!grouped[cat]) return;
    const m = _CATS[cat];
    html += `
<div class="portal-section">
  <div class="portal-section-hdr">
    <span class="psh-dot" style="background:${m.accent}"></span>
    <span class="psh-label">${m.label}</span>
    <span class="psh-count">${grouped[cat].length}</span>
  </div>
  <div class="portal-grid">
    ${grouped[cat].map(c => _cardHTML(c, m)).join('\n    ')}
  </div>
</div>`;
  });

  main.innerHTML = html;
}

function _cardHTML(c, m) {
  const bc = c.badge === 'SUBMIT' ? 'badge-submit' : 'badge-view';
  return `<a href="${c.url}" class="pcard">
  <div class="pcard-accent" style="background:${m.accent}"></div>
  <div class="pcard-icon" style="color:${m.accent}">
    <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" d="${c.d}"/>
    </svg>
  </div>
  <div class="pcard-body">
    <div class="pcard-title">${c.title}</div>
    <div class="pcard-sub">${c.sub}</div>
  </div>
  <div class="pcard-footer">
    <span class="pcard-badge ${bc}">${c.badge}</span>
    <svg class="pcard-arrow" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
    </svg>
  </div>
</a>`;
}

function _renderGreeting(user) {
  const hr    = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const first = user.name.split(' ')[0];
  document.getElementById('pg-greeting').textContent = `${greet}, ${first}`;
  document.getElementById('pg-sub').textContent      = `${user.dept}  ·  ${user.name}`;
}

function _renderDate() {
  const d   = new Date();
  const str = d.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  const el  = document.getElementById('pg-date');
  const yr  = document.getElementById('portal-year');
  if (el) el.textContent = str;
  if (yr) yr.textContent = d.getFullYear();
}

/* ── Bootstrap ─────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  requireAuth();
  const user = getCurrentUser();
  if (!user) return;
  renderUserHeader();
  _renderGreeting(user);
  _renderDate();
  _renderCards(user);
});
