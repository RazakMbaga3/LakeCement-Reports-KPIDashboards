/* ═══════════════════════════════════════════════════════════════════
   Lake Cement Ltd — Portal Home  |  portal.js
   Role-aware module launcher. Derives card visibility from auth.js
   permission data — no hardcoding per role.
═══════════════════════════════════════════════════════════════════ */
'use strict';

/* ── Category metadata ────────────────────────────────────────── */
const _CATS = {
  kpi:     { label: 'KPI & Analytics',   accent: '#173158' },
  reports: { label: 'Reports',           accent: '#239557' },
  forms:   { label: 'Entry Forms',       accent: '#F49545' },
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

  { id:'rpt-forms', cat:'reports', badge:'VIEW',
    title:'Forms Status Board',
    sub:'Today\'s submission status overview',
    url:'forms/index.html',
    d:'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4' },

  /* ── Entry Forms (submit) ──────────────────────────── */
  { id:'frm-daily', cat:'forms', badge:'SUBMIT',
    title:'Daily Production Report',
    sub:'Submit today\'s production data',
    url:'daily-report.html',
    d:'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },

  { id:'frm-power-rpt', cat:'forms', badge:'SUBMIT',
    title:'Power Plant Report',
    sub:'Submit daily power plant data',
    url:'power-plant-report.html',
    d:'M13 10V3L4 14h7v7l9-11h-7z' },

  { id:'frm-mines-rpt', cat:'forms', badge:'SUBMIT',
    title:'Mines Daily Report',
    sub:'Submit mines movement data',
    url:'mines-report.html',
    d:'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10' },

  { id:'frm-dispatch', cat:'forms', badge:'SUBMIT',
    title:'Dispatch Form',
    sub:'Log daily dispatch & deliveries',
    url:'forms/dispatch-form.html',
    d:'M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0zM13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0' },

  { id:'frm-stoppage', cat:'forms', badge:'SUBMIT',
    title:'Stoppage Report',
    sub:'Record equipment stoppages',
    url:'forms/stoppage-form.html',
    d:'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z' },

  { id:'frm-limestone', cat:'forms', badge:'SUBMIT',
    title:'Limestone Form',
    sub:'Limestone production data entry',
    url:'forms/limestone-form.html',
    d:'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z' },

  { id:'frm-quality', cat:'forms', badge:'SUBMIT',
    title:'Quality Report',
    sub:'Submit QC laboratory results',
    url:'forms/quality-form.html',
    d:'M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z' },

  { id:'frm-pile', cat:'forms', badge:'SUBMIT',
    title:'Pile Quality Form',
    sub:'Pile quality data entry',
    url:'forms/pile-quality-form.html',
    d:'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4' },

  { id:'frm-overtime', cat:'forms', badge:'SUBMIT',
    title:'Overtime Form',
    sub:'Submit overtime records',
    url:'forms/overtime-form.html',
    d:'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },

  { id:'frm-materials', cat:'forms', badge:'SUBMIT',
    title:'Materials Form',
    sub:'Stores & materials daily entry',
    url:'forms/materials-form.html',
    d:'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4' },

  { id:'frm-power', cat:'forms', badge:'SUBMIT',
    title:'Power Consumption Form',
    sub:'Power usage data entry',
    url:'forms/power-form.html',
    d:'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z' },

  { id:'frm-kiln', cat:'forms', badge:'SUBMIT',
    title:'Kiln Form',
    sub:'Kiln operational parameters',
    url:'forms/kiln-form.html',
    d:'M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z' },

  { id:'frm-millcem', cat:'forms', badge:'SUBMIT',
    title:'Cement Mill Form',
    sub:'Cement mill parameters',
    url:'forms/cement-mill-form.html',
    d:'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z' },

  { id:'frm-cpp', cat:'forms', badge:'SUBMIT',
    title:'CPP Form',
    sub:'CPP daily data entry',
    url:'forms/cpp-form.html',
    d:'M13 10V3L4 14h7v7l9-11h-7z' },

  /* ── MIS ───────────────────────────────────────────── */
  { id:'mis', cat:'mis', badge:'VIEW',
    title:'MIS Dashboard',
    sub:'Management Information System',
    url:'mis.html',
    d:'M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z' },
];

/* ── Visibility — derived from permissions, no role hardcoding ── */
function _visibleIds(user) {
  const perms = getMyPerms();
  const da    = getMyDailyAccess();

  const nav    = p => da.nav === 'all' || (Array.isArray(da.nav)  && da.nav.includes(p));
  const submit = p => Array.isArray(da.edit) && da.edit.includes(p);
  const hasKPI = !!(perms.kpi && (perms.kpi.depts === 'all' ||
                   (Array.isArray(perms.kpi.depts) && perms.kpi.depts.length > 0)));
  const hasMIS = !!(Array.isArray(perms.mis_tabs) && perms.mis_tabs.length > 0);

  const ids = new Set();

  /* KPI + Trends */
  if (hasKPI) { ids.add('kpi'); ids.add('trends'); }

  /* View-only reports (excluded if this role can also submit) */
  if (nav('daily-report.html')       && !submit('daily-report.html'))       ids.add('rpt-daily');
  if (nav('power-plant-report.html') && !submit('power-plant-report.html')) ids.add('rpt-power');
  if (nav('mines-report.html')       && !submit('mines-report.html'))       ids.add('rpt-mines');
  if (nav('daily-report.html'))                                              ids.add('rpt-forms');

  /* Submittable pages */
  if (submit('daily-report.html'))       ids.add('frm-daily');
  if (submit('power-plant-report.html')) ids.add('frm-power-rpt');
  if (submit('mines-report.html'))       ids.add('frm-mines-rpt');
  if (submit('dispatch-form.html'))      ids.add('frm-dispatch');
  if (submit('stoppage-form.html'))      ids.add('frm-stoppage');
  if (submit('limestone-form.html'))     ids.add('frm-limestone');
  if (submit('quality-form.html'))       ids.add('frm-quality');
  if (submit('pile-quality-form.html'))  ids.add('frm-pile');
  if (submit('overtime-form.html'))      ids.add('frm-overtime');
  if (submit('materials-form.html'))     ids.add('frm-materials');
  if (submit('power-form.html'))         ids.add('frm-power');
  if (submit('kiln-form.html'))          ids.add('frm-kiln');
  if (submit('cement-mill-form.html'))   ids.add('frm-millcem');
  if (submit('cpp-form.html'))           ids.add('frm-cpp');

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
