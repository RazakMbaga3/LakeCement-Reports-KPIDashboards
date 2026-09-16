/* ══════════════════════════════════════════════════════════════════════
   Lake Cement Ltd — MOBILE SHELL  |  mobile-shell.js
   ──────────────────────────────────────────────────────────────────────
   Turns the desktop sidebar shell into a real mobile application shell:
   an off-canvas drawer, a top app bar that names the page, and a
   thumb-reachable bottom tab bar carrying the 3–4 things this particular
   user actually does.

   Why this exists
   ───────────────
   The previous mobile rule stacked the full sidebar above the content of
   every page. Measured on a 390×844 phone that put 1,409–1,585px of navy
   navigation in front of the first number on ten of ten pages sampled —
   roughly two full screens of menu — and made every page look identical
   on open, because the only thing above the fold was the menu.

   Design decisions worth knowing
   ──────────────────────────────
   · The tab bar is DERIVED from the same permission accessors sidebar.js
     uses (getMyPerms / getAllowedKPIDepts / getMyFormAccess / canViewMIS
     / canViewSales). No second copy of the access rules lives here, so a
     permission change in auth.js moves the tab bar with it.
   · Max 5 slots, last is always Menu. Past five a tab bar stops being
     scannable and becomes a second, worse menu (Tidwell).
   · Icons are inline SVG rather than lucide `data-lucide` placeholders,
     because the tab bar must paint on first frame even if the lucide CDN
     is slow — the nav is the one thing that cannot arrive late.
   · Everything degrades: if auth.js has not loaded, or the page has no
     .app-shell, this file does nothing and the page renders as before.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {

  const MOBILE_Q = '(max-width: 959px)';
  const isMobile = () => window.matchMedia(MOBILE_Q).matches;

  /* ── Inline icons (lucide geometry, 24×24 stroke) ─────────────────── */
  const ICONS = {
    home:     '<path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z"/>',
    kpi:      '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    entry:    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15h6"/>',
    approve:  '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 12 2 2 4-4"/>',
    mis:      '<path d="M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
    sales:    '<path d="M3 17 9 11l4 4 8-8"/><path d="M17 7h4v4"/>',
    trends:   '<path d="M3 3v18h18"/><path d="m7 14 3-4 4 3 5-7"/>',
    menu:     '<path d="M4 6h16M4 12h16M4 18h16"/>',
    close:    '<path d="M18 6 6 18M6 6l12 12"/>',
    swipe:    '<path d="M8 12h8"/><path d="m12 8 4 4-4 4"/>',
  };

  const svg = (name, size) =>
    `<svg viewBox="0 0 24 24" width="${size || 22}" height="${size || 22}" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;

  /* ── Environment helpers ──────────────────────────────────────────── */
  const inForms  = () => window.location.pathname.includes('/forms/');
  const base     = () => (inForms() ? '../' : '');
  const currentPage = () => window.location.pathname.split('/').pop() || 'index.html';

  /* Safe accessor: auth.js exposes these as globals, but not every page
     loads every helper, and a missing one must never break the shell. */
  function call(fn, fallback) {
    try {
      return (typeof window[fn] === 'function') ? window[fn]() : fallback;
    } catch (_) {
      return fallback;
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     PAGE TITLE
     Document titles read "Lake Cement Ltd – Operations KPI Dashboard".
     The brand is already in the header; what the app bar owes the user
     is WHICH PAGE THIS IS, so strip the prefix and keep the rest.
     ══════════════════════════════════════════════════════════════════ */
  const TITLE_OVERRIDES = {
    'index.html':               ['KPI Dashboard',      'Operations'],
    'portal.html':              ['Home',               'Lake Cement'],
    'mis.html':                 ['MIS Dashboard',      'Management'],
    'daily-report.html':        ['Daily Report',       'Production'],
    'analytics.html':           ['Operational Summary','Analytics'],
    'approvals.html':           ['Approvals',          'Pending'],
    'sales.html':               ['Sales &amp; Dispatch', 'Commercial'],
    'purchases.html':           ['Raw Mat’ls &amp; Purchases', 'Commercial'],
    'reliability.html':         ['Reliability',        'Maintenance'],
    'mines-report.html':        ['Quarrying Report',   'Mining'],
    'power-plant-report.html':  ['Power Plant',        'CPP'],
    'balance.html':             ['Power &amp; Heat',   'Analysis'],
    'insights.html':            ['Stoppage Insights',  'Operations'],
    'completeness.html':        ['Entry Summary',      'Data Quality'],
    'memory.html':              ['Plant Memory',       'Search'],
    'reports-export.html':      ['Reports & Exports',  'MIS'],
    'monitor.html':             ['System Monitor',     'Admin'],
    'admin-users.html':         ['User Administration','Admin'],
  };

  function pageTitle() {
    const page = currentPage();
    if (TITLE_OVERRIDES[page]) return TITLE_OVERRIDES[page];

    let t = (document.title || 'Lake Cement').trim();
    t = t.replace(/^Lake\s+Cement(\s+Ltd\.?)?\s*[–—\-|]\s*/i, '');
    if (inForms()) return [t.replace(/\s*(Daily\s*)?Report$/i, '').trim() || t, 'Daily entry'];
    return [t, ''];
  }

  /* ══════════════════════════════════════════════════════════════════
     BOTTOM TAB BAR — role-derived
     ══════════════════════════════════════════════════════════════════ */
  function buildTabs() {
    const b = base();
    const tabs = [];

    /* Home is universal — it is the escape hatch from anywhere. */
    tabs.push({ icon: 'home', label: 'Home', href: b + 'portal.html', match: ['portal.html'] });

    /* KPI dashboard — only if this role can see any department. */
    const depts = call('getAllowedKPIDepts', []);
    const hasKPI = depts === 'all' || (Array.isArray(depts) && depts.length > 0);
    if (hasKPI) {
      tabs.push({ icon: 'kpi', label: 'KPIs', href: b + 'index.html', match: ['index.html'] });
    }

    /* Daily entry — only for a role that can actually fill something.
       For everyone else this slot would be a dead end. */
    const formAccess = call('getMyFormAccess', []);
    const canFill = Array.isArray(formAccess) && formAccess.length > 0;
    if (canFill) {
      tabs.push({
        icon: 'entry', label: 'Enter', href: b + 'forms/index.html',
        match: ['index.html'], matchDir: 'forms',
      });
    }

    /* Approvals — mirrors sidebar.js's own gate exactly. */
    const user = call('getCurrentUser', null);
    if (user) {
      const canApprove = user.role === 'admin' || user.role === 'md' ||
        (user.level === 'hod' && Array.isArray(formAccess) && formAccess.length > 0);
      if (canApprove && tabs.length < 4) {
        tabs.push({
          icon: 'approve', label: 'Approve', href: b + 'approvals.html',
          match: ['approvals.html'], badge: 'approvals',
        });
      }
    }

    /* Backfill any spare slot with whatever else this role leans on,
       so a view-only role does not get a two-item tab bar. */
    if (tabs.length < 4 && call('canViewMIS', false)) {
      tabs.push({ icon: 'mis', label: 'MIS', href: b + 'mis.html', match: ['mis.html'] });
    }
    if (tabs.length < 4 && call('canViewSales', false)) {
      tabs.push({ icon: 'sales', label: 'Sales', href: b + 'sales.html', match: ['sales.html'] });
    }
    if (tabs.length < 4 && hasKPI) {
      tabs.push({ icon: 'trends', label: 'Trends', href: b + 'analytics.html', match: ['analytics.html'] });
    }

    return tabs.slice(0, 4);
  }

  function isActiveTab(tab) {
    const page = currentPage();
    if (tab.matchDir === 'forms') return inForms() && tab.match.includes(page);
    if (inForms() && tab.matchDir !== 'forms') return false;
    return tab.match.includes(page);
  }

  function renderBottomNav() {
    if (document.querySelector('.ms-bottomnav')) return;
    const tabs = buildTabs();
    if (!tabs.length) return;

    const nav = document.createElement('nav');
    nav.className = 'ms-bottomnav';
    nav.setAttribute('aria-label', 'Primary');

    nav.innerHTML = tabs.map(t => {
      const active = isActiveTab(t);
      return `<a class="ms-bn-item${active ? ' active' : ''}" href="${t.href}"` +
             `${active ? ' aria-current="page"' : ''}` +
             `${t.badge ? ` data-badge="${t.badge}"` : ''}>` +
             `${svg(t.icon)}<span class="ms-bn-label">${t.label}</span></a>`;
    }).join('') +
    `<button type="button" class="ms-bn-item" id="msMenuTab" aria-controls="app-sidebar" aria-expanded="false">` +
    `${svg('menu')}<span class="ms-bn-label">Menu</span></button>`;

    document.body.appendChild(nav);
    nav.querySelector('#msMenuTab').addEventListener('click', () => toggleDrawer());
  }

  /* Pending-approval count — a number on the tab, not a bare dot, so it
     says how much work is waiting rather than merely that some is. */
  function loadApprovalBadge() {
    const slot = document.querySelector('.ms-bn-item[data-badge="approvals"]');
    if (!slot || typeof window.apiGet !== 'function') return;
    Promise.resolve(window.apiGet('/approvals/pending'))
      .then(res => {
        const list = Array.isArray(res) ? res : (res && (res.rows || res.data || res.pending));
        const n = Array.isArray(list) ? list.length : 0;
        if (!n) return;
        const b = document.createElement('span');
        b.className = 'ms-bn-badge';
        b.textContent = n > 99 ? '99+' : String(n);
        b.setAttribute('aria-label', `${n} report${n === 1 ? '' : 's'} awaiting approval`);
        slot.appendChild(b);
      })
      .catch(() => { /* a badge is a nicety; never surface its failure */ });
  }

  /* ══════════════════════════════════════════════════════════════════
     APP BAR — hamburger + page title
     ══════════════════════════════════════════════════════════════════ */
  function renderAppBar() {
    const header = document.getElementById('app-header') || document.querySelector('.top-header');
    if (!header || header.querySelector('.ms-menu-btn')) return;

    const left = header.querySelector('.header-left') || header;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ms-menu-btn';
    btn.id = 'msMenuBtn';
    btn.setAttribute('aria-label', 'Open navigation menu');
    btn.setAttribute('aria-controls', 'app-sidebar');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = svg('menu');
    btn.addEventListener('click', () => toggleDrawer());
    left.insertBefore(btn, left.firstChild);

    const [title, kicker] = pageTitle();
    const h = document.createElement('span');
    h.className = 'ms-title';
    h.innerHTML = (kicker ? `<small>${kicker}</small>` : '') + title;
    left.appendChild(h);

    /* Logout is hidden on mobile to save the width; the avatar becomes
       the way into the drawer, where Logout lives. */
    const avatar = header.querySelector('.auth-user-avatar');
    if (avatar) {
      avatar.setAttribute('role', 'button');
      avatar.setAttribute('tabindex', '0');
      avatar.setAttribute('aria-label', 'Open account menu');
      avatar.style.cursor = 'pointer';
      const open = e => { if (isMobile()) { e.preventDefault(); toggleDrawer(true); } };
      avatar.addEventListener('click', open);
      avatar.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') open(e);
      });
    }
  }

  function renderSkipLink() {
    if (document.querySelector('.ms-skip')) return;
    const main = document.querySelector('.main') || document.querySelector('main');
    if (!main) return;
    if (!main.id) main.id = 'ms-main';
    const a = document.createElement('a');
    a.className = 'ms-skip';
    a.href = '#' + main.id;
    a.textContent = 'Skip to main content';
    document.body.insertBefore(a, document.body.firstChild);
  }

  /* ══════════════════════════════════════════════════════════════════
     DRAWER
     ══════════════════════════════════════════════════════════════════ */
  let lastFocused = null;

  function scrim() {
    let s = document.querySelector('.ms-scrim');
    if (!s) {
      s = document.createElement('div');
      s.className = 'ms-scrim';
      s.setAttribute('aria-hidden', 'true');
      s.addEventListener('click', () => toggleDrawer(false));
      document.body.appendChild(s);
    }
    return s;
  }

  function drawerOpen() {
    const shell = document.querySelector('.app-shell');
    return !!(shell && shell.classList.contains('ms-drawer-open'));
  }

  function toggleDrawer(force) {
    const shell   = document.querySelector('.app-shell');
    const sidebar = document.getElementById('app-sidebar');
    if (!shell || !sidebar) return;

    const open = (typeof force === 'boolean') ? force : !drawerOpen();
    scrim();

    shell.classList.toggle('ms-drawer-open', open);
    document.body.classList.toggle('ms-drawer-open', open);

    sidebar.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) {
      sidebar.setAttribute('role', 'dialog');
      sidebar.setAttribute('aria-modal', 'true');
      sidebar.setAttribute('aria-label', 'Navigation menu');
    } else {
      sidebar.removeAttribute('role');
      sidebar.removeAttribute('aria-modal');
    }

    document.querySelectorAll('#msMenuBtn, #msMenuTab').forEach(b =>
      b.setAttribute('aria-expanded', open ? 'true' : 'false'));

    if (open) {
      lastFocused = document.activeElement;
      const first = sidebar.querySelector('.sb-item, button, a');
      if (first) setTimeout(() => first.focus({ preventScroll: true }), 60);
    } else if (lastFocused && typeof lastFocused.focus === 'function') {
      lastFocused.focus({ preventScroll: true });
      lastFocused = null;
    }
  }

  /* Focus trap + Esc. A drawer the keyboard can walk out of behind the
     scrim is worse than no drawer. */
  function wireDrawerKeys() {
    document.addEventListener('keydown', e => {
      if (!drawerOpen()) return;

      if (e.key === 'Escape') { e.preventDefault(); toggleDrawer(false); return; }
      if (e.key !== 'Tab') return;

      const sidebar = document.getElementById('app-sidebar');
      if (!sidebar) return;
      const focusables = sidebar.querySelectorAll(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last  = focusables[focusables.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      } else if (!sidebar.contains(document.activeElement)) {
        e.preventDefault(); first.focus();
      }
    });
  }

  /* Swipe-left on the drawer closes it. Deliberately NOT edge-swipe to
     open: that collides with the iOS back gesture and would make the
     browser and the app fight over the same stroke. */
  function wireSwipe() {
    const sidebar = document.getElementById('app-sidebar');
    if (!sidebar) return;
    let x0 = null, y0 = null;

    sidebar.addEventListener('touchstart', e => {
      if (!drawerOpen() || e.touches.length !== 1) return;
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
    }, { passive: true });

    sidebar.addEventListener('touchend', e => {
      if (x0 === null) return;
      const t  = e.changedTouches[0];
      const dx = t.clientX - x0;
      const dy = Math.abs(t.clientY - y0);
      /* Horizontal intent only, so a vertical scroll of a long menu is
         never mistaken for a dismissal. */
      if (dx < -55 && dy < 45) toggleDrawer(false);
      x0 = y0 = null;
    }, { passive: true });
  }

  /* Repurpose the desktop collapse toggle as the drawer's close button
     while we are on mobile, and put it back on resize. */
  function adaptSidebarToggle() {
    const t = document.getElementById('sidebarToggle');
    if (!t) return;
    if (isMobile()) {
      t.innerHTML = svg('close', 16);
      t.setAttribute('aria-label', 'Close navigation menu');
      t.title = 'Close menu';
      t.onclick = null;
      if (!t.dataset.msWired) {
        t.addEventListener('click', e => {
          if (!isMobile()) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          toggleDrawer(false);
        }, true);
        t.dataset.msWired = '1';
      }
    } else {
      t.title = 'Collapse / expand menu';
      t.setAttribute('aria-label', 'Collapse or expand menu');
      if (!t.onclick) t.setAttribute('onclick', 'toggleSidebar()');
    }
  }

  /* Any nav click inside the drawer should close it — on a phone the
     page underneath is about to change anyway, and leaving the drawer
     open over the new page is disorienting. */
  function wireDrawerDismissOnNav() {
    const sidebar = document.getElementById('app-sidebar');
    if (!sidebar) return;
    sidebar.addEventListener('click', e => {
      if (!isMobile() || !drawerOpen()) return;
      const item = e.target.closest('.sb-item');
      if (!item || item.id === 'sidebarToggle') return;
      /* Same-page dept switches (onclick handlers) need the drawer gone
         to reveal the section they just switched to. */
      setTimeout(() => toggleDrawer(false), 10);
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     WIDE-TABLE SCROLL AFFORDANCE
     Wide grids stay wide — a 40-column shift report is a grid, and
     stacking it into cards destroys the row-to-row comparison it exists
     for. What was missing is any sign that more columns are off-screen.
     ══════════════════════════════════════════════════════════════════ */
  function wireScrollAffordance() {
    /* Found by COMPUTED OVERFLOW, not by a list of class names — the same
       correction a11y.js already made for the same reason. The class list
       (.table-wrapper, .rt-wrap, .tbl-scroll, [data-scroll-x]) covered the
       wrappers somebody remembered to name and missed .adm-wrap on the
       user-administration table, which hides 157px of columns at 1440px
       with nothing on screen to say so. Anything that actually scrolls
       sideways gets the fade, whoever wrote it and whatever they called
       the div. */
    const named = document.querySelectorAll('.table-wrapper, .rt-wrap, .tbl-scroll, [data-scroll-x]');
    const found = new Set(named);
    document.querySelectorAll('div, section, main, td, li').forEach(el => {
      if (found.has(el) || el.dataset.msScroll) return;
      const ox = getComputedStyle(el).overflowX;
      if (ox !== 'auto' && ox !== 'scroll') return;
      if (el.scrollWidth - el.clientWidth <= 1) return;
      found.add(el);
    });

    found.forEach(w => {
      if (w.dataset.msScroll) return;
      /* A grid that mobile-entry.js has replaced with cards is hidden, and
         telling someone to swipe a table they cannot see is worse than
         saying nothing. */
      if (w.classList.contains('me-hidden')) return;
      w.dataset.msScroll = '1';
      /* An element that already carries a positioning scheme (the section
         tab bar is `position: sticky`) must keep it — the fades only need
         SOME containing block, and a positioned element already is one. */
      if (getComputedStyle(w).position !== 'static') w.classList.add('ms-positioned');
      w.classList.add('ms-scroll-x');

      /* The hint is spent once per browser, so it must never be spent on a
         table that does not scroll. Deciding at wire-up time did exactly
         that: most of these tables are API-driven, and the wrapper is
         briefly wider than its content before the rows arrive — on
         Approvals, whose result was an empty state with no table at all,
         the reader got "Swipe the table sideways to see all columns"
         above a card saying "Nothing waiting on you", and that was the
         only swipe hint they would ever be shown. The decision now rides
         on the same settled re-checks the fades use, and the flag is set
         only when a hint is really placed. */
      const maybeHint = () => {
        if (w.dataset.msHinted) return;
        if (w.scrollWidth - w.clientWidth <= 40) return;
        if (!w.querySelector('table')) return;
        try { if (localStorage.getItem('lcl_swipe_hint_seen')) { w.dataset.msHinted = '1'; return; } } catch (_) {}
        w.dataset.msHinted = '1';
        const hint = document.createElement('div');
        hint.className = 'ms-swipe-hint ms-show';
        hint.innerHTML = svg('swipe', 15) + '<span>Swipe the table sideways to see all columns</span>';
        w.parentNode.insertBefore(hint, w);
        try { localStorage.setItem('lcl_swipe_hint_seen', '1'); } catch (_) {}
      };

      const update = () => {
        const more = w.scrollWidth - w.clientWidth - w.scrollLeft > 4;
        const prev = w.scrollLeft > 4;
        w.classList.toggle('ms-has-more', more);
        w.classList.toggle('ms-has-prev', prev);
      };
      w.addEventListener('scroll', update, { passive: true });
      window.addEventListener('resize', update);
      update();
      /* Late-rendered tables (most of them are API-driven) need a second
         look — and the hint is decided ONLY from these settled passes,
         never from the synchronous one above, because at wire-up the
         wrapper is routinely wider than the rows it has not received. */
      setTimeout(() => { update(); maybeHint(); }, 900);
      setTimeout(() => { update(); maybeHint(); }, 2500);
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     FILTER BAR — progressive disclosure on mobile
     ──────────────────────────────────────────────────────────────────
     The KPI dashboard's filter bar is three full-width selects plus a
     print button. Once every control is a 44px touch target — which it
     must be — that stack is roughly 250px, and it sits above the data
     on every visit even though the period changes maybe once a session.

     So it collapses to one line that STATES the current period and
     expands on tap. The summary is not a label reading "Filters": it
     reads "July 2026 · Current Month", so the collapsed state carries
     the answer to the question the controls exist to answer (Tidwell:
     a collapsed panel must still say what it is set to). Desktop keeps
     all three controls open — there is room, and an analyst changes
     period constantly.
     ══════════════════════════════════════════════════════════════════ */
  function summariseFilters(group) {
    const parts = [];
    group.querySelectorAll('select').forEach(sel => {
      const opt = sel.options[sel.selectedIndex];
      if (!opt) return;
      let t = (opt.textContent || '').trim();
      /* "FY 2026–27 (Apr'26–Mar'27)" carries its own explanation; the
         summary line only has room for the identity. */
      t = t.replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (t && t !== '—') parts.push(t);
    });
    return parts.length ? parts.join(' · ') : 'Set period';
  }

  function wireFilterCollapse() {
    const inner = document.querySelector('.filter-bar .filter-inner');
    if (!inner || inner.dataset.msFilters) return;
    const group = inner.querySelector('.filter-group');
    if (!group || !group.querySelector('select')) return;

    inner.dataset.msFilters = '1';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ms-fb-toggle';
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML =
      '<span class="ms-fb-label"></span>' +
      '<svg class="ms-fb-caret" viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
      'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

    const label = btn.querySelector('.ms-fb-label');
    const sync  = () => { label.textContent = summariseFilters(group); };
    sync();

    /* The selects are re-populated from the API after load
       (buildFiscalYearOptions, applyLatestPeriodFallback), so the
       summary has to follow them rather than be read once. */
    group.addEventListener('change', sync);
    setTimeout(sync, 1200);
    setTimeout(sync, 3000);

    btn.addEventListener('click', () => {
      const open = inner.classList.toggle('ms-filters-open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) sync();
    });

    inner.insertBefore(btn, inner.firstChild);
    inner.classList.add('ms-filters-collapsible');
  }

  /* ══════════════════════════════════════════════════════════════════
     HORIZONTAL STRIP SAFETY NET
     design-system.css names the control strips that overflow today
     (.mis-tabs, .period-strip, .view-switcher). This catches the ones
     added tomorrow: any single-row flex strip whose content is wider
     than it is becomes a scrollable strip instead of spilling off the
     right edge, where body{overflow-x:hidden} would silently eat it.
     ══════════════════════════════════════════════════════════════════ */
  function wireHScrollStrips() {
    if (!isMobile()) return;
    const main = document.querySelector('.main');
    if (!main) return;

    main.querySelectorAll('div, nav, ul, header, section').forEach(el => {
      if (el.dataset.msStrip || el.classList.contains('ms-hscroll')) return;

      /* A card's computed read-back strip is a set of label/value pairs,
         not a toolbar. Turning it into a sideways scroller hid values and
         created a keyboard-unreachable scroll region. */
      if (el.closest('.me-derived, .me-card')) return;

      const cs = getComputedStyle(el);
      if (cs.display !== 'flex' && cs.display !== 'inline-flex') return;
      if (cs.flexDirection.startsWith('column')) return;
      if (cs.flexWrap === 'wrap') return;                    /* wrapping is its own answer */
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return;  /* already handled */
      if (el.children.length < 2) return;

      /* Only intervene when it genuinely does not fit. */
      if (el.scrollWidth <= el.clientWidth + 8) return;

      /* A strip taller than a couple of rows is a layout, not a toolbar;
         converting it to a sideways scroller would hide content. */
      if (el.getBoundingClientRect().height > 130) return;

      el.dataset.msStrip = '1';
      el.classList.add('ms-hscroll');
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     BOOT
     ══════════════════════════════════════════════════════════════════ */
  function init() {
    if (!document.querySelector('.app-shell')) return;   /* login/set-password */

    renderSkipLink();
    renderAppBar();
    renderBottomNav();
    adaptSidebarToggle();
    wireDrawerKeys();
    wireSwipe();
    wireDrawerDismissOnNav();
    wireScrollAffordance();
    wireHScrollStrips();
    wireFilterCollapse();
    loadApprovalBadge();

    /* Crossing the breakpoint with the drawer open would leave the
       desktop sidebar in a modal state. Close it on the way through. */
    const mq = window.matchMedia(MOBILE_Q);
    const onChange = () => {
      if (!isMobile() && drawerOpen()) toggleDrawer(false);
      adaptSidebarToggle();
      wireHScrollStrips();
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);

    /* Tables usually arrive after the first API round-trip. */
    const mo = new MutationObserver(() => { wireScrollAffordance(); wireHScrollStrips(); });
    const main = document.querySelector('.main') || document.body;
    mo.observe(main, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* Exposed for pages that re-render the header or sidebar themselves. */
  window.msToggleDrawer = toggleDrawer;
  window.msRefreshShell = init;
})();
