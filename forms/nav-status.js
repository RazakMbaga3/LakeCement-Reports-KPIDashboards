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

  /* Page → the form type it reports on. Must cover every row the sidebar's
     Daily Reports group renders (auth.js's _DAILY_NAV_ITEMS) — the four
     quality/lab forms were missing, so those rows would carry no dot. */
  const PAGE_DEFAULT_FORM = {
    'daily-report.html':          'production',
    'power-plant-report.html':    'cpp',
    'mines-report.html':          'mines',
    'stoppage-form.html':         'stoppage',
    'power-form.html':            'power-cons',
    'dispatch-form.html':         'dispatch',
    'materials-form.html':        'materials',
    'quality-form.html':          'quality',
    'limestone-form.html':        'limestone',
    'pile-quality-form.html':     'pile-quality',
    'sales-projection-form.html': 'sales-projection',
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

  /* These dots report on TODAY specifically ("which reports are done today"),
     so they must not follow the form's own date picker — browsing to last
     month used to repaint every dot against that month's data. Local
     calendar date, never toISOString(): EAT is UTC+3. */
  function today() {
    const d = new Date(), p2 = n => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }

  /* auth.js owns the session and stores it under 'lcl_mis_session'. This read
     'nyati_user', a key nothing has ever written, so the role was always null
     and ROLE_SECTION_MAP below never applied. */
  function getCurrentRole() {
    if (typeof getCurrentUser === 'function') {
      const u = getCurrentUser();
      return u ? u.role : null;
    }
    return null;
  }

  /* Which form types the SERVER has a reported entry for today. Filled by
     refresh() below; null until the first answer arrives (or if it never
     does, offline). */
  let _serverToday = null;

  /* A draft typed on THIS device and not yet sent anywhere — the one thing
     the server cannot know. */
  function localDraft(formId) {
    const raw = localStorage.getItem(NS + '-' + formId + '-' + today());
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      const data = parsed.data || {};
      return Object.values(data).some(v => v !== '' && v !== null && v !== undefined);
    } catch (e) { return false; }
  }

  /* Whether a report is done today is a fact about the plant, not about this
     browser. Reading only localStorage — which is what this did — meant an
     operator saw grey dots for reports a colleague had already submitted,
     and green ones for entries that had never left their own laptop. */
  function formStatus(formId) {
    if (_serverToday && _serverToday.has(formId)) return 'submitted';
    if (localDraft(formId)) return 'draft';
    return 'empty';
  }

  function resolveFormId(pageName) {
    const role = getCurrentRole();
    if (role && ROLE_SECTION_MAP[role] && ROLE_SECTION_MAP[role][pageName]) {
      return ROLE_SECTION_MAP[role][pageName];
    }
    return PAGE_DEFAULT_FORM[pageName] || null;
  }

  /* ── Inject nav dots ─────────────────────────────────────────────
     Hangs today's fill-status dot on the sidebar's Daily Reports rows.

     This targeted .nav-btn — the horizontal dept-nav bar retired in the
     sidebar migration — so from that point on it silently found nothing and
     the whole feature was dead. sidebar.js now tags each Daily Reports row
     with data-page, which is what these attach to.

     The dot nests inside .sb-item-icon (not appended to the row) and sits
     absolutely positioned as a small corner badge — see styles.css. It used
     to append as a bare extra child of the row's 3-column grid, which had
     no 4th slot to land in and wrapped onto its own line under every row,
     costing a full line of height on every single Daily Reports item. */
  function injectDots() {
    document.querySelectorAll('.sb-item[data-page]').forEach(function (row) {
      row.querySelector('.nav-dot')?.remove();
      const formId = resolveFormId(row.dataset.page);
      if (!formId) return;
      const st  = formStatus(formId);
      const dot = document.createElement('span');
      dot.className = 'nav-dot nav-dot-' + st;
      dot.title     = st === 'submitted' ? 'Entered today'      :
                      st === 'draft'     ? 'Draft on this device — not submitted' :
                                           'Not yet entered today';
      (row.querySelector('.sb-item-icon') || row).appendChild(dot);
    });
  }

  /* Ask the server which reports are actually in for today, then repaint.
     Falls back to whatever localStorage knows if it cannot answer. */
  async function refresh() {
    if (window.NyatiAPI && NyatiAPI.getCompleteness) {
      try {
        const d = today();
        const payload = await NyatiAPI.getCompleteness(d, d);
        const day = (payload.days || []).find(x => x.date === d);
        _serverToday = new Set((day ? day.forms : []).filter(f => f.present).map(f => f.formType));
      } catch (e) { /* offline — local drafts are all we can show */ }
    }
    injectDots();
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
      'display:inline-flex', 'align-items:center', 'gap:4px',
      'background:' + sh.bg, 'border:1px solid ' + sh.color + '40',
      'color:' + sh.color, 'border-radius:6px',
      'padding:4px 8px', 'font-size:12px', 'font-weight:700',
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
    injectDots();   // paint immediately from local state…
    refresh();      // …then correct it from the server
    injectShift();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* A submit changes what the SERVER holds, so re-ask it; a draft save only
     changes this device, so a local repaint is enough. The date picker no
     longer triggers anything — these dots are about today, whatever day the
     form is showing. */
  document.addEventListener('nyati:submitted',    refresh);
  document.addEventListener('nyati:inline-saved', refresh);
  document.addEventListener('nyati:saved',        injectDots);
  window.addEventListener('storage',              injectDots);

  setInterval(function () { injectShift(); }, 60000);
  /* Someone else's submission should show up without a reload. */
  setInterval(refresh, 120000);

}());
