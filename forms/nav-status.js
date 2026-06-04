/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — Nav Status Dots + Shift Indicator
   ─────────────────────────────────────────────────────────────────
   • Reads today's localStorage for each report form
   • Injects a colored dot next to each nav button
     – green  = submitted today
     – amber  = draft saved today
     – grey   = not started
   • Injects the current operating shift badge into header-right
   • Re-fires on nyati:saved, nyati:submitted, storage events
   ══════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const NS = 'nyati';

  /* URL fragment → form ID mapping */
  const URL_MAP = {
    'daily-report.html':       'production',
    'power-plant-report.html': 'power-plant',
    'mines-report.html':       'mines',
    'dispatch-form.html':      'dispatch',
    'stoppage-form.html':      'stoppage',
    'quality-form.html':       'quality',
    'materials-form.html':     'materials',
    'power-form.html':         'power-cons',
    'pile-quality-form.html':  'pile-quality',
    'cpp-form.html':           'cpp',
  };

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function formStatus(formId) {
    const key = NS + '-' + formId + '-' + today();
    const raw = localStorage.getItem(key);
    if (!raw) return 'empty';
    try { return JSON.parse(raw)._m?.status || 'draft'; } catch (e) { return 'draft'; }
  }

  function formIdFromBtn(btn) {
    /* active button = current page */
    if (btn.classList.contains('active')) {
      const path = location.pathname;
      for (const [pat, id] of Object.entries(URL_MAP)) {
        if (path.includes(pat)) return id;
      }
      return null;
    }
    /* derive from onclick href */
    const oc = btn.getAttribute('onclick') || '';
    const m  = oc.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
    if (m) {
      for (const [pat, id] of Object.entries(URL_MAP)) {
        if (m[1].includes(pat)) return id;
      }
    }
    return null;
  }

  /* ── Inject nav dots ─────────────────────────────────────────── */
  function injectDots() {
    document.querySelectorAll('.nav-btn:not(.secondary)').forEach(btn => {
      btn.querySelector('.nav-dot')?.remove();
      const id = formIdFromBtn(btn);
      if (!id) return;
      const st  = formStatus(id);
      const dot = document.createElement('span');
      dot.className = 'nav-dot nav-dot-' + st;
      dot.title     = st === 'submitted' ? 'Submitted today'   :
                      st === 'draft'     ? 'Draft saved today' :
                                          'Not started';
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
    const sh  = whichShift();
    let   el  = document.getElementById('_ns-shift');
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
      'order:1',   /* always first inside header-right */
    ].join(';');
    el.innerHTML =
      '<span style="width:6px;height:6px;border-radius:50%;' +
        'background:' + sh.color + ';flex-shrink:0;' +
        'animation:_ns-pulse 2s ease-in-out infinite"></span>' +
      sh.label;
  }

  /* ── One-time CSS for animations ─────────────────────────────── */
  function ensureCSS() {
    if (document.getElementById('_ns-css')) return;
    const s = document.createElement('style');
    s.id = '_ns-css';
    s.textContent =
      '@keyframes _ns-pulse{0%,100%{opacity:1}50%{opacity:.35}}' +
      '.nav-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;display:inline-block;margin-left:3px;transition:background .3s}' +
      '.nav-dot-submitted{background:#239557;box-shadow:0 0 0 2px rgba(35,149,87,.2)}' +
      '.nav-dot-draft{background:#D97706;box-shadow:0 0 0 2px rgba(217,119,6,.2)}' +
      '.nav-dot-empty{background:#94A3B8}';
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

  /* Re-run on form save / submit events */
  document.addEventListener('nyati:saved',    injectDots);
  document.addEventListener('nyati:submitted', injectDots);
  window.addEventListener('storage',           injectDots);

  /* Update shift badge every minute */
  setInterval(function () { injectShift(); }, 60000);

}());
