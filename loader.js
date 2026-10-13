/* ══════════════════════════════════════════════════════════════════
   Lake Cement Ltd — Navigation Loader  |  loader.js
   ─────────────────────────────────────────────────────────────────
   This app is a multi-page app: every sidebar row is a real <a href>
   full page load (sidebar.js). That means a spinner mounted by the
   INCOMING page arrives after most of the wait is already over — the
   browser keeps painting the OLD page until the new one's first paint.
   So the wait is covered in two halves that hand off to each other:

     outbound  a click writes its intent to sessionStorage, raises the
               progress bar and (after SHOW_DELAY) the cover card;
     inbound   the next page reads that intent in <head> and re-raises
               the same card in the same place before first paint, so
               the card looks continuous across the navigation.

   Captions are not decoration — window.fetch is wrapped here so the
   line under the title names the pipeline stage actually in flight
   ("Talking to Odoo…" only when /api/sales|purchases is open). A load
   that stalls therefore says where it stalled.

   Loaded in <head> right after sidebar.js on the 27 shell pages.
   Self-contained: no dependency on auth.js, lucide or api-client.js.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  if (window.LCLoader) return;                 /* idempotent */

  /* ── Tunables ─────────────────────────────────────────────────── */
  var SHOW_DELAY = 150;    /* outbound: a nav faster than this shows nothing  */
  var COLD_DELAY = 600;    /* inbound, no intent: only cover a genuinely slow load */
  var MIN_SHOW   = 350;    /* once up, stay up this long — never a flash      */
  var QUIET_MS   = 400;    /* "data landed" = this long with 0 fetches open   */
  var SKIP_AFTER = 4000;   /* offer the escape hatch                          */
  var SOFT_CAP   = 6000;   /* after window.load, stop waiting on data         */
  var HARD_CAP   = 12000;  /* absolute ceiling — the user is never trapped    */
  var INTENT_TTL = 30000;  /* an older stored click is stale (back button)    */
  var INTENT_KEY = 'lcl_nav_intent';

  /* ── Destination registry ─────────────────────────────────────────
     One flavoured line per destination, deliberately: these pages get
     hit dozens of times a day and a rotating carousel of jokes turns
     grating fast. Anything past ~4.5s escalates to the honest lines
     below instead. `group` picks the accent from the sidebar's own
     group colours (styles.css .group-*). */
  var DEPTS = {
    summary:       ['Executive Summary', 'Pulling the plant together…'],
    production:    ['Production',        'Pulling today’s clinker…'],
    mines:         ['Quarrying',         'Counting the trucks…'],
    ei:            ['E & I',             'Checking the circuits…'],
    mechanical:    ['Mechanical',        'Checking the machines…'],
    powerplant:    ['Power Plant',       'Reading the meters…'],
    packing:       ['Packing',           'Counting the bags…'],
    stores:        ['Stores',            'Walking the aisles…'],
    minesworkshop: ['Quarry Workshop',   'Checking the fleet…']
  };

  var PAGES = {
    'index.html':                ['Executive Summary',        'Pulling the plant together…', 'kpi'],
    'analytics.html':            ['Operational Summary',      'Crunching the numbers…',      'analytics'],
    'completeness.html':         ['Entry Summary',            'Checking what came in…',      'daily'],
    'balance.html':              ['Power & Heat',              'Balancing the books…',        'analytics'],
    'insights.html':             ['Stoppage Insights',        'Looking for patterns…',       'analytics'],
    'reliability.html':          ['Equipment Reliability',    'Reading the downtime log…',   'analytics'],
    'mines-report.html':         ['Quarrying Report',         'Counting the trucks…',        'kpi'],
    'power-plant-report.html':   ['Power Plant Report',       'Reading the meters…',         'kpi'],
    'approvals.html':            ['Approvals',                'Opening the queue…',          'daily'],
    'corrections.html':          ['Corrections',              'Finding the reports…',        'daily'],
    'compliance.html':           ['Compliance Master',        'Checking the licences…',      'ops'],
    'daily-report.html':         ['Daily Report',             'Fetching the latest data…',   'daily'],
    'mis.html':                  ['Management Info.',         'Building the report…',        'mis'],
    'sales.html':                ['Sales & Dispatch',         'Tallying the despatches…',    'kpi'],
    'purchases.html':            ['Raw Materials & Purchases', 'Checking the POs…',          'kpi'],
    'memory.html':               ['Plant Memory',             'Searching the archive…',      'ops'],
    'reports-export.html':       ['Reports & Exports',        'Preparing your export…',      'ops'],
    'monitor.html':              ['System Monitor',           'Taking the pulse…',           'ops'],
    'portal.html':               ['Portal',                   'Just a moment…',              'ops'],
    'coming-soon.html':          ['Coming Soon',              'Just a moment…',              'ops'],
    'forms/index.html':          ['Daily Reports',            'Opening the day book…',       'daily'],
    'dispatch-form.html':        ['Despatch Entry',           'Loading the despatch sheet…', 'daily'],
    'limestone-form.html':       ['Limestone Entry',          'Loading the limestone sheet…','daily'],
    'materials-form.html':       ['Materials Entry',          'Loading the materials sheet…','daily'],
    'pile-quality-form.html':    ['Pile Quality Entry',       'Loading the pile sheet…',     'daily'],
    'power-form.html':           ['Power Entry',              'Loading the power sheet…',    'daily'],
    'quality-form.html':         ['Quality Entry',            'Loading the quality sheet…',  'daily'],
    'stoppage-form.html':        ['Stoppage Entry',           'Loading the stoppage log…',   'daily'],
    'sales-projection-form.html':['Sales Projection',         'Loading the projection…',     'daily']
  };

  var FALLBACK = ['Just a moment…', 'Fetching the latest data…', 'ops'];

  /* .group-kpi's sidebar dot is white — legible on the navy rail, invisible
     on this off-white cover — so KPI takes navy here instead. */
  var ACCENT = {
    kpi:       'var(--navy)',
    daily:     'var(--orange)',
    analytics: 'var(--sb-accent-analytics)',
    mis:       'var(--green)',
    ops:       '#64748B'
  };

  /* Pipeline stage → caption. Only /api/sales and /api/purchases actually
     reach Odoo (backend/services/{sales,purchases}Odoo.js), so only they
     get to say so. First match wins; most recent call is displayed. */
  var API_CAPTIONS = [
    [/\/api\/auth\//,               'Checking your access…'],
    [/\/api\/(sales|purchases)\b/,  'Talking to Odoo…'],
    [/\/api\/formula\//,            'Crunching the numbers…'],
    [/\/api\/quarry\b/,             'Counting the trucks…'],
    [/\/api\/mis\b/,                'Building the report…'],
    [/\/api\/insights\b/,           'Looking for patterns…'],
    [/\/api\/approvals\b/,          'Checking the approval queue…'],
    [/\/api\/kpi\b/,                'Reading the KPI ledger…'],
    [/\/api\/reports\b/,            'Fetching the latest data…']
  ];

  var SLOW_CAPTION    = 'Almost there…';
  var STALLED_CAPTION = 'Still working — the server is taking its time.';

  /* ── State ────────────────────────────────────────────────────── */
  var els = null, shown = false, shownAt = 0, finished = false;
  var showTimer = 0, coldTimer = 0, pollTimer = 0, creepTimer = 0, fadeTimer = 0;
  var progress = 0, creepTarget = 0;
  var inflight = 0, apiCaption = '', baseCaption = '';
  var startedAt = now(), lastSettle = now(), loadedAt = 0;
  var shownCaption = '', outbound = false;

  function now() { return Date.now(); }

  /* ── DOM ──────────────────────────────────────────────────────── */
  /* The script sits in <head>, so <body> may not exist yet. DOMContentLoaded
     is too late — it waits on the render-blocking chart.js/lucide tags at the
     bottom of every page, which is exactly the delay being covered. Poll for
     <body> instead; it lands within a frame or two of the parser reaching it. */
  function whenBody(cb) {
    if (document.body) return cb();
    var tries = 0;
    var t = setInterval(function () {
      if (document.body) { clearInterval(t); cb(); }
      else if (++tries > 1500) { clearInterval(t); }
    }, 4);
  }

  function build(cb) {
    if (els) return cb();
    whenBody(function () {
      if (els) return cb();
      var bar = document.createElement('div');
      bar.className = 'lcl-bar';
      bar.setAttribute('aria-hidden', 'true');
      bar.innerHTML = '<span class="lcl-bar-fill"></span>';

      var cover = document.createElement('div');
      cover.className = 'lcl-load';
      cover.setAttribute('role', 'status');
      cover.setAttribute('aria-live', 'polite');
      cover.innerHTML =
        '<div class="lcl-load-inner">' +
          '<div class="lcl-mark">' +
            '<svg class="lcl-ring" viewBox="0 0 48 48" aria-hidden="true">' +
              '<circle class="lcl-ring-track" cx="24" cy="24" r="21"></circle>' +
              '<circle class="lcl-ring-arc" cx="24" cy="24" r="21"></circle>' +
            '</svg>' +
            '<span class="lcl-mark-icon" aria-hidden="true"></span>' +
          '</div>' +
          '<div class="lcl-title"></div>' +
          '<div class="lcl-caption"></div>' +
          '<ol class="lcl-steps" hidden></ol>' +
          '<button type="button" class="lcl-skip" hidden>Continue anyway</button>' +
        '</div>';

      document.body.appendChild(bar);
      document.body.appendChild(cover);

      els = {
        bar:     bar,
        fill:    bar.firstChild,
        cover:   cover,
        title:   cover.querySelector('.lcl-title'),
        caption: cover.querySelector('.lcl-caption'),
        icon:    cover.querySelector('.lcl-mark-icon'),
        steps:   cover.querySelector('.lcl-steps'),
        skip:    cover.querySelector('.lcl-skip')
      };
      els.skip.addEventListener('click', finish);
      cb();
    });
  }

  /* ── Painting ─────────────────────────────────────────────────── */
  function setAccent(group) {
    document.documentElement.style.setProperty('--lcl-accent', ACCENT[group] || ACCENT.ops);
  }

  function setTitle(text) {
    build(function () { els.title.textContent = text || ''; });
  }

  /* Cross-fades rather than snapping — a caption that jumps mid-wait reads
     as a glitch, and these change up to three times on a slow load. */
  function setCaption(text, immediate) {
    if (!text || text === shownCaption) return;
    shownCaption = text;
    build(function () {
      if (immediate) { els.caption.textContent = text; return; }
      clearTimeout(fadeTimer);
      els.caption.classList.add('fade');
      fadeTimer = setTimeout(function () {
        els.caption.textContent = text;
        els.caption.classList.remove('fade');
      }, 170);
    });
  }

  /* The icon is cloned straight off the sidebar row that was clicked — lucide
     has already rendered it there — so no icon set is duplicated in this file
     and the mark always matches the row. Same-origin sessionStorage is the
     only writer, but this markup gets re-injected as innerHTML on the next
     page, so it is shape-checked before it is trusted. */
  function safeIcon(markup) {
    if (!markup || markup.length > 4000) return '';
    if (!/^<svg[\s\S]*<\/svg>$/i.test(markup)) return '';
    if (/<script|\son\w+\s*=|javascript:/i.test(markup)) return '';
    return markup;
  }

  function setIcon(markup) {
    var safe = safeIcon(markup);
    build(function () { els.icon.innerHTML = safe; });
  }

  function barOn()  { build(function () { els.bar.classList.add('on'); }); }
  function barTo(p) {
    progress = p;
    build(function () { els.fill.style.transform = 'scaleX(' + p.toFixed(4) + ')'; });
  }

  /* Eases toward the target and never reaches it — the bar keeps moving on a
     slow load without ever claiming to be done. finish() jumps it to 1. */
  function startCreep(target) {
    creepTarget = target;
    stopCreep();
    creepTimer = setInterval(function () {
      if (finished) return stopCreep();
      barTo(progress + (creepTarget - progress) * 0.09);
    }, 240);
  }
  function stopCreep() { if (creepTimer) { clearInterval(creepTimer); creepTimer = 0; } }

  function showCover() {
    if (finished || shown) return;
    build(function () {
      if (finished) return;
      shown = true; shownAt = now();
      els.cover.classList.add('on');
    });
  }

  /* ── Fetch instrumentation ────────────────────────────────────────
     window.fetch is the single choke point every page's data goes through
     (forms/api-client.js and auth.js both use it directly), so wrapping it
     here gives both the "is the page still working?" signal and the honest
     caption, with zero per-page wiring. Transparent: same arguments, same
     return value, errors rethrown untouched. */
  var origFetch = window.fetch;
  var unwrap = null;
  if (typeof origFetch === 'function') {
    var wrapped = function (input) {
      if (finished) return origFetch.apply(this, arguments);
      var url = '';
      try {
        url = (typeof input === 'string') ? input
            : (input && input.url) ? input.url
            : String(input);
      } catch (e) { /* opaque input — tracked, just not captioned */ }
      inflight++;
      noteApi(url);
      var p;
      try { p = origFetch.apply(this, arguments); }
      catch (e) { settle(); throw e; }
      if (!p || typeof p.then !== 'function') { settle(); return p; }
      return p.then(
        function (r) { settle(); return r; },
        function (e) { settle(); throw e; }
      );
    };
    window.fetch = wrapped;
    /* Handed back at finish() so nothing pays for this after the load. */
    unwrap = function () { if (window.fetch === wrapped) window.fetch = origFetch; };
  }

  function settle() {
    if (inflight > 0) inflight--;
    lastSettle = now();
  }

  function noteApi(url) {
    for (var i = 0; i < API_CAPTIONS.length; i++) {
      if (API_CAPTIONS[i][0].test(url)) { apiCaption = API_CAPTIONS[i][1]; return; }
    }
  }

  /* ── Destination resolution ───────────────────────────────────── */
  function describe(pathname, search) {
    var file = (pathname.split('/').pop() || 'index.html').toLowerCase();
    var inForms = /\/forms\//i.test(pathname);
    var row;
    if (file === 'index.html' && inForms) {
      row = PAGES['forms/index.html'];
    } else if (file === 'index.html') {
      var dept = null;
      try { dept = new URLSearchParams(search || '').get('dept'); } catch (e) {}
      if (dept && DEPTS[dept]) {
        return { name: DEPTS[dept][0], line: DEPTS[dept][1], group: 'kpi' };
      }
      row = PAGES['index.html'];
    } else {
      row = PAGES[file];
    }
    row = row || FALLBACK;
    return { name: row[0], line: row[1], group: row[2] };
  }

  /* ── Inbound: re-raise the card the previous page put up ──────── */
  function readIntent() {
    var raw;
    try { raw = sessionStorage.getItem(INTENT_KEY); sessionStorage.removeItem(INTENT_KEY); }
    catch (e) { return null; }
    if (!raw) return null;
    var it;
    try { it = JSON.parse(raw); } catch (e) { return null; }
    if (!it || typeof it.t !== 'number') return null;
    if (now() - it.t > INTENT_TTL) return null;          /* stale — back button */
    /* Landed somewhere other than where the click was aimed (redirect, guard);
       the stored card would be wrong, so describe this page instead. */
    try {
      if (it.href && new URL(it.href).pathname !== location.pathname) return null;
    } catch (e) { return null; }
    return it;
  }

  function boot() {
    var intent = readIntent();
    var d = intent
      ? { name: intent.name, line: intent.line, group: intent.group }
      : describe(location.pathname, location.search);

    baseCaption = d.line;
    setAccent(d.group);
    setTitle(d.name);
    setCaption(d.line, true);
    setIcon(intent ? intent.icon : '');

    document.documentElement.classList.add('lcl-loading');
    barOn();
    barTo(intent ? 0.55 : 0.22);
    startCreep(0.9);

    /* With an intent the wait began on the previous page, so the card comes
       straight up — that is the continuity. Without one (hard refresh, typed
       URL) nothing appears unless the load is actually slow. */
    if (intent) showCover();
    else coldTimer = setTimeout(showCover, COLD_DELAY);

    if (document.readyState === 'complete') loadedAt = now();
    else window.addEventListener('load', function () { loadedAt = now(); });

    poll();
  }

  function currentCaption(elapsed) {
    if (elapsed > 8000) return STALLED_CAPTION;
    if (elapsed > 4500) return SLOW_CAPTION;
    return apiCaption || baseCaption;
  }

  function poll() {
    if (finished) return;
    var elapsed = now() - startedAt;
    setCaption(currentCaption(elapsed));

    if (shown && elapsed > SKIP_AFTER && els && els.skip.hidden) els.skip.hidden = false;
    if (elapsed > HARD_CAP) return finish();

    if (loadedAt) {
      var quiet = inflight === 0 && (now() - lastSettle) > QUIET_MS;
      if (quiet || (now() - loadedAt) > SOFT_CAP) return finish();
    }
    pollTimer = setTimeout(poll, 110);
  }

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(pollTimer); clearTimeout(coldTimer); clearTimeout(showTimer);
    stopCreep();
    if (unwrap) unwrap();
    document.documentElement.classList.remove('lcl-loading');

    var hold = shown ? Math.max(0, MIN_SHOW - (now() - shownAt)) : 0;
    setTimeout(function () {
      barTo(1);
      if (!els) return;
      els.cover.classList.remove('on');
      shown = false;
      setTimeout(function () {
        els.bar.classList.remove('on');
        setTimeout(function () { barTo(0); }, 260);
      }, 280);
    }, hold);
  }

  /* Immediate teardown with no animation — for bfcache restores, where the
     page comes back from the cache mid-fade with a frozen cover on it. */
  function reset() {
    finished = true;
    clearTimeout(pollTimer); clearTimeout(coldTimer); clearTimeout(showTimer);
    stopCreep();
    document.documentElement.classList.remove('lcl-loading');
    if (!els) return;
    shown = false;
    els.cover.classList.remove('on');
    els.bar.classList.remove('on');
    els.skip.hidden = true;
    barTo(0);
  }

  /* ── Outbound: arm the card on the way out ────────────────────── */
  function arm(url, anchor) {
    if (outbound) return;
    outbound = true;
    finished = false;                 /* a finished inbound load re-arms here */
    var d = describe(url.pathname, url.search);
    var icon = '';
    try {
      var svg = anchor && anchor.querySelector && anchor.querySelector('svg');
      if (svg) icon = safeIcon(svg.outerHTML);
    } catch (e) {}

    try {
      sessionStorage.setItem(INTENT_KEY, JSON.stringify({
        t: now(), name: d.name, line: d.line, group: d.group, icon: icon, href: url.href
      }));
    } catch (e) { /* private mode — the outbound half still works on its own */ }

    baseCaption = d.line;
    apiCaption = '';
    shownCaption = '';
    setAccent(d.group);
    setTitle(d.name);
    setCaption(d.line, true);
    setIcon(icon);
    barOn(); barTo(0.08); startCreep(0.82);

    clearTimeout(showTimer);
    showTimer = setTimeout(showCover, SHOW_DELAY);
    /* If the navigation never happens (blocked, cancelled, handler bailed),
       hand the page back rather than sitting on a dead cover. */
    setTimeout(function () { outbound = false; reset(); }, HARD_CAP);
  }

  function isPlainClick(e) {
    return !e.defaultPrevented && e.button === 0 &&
           !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
  }

  function internalTarget(rawHref) {
    if (!rawHref || rawHref.charAt(0) === '#') return null;
    if (/^(javascript|mailto|tel|blob|data):/i.test(rawHref)) return null;
    var u;
    try { u = new URL(rawHref, location.href); } catch (e) { return null; }
    if (u.origin !== location.origin) return null;
    if (!/\.html?$/i.test(u.pathname)) return null;                 /* not a page nav */
    if (/login\.html$/i.test(u.pathname)) return null;              /* logout / session end */
    if (u.pathname === location.pathname && u.search === location.search) return null;
    return u;
  }

  /* Bubble phase, not capture: a page handler that calls preventDefault on its
     own link must win, and e.defaultPrevented is not yet set during capture. */
  document.addEventListener('click', function (e) {
    if (!isPlainClick(e)) return;
    var el = e.target;
    if (!el || !el.closest) return;

    var a = el.closest('a[href]');
    if (a) {
      if (a.target && a.target !== '_self') return;
      if (a.hasAttribute('download')) return;
      var u = internalTarget(a.getAttribute('href'));
      if (u) arm(u, a);
      return;
    }
    /* sidebar.js renders a few rows as onclick="location.href='…'" with no
       href attribute (the SOON stubs) — same navigation, different markup. */
    var oc = el.closest('[onclick]');
    if (!oc) return;
    var m = /location\.href\s*=\s*['"]([^'"]+)['"]/.exec(oc.getAttribute('onclick') || '');
    if (!m) return;
    var u2 = internalTarget(m[1]);
    if (u2) arm(u2, oc);
  }, false);

  window.addEventListener('pageshow', function (e) {
    if (e.persisted) { stepState = []; reset(); }
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && shown) finish();
  });

  /* Public surface — a page with a long tail of work after load can hold the
     cover and release it itself. Nothing is required to; the fetch tracking
     above already covers all 27 pages unassisted. */
  /* ── Step list ────────────────────────────────────────────────
     For work the fetch tracker cannot time: a page that pulls several
     datasets in sequence, or asks the server to run an Odoo sync that
     takes 15-55s. A spinner alone over that long reads as a hang; naming
     the stage that is actually running is what makes a long wait legible.

     Deliberately NOT a percentage bar. These steps have no honest
     proportion — a gate-entry pull is 15s and a GRN pull 4s against the
     same ERP, and inventing a percent would be a number the page cannot
     stand behind. A checklist says the same thing truthfully.

     The caption keeps working alongside it; steps are additive. */
  var stepState = [];

  function paintSteps() {
    build(function () {
      if (!stepState.length) { els.steps.hidden = true; return; }
      els.steps.hidden = false;
      els.steps.innerHTML = stepState.map(function (st) {
        /* textContent, not innerHTML, for the label — these can carry a
           dataset name that came back from the server. */
        var li = document.createElement('li');
        li.className = 'lcl-step is-' + st.state;
        var dot = document.createElement('span');
        dot.className = 'lcl-step-dot';
        dot.setAttribute('aria-hidden', 'true');
        var txt = document.createElement('span');
        txt.className = 'lcl-step-label';
        txt.textContent = st.label;
        li.appendChild(dot);
        li.appendChild(txt);
        if (st.note) {
          var note = document.createElement('span');
          note.className = 'lcl-step-note';
          note.textContent = st.note;
          li.appendChild(note);
        }
        return li.outerHTML;
      }).join('');
      /* Screen readers get the running step announced, not the whole list
         re-read on every repaint. */
      var active = stepState.filter(function (s) { return s.state === 'run'; })[0];
      els.steps.setAttribute('aria-label',
        active ? 'Now: ' + active.label : 'Progress');
    });
  }

  window.LCLoader = {
    done:    finish,
    caption: function (text) { baseCaption = text; setCaption(text); },
    hold:    function () { loadedAt = 0; },

    /* steps(['Reading the gate log', 'Matching GRNs', …]) — all pending.

       This RAISES the cover. It used to only paint, which meant nothing
       appeared at all: the cover sits at opacity:0/visibility:hidden until
       it gets the .on class, and showCover() is reached from exactly one
       place — a sidebar navigation intent. A button that starts slow work
       in the current page (Sync now, Fill from Odoo) has no intent, so the
       steps were being drawn into an invisible element and the caller saw
       a frozen page instead of a checklist.

       A caller only asks for steps when it knows the work is slow, so
       showing the cover immediately is the whole point — there is no
       cold-delay guess to make. */
    steps: function (labels) {
      stepState = (labels || []).map(function (l) {
        return { label: String(l), state: 'wait', note: '' };
      });
      /* finished latches true once a page has settled, and showCover()
         refuses to run after that — so an in-page action late in the
         page's life would be silently ignored. Reopening is correct here:
         new work has genuinely started. */
      finished = false;
      paintSteps();
      /* Raise it directly rather than via showCover(). A finish() from a
         just-settled page load leaves `shown` true for up to MIN_SHOW ms
         while its fade-out timeout is pending, and showCover() returns
         early on `shown` — so routing through it drops the cover exactly
         when a user clicks a slow button right after the page settles. */
      build(function () {
        shown = true; shownAt = now();
        els.cover.classList.add('on');
      });
      return window.LCLoader;
    },
    /* step(i, 'run'|'ok'|'fail', optional note like '181 lines') */
    step: function (index, state, note) {
      var st = stepState[index];
      if (!st) return window.LCLoader;
      st.state = state || 'run';
      if (note !== undefined) st.note = String(note);
      paintSteps();
      return window.LCLoader;
    },
    clearSteps: function () { stepState = []; paintSteps(); return window.LCLoader; }
  };

  boot();
})();
