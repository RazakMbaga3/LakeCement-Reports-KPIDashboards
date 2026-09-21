/* ═══════════════════════════════════════════════════════════════════
   Lake Cement Ltd — In-Page Report Switcher  |  report-switcher.js
   ─────────────────────────────────────────────────────────────────
   2026-09-16: Quality/Lab+Limestone %, Dispatch & SO+Sales Projection,
   and Equipment Reliability+Stoppage Insights each collapsed from two
   sidebar rows into one (sidebar.js) — the plant head asked for one tab
   per report, with the second report reached by an in-page switcher
   instead of a second nav row.

   This does NOT merge the underlying forms/pages — each secondary report
   keeps its own submit flow, its own permission checks, its own URL. It's
   embedded here via <iframe> so nothing about it has to be rebuilt; the
   switcher just decides which one is on screen.

   Usage: call initReportSwitcher() once per host page, after auth.js has
   run (so getCurrentUser()/getDailyAccessFor() are available):

     initReportSwitcher({
       nativeLabel: 'Quality / Lab', nativeIcon: 'flask-conical',
       nativeSelector: '.toolbar, .fm-main',
       secondary: [{ label:'Limestone %', icon:'mountain',
                     page:'limestone-form.html', href:'limestone-form.html' }],
     });

   `nativeSelector` is a CSS selector (comma-separated for multiple
   siblings) matching the host page's own existing content — hidden in
   place (not reparented, so sticky/fixed positioning inside it survives)
   when a secondary tab is active.

   `secondary[].page`, when given, is checked against the CURRENT USER's
   own _DAILY_ACCESS nav list — omit it for a pair with no separate access
   rule (Reliability & Stoppage: both always visible together under
   hasKPI, neither is in _DAILY_ACCESS at all). Sales & Dispatch DOES pass
   `page`, because Dispatch & SO and Sales Projection are reachable by
   disjoint role sets today (logistics/packing get Dispatch, sales gets
   Projection, neither role has both) — a role that lacks the secondary
   page must not be shown a tab for it, on a direct URL visit and not only
   from the sidebar (which already wouldn't have merged the row for them).
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

function initReportSwitcher(opts) {
  const user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
  if (!user) return;
  const access = typeof getDailyAccessFor === 'function' ? getDailyAccessFor(user.role) : null;
  const canReach = page => {
    if (!page) return true; // no access rule tied to this pairing — always visible
    if (!access) return true;
    return access.nav === 'all' || access.nav.includes(page);
  };

  const visibleSecondary = (opts.secondary || []).filter(s => canReach(s.page));
  if (!visibleSecondary.length) return; // nothing to switch to — leave the page exactly as it was

  const firstNativeEl = document.querySelector(opts.nativeSelector);
  if (!firstNativeEl) return;

  const tabs = [{ label: opts.nativeLabel, icon: opts.nativeIcon, key: 'native' }]
    .concat(visibleSecondary.map((s, i) => Object.assign({}, s, { key: 'sec' + i })));

  const bar = document.createElement('div');
  bar.className = 'rs-tabbar';
  bar.innerHTML = tabs.map((t, i) =>
    `<button type="button" class="rs-tab${i === 0 ? ' active' : ''}" data-rs-key="${t.key}">` +
    (t.icon ? `<i data-lucide="${t.icon}"></i>` : '') +
    `<span>${t.label}</span></button>`
  ).join('');
  firstNativeEl.parentNode.insertBefore(bar, firstNativeEl);

  const panels = {};
  visibleSecondary.forEach((s, i) => {
    const key = 'sec' + i;
    const panel = document.createElement('div');
    panel.className = 'rs-panel';
    panel.style.display = 'none';
    const iframe = document.createElement('iframe');
    iframe.className = 'rs-iframe';
    iframe.title = s.label;
    panel.appendChild(iframe);
    firstNativeEl.parentNode.insertBefore(panel, firstNativeEl);
    /* embed=1 tells the target page's own sidebar.js to hide its full
       app-shell chrome (aside + header) instead of nesting a second
       sidebar/header inside this page's own — see styles.css. */
    const src = s.href + (s.href.indexOf('?') === -1 ? '?' : '&') + 'embed=1';
    panels[key] = { iframe, panel, src, loaded: false };
  });

  bar.addEventListener('click', function (e) {
    const btn = e.target.closest('.rs-tab');
    if (!btn) return;
    const key = btn.dataset.rsKey;

    bar.querySelectorAll('.rs-tab').forEach(b => b.classList.toggle('active', b === btn));
    /* Re-query on every click rather than reusing a list captured at init:
       some native content (e.g. mobile-entry.js's "N of M filled" bar) is
       inserted asynchronously and did not exist yet when initReportSwitcher
       ran, so a cached NodeList would silently miss it forever. Blanking
       style.display (not restoring a cached value) is safe because none of
       this content sets its own display inline — its normal appearance
       always comes from a CSS class, never a JS-set inline style. */
    document.querySelectorAll(opts.nativeSelector).forEach(el => {
      el.style.display = key === 'native' ? '' : 'none';
    });
    Object.keys(panels).forEach(k => {
      const p = panels[k];
      p.panel.style.display = k === key ? '' : 'none';
      if (k === key && !p.loaded) { p.iframe.src = p.src; p.loaded = true; }
    });
  });

  if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons();
}
