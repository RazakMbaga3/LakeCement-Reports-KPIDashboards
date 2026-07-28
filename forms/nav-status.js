/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — Nav Fill-Status Dots + Shift Indicator
   ─────────────────────────────────────────────────────────────────
   • Reads today's localStorage for each report's relevant section
   • Injects a colored dot next to each nav button
     – green  = submitted today
     – amber  = draft saved today
     – grey   = not started / no data
   • Dot is role-aware: production sees quality fill status on its own
     Production tab; each hub page (incl. the standalone Stoppages /
     Power Cons. / Dispatch & SO tabs) otherwise shows its own form's
     fill status. Kiln and Cement Mill data live inside the Production
     tab (folded in — no longer standalone nav destinations).
   ══════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const NS = 'nyati';

  /* Page → default form ID (used for admin/management/view-only roles) */
  const PAGE_DEFAULT_FORM = {
    'daily-report.html':       'production',
    'power-plant-report.html': 'cpp',
    'mines-report.html':       'mines',
    'stoppage-form.html':      'stoppage',
    'power-form.html':         'power-cons',
    'dispatch-form.html':      'dispatch',
    'materials-form.html':     'materials',
  };

  /* Role → { pageName: formId } — which form ID to check for fill status.
     (stores no longer piggybacks materials status on the Production tab,
      and pm no longer piggybacks stoppage status there either — Raw
      Materials and Stoppages are first-class nav tabs with their own
      dots now.) */
  const ROLE_SECTION_MAP = {
    production: { 'daily-report.html': 'quality', 'power-plant-report.html': 'cpp', 'mines-report.html': 'mines' },
    mining:     { 'mines-report.html': 'mines', 'daily-report.html': 'mines' },
  };

  function today() {
    const d = document.querySelector('input[type="date"]');
    return d ? d.value : new Date().toISOString().slice(0, 10);
  }

  function getCurrentRole() {
    try {
      const u = JSON.parse(sessionStorage.getItem('nyati_user') || '{}');
      return u.role || null;
    } catch (e) { return null; }
  }

  function formStatus(formId) {
    const key = NS + '-' + formId + '-' + today();
    const raw = localStorage.getItem(key);
    if (!raw) return 'empty';
    try {
      const parsed = JSON.parse(raw);
      const status = parsed._m && parsed._m.status;
      /* Also check if data object has any non-empty values */
      const data = parsed.data || {};
      const hasData = Object.values(data).some(function(v){ return v !== '' && v !== null && v !== undefined; });
      if (status === 'submitted') return 'submitted';
      if (status === 'draft' || hasData) return 'draft';
      return 'empty';
    } catch (e) { return 'empty'; }
  }

  function resolveFormId(pageName) {
    const role = getCurrentRole();
    if (role && ROLE_SECTION_MAP[role] && ROLE_SECTION_MAP[role][pageName]) {
      return ROLE_SECTION_MAP[role][pageName];
    }
    return PAGE_DEFAULT_FORM[pageName] || null;
  }

  function pageNameFromHref(href) {
    if (!href) return null;
    const parts = href.split('/');
    const file = parts[parts.length - 1].split('?')[0];
    return file || null;
  }

  function pageNameFromBtn(btn) {
    if (btn.classList.contains('active')) {
      const path = location.pathname;
      for (const pg of Object.keys(PAGE_DEFAULT_FORM)) {
        if (path.includes(pg)) return pg;
      }
      return null;
    }
    const oc = btn.getAttribute('onclick') || '';
    const m  = oc.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
    return m ? pageNameFromHref(m[1]) : null;
  }

  /* ── Inject nav dots ─────────────────────────────────────────── */
  function injectDots() {
    document.querySelectorAll('.nav-btn:not(.secondary)').forEach(function(btn) {
      btn.querySelector('.nav-dot')?.remove();
      const pg = pageNameFromBtn(btn);
      if (!pg) return;
      const formId = resolveFormId(pg);
      if (!formId) return;
      const st  = formStatus(formId);
      const dot = document.createElement('span');
      dot.className = 'nav-dot nav-dot-' + st;
      dot.title     = st === 'submitted' ? 'Submitted today'   :
                      st === 'draft'     ? 'Draft saved today' :
                                          'Not yet filled';
      btn.appendChild(dot);
    });
  }

  /* ── Shift badge ─────────────────────────────────────────────── */
  const SHIFTS = [
    { label: 'S1 Night',   color: '#4F74B2', bg: 'rgba(79,116,178,.12)',  h: [22, 24, 0, 8]  },
    { label: 'S2 Day',     color: '#239557', bg: 'rgba(35,149,87,.12)',   h: [8,  18]         },
    { label: 'S3 Evening', color: '#D97706', bg: 'rgba(217,119,6,.12)',   h: [18, 22]         },
  ];

  function whichShift() {
    const h = new Date().getHours();
    if (h >= 22 || h < 8)  return SHIFTS[0];
    if (h >= 8  && h < 18) return SHIFTS[1];
    return SHIFTS[2];
  }

  function injectShift() {
    const sh = whichShift();
    let el = document.getElementById('_ns-shift');
    if (!el) {
      el = document.createElement('div');
      el.id = '_ns-shift';
      const hr = document.querySelector('.header-right');
      if (hr) hr.insertBefore(el, hr.firstChild);
      else return;
    }
    el.style.cssText = [
      'display:inline-flex', 'align-items:center', 'gap:5px',
      'background:' + sh.bg, 'border:1px solid ' + sh.color + '40',
      'color:' + sh.color, 'border-radius:5px',
      'padding:3px 10px', 'font-size:10px', 'font-weight:700',
      'letter-spacing:.4px', 'white-space:nowrap', 'flex-shrink:0',
      'order:1',
    ].join(';');
    el.innerHTML =
      '<span style="width:6px;height:6px;border-radius:50%;' +
        'background:' + sh.color + ';flex-shrink:0;' +
        'animation:_ns-pulse 2s ease-in-out infinite"></span>' +
      sh.label;
  }

  /* ── CSS ─────────────────────────────────────────────────────── */
  function ensureCSS() {
    if (document.getElementById('_ns-css')) return;
    const s = document.createElement('style');
    s.id = '_ns-css';
    s.textContent =
      '@keyframes _ns-pulse{0%,100%{opacity:1}50%{opacity:.35}}' +
      /* dot base */
      '.nav-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;display:inline-block;' +
        'margin-left:5px;vertical-align:middle;transition:background .3s,box-shadow .3s}' +
      /* submitted = solid green ring */
      '.nav-dot-submitted{background:#239557;box-shadow:0 0 0 2px rgba(35,149,87,.3),' +
        '0 0 0 4px rgba(35,149,87,.1)}' +
      /* draft = amber pulsing */
      '.nav-dot-draft{background:#D97706;box-shadow:0 0 0 2px rgba(217,119,6,.25);' +
        'animation:_ns-pulse 2.4s ease-in-out infinite}' +
      /* empty = muted grey */
      '.nav-dot-empty{background:rgba(148,163,184,.4)}';
    document.head.appendChild(s);
  }

  /* ── Init ────────────────────────────────────────────────────── */
  function init() {
    ensureCSS();
    injectDots();
    injectShift();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* Re-run dots on save/submit/date change/storage event */
  document.addEventListener('nyati:saved',        injectDots);
  document.addEventListener('nyati:submitted',     injectDots);
  document.addEventListener('nyati:inline-saved',  injectDots);
  window.addEventListener('storage',              injectDots);
  document.addEventListener('change', function(e) {
    if (e.target && e.target.type === 'date') setTimeout(injectDots, 50);
  });

  setInterval(function () { injectShift(); }, 60000);

}());
