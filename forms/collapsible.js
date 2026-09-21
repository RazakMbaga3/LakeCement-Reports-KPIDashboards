/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — Collapsible Report Card Sections
   ─────────────────────────────────────────────────────────────────
   Auto-wires a collapse/expand toggle chevron on every .rcard-hdr.
   Wraps card content in .rcard-body for CSS animation.
   State is preserved in sessionStorage so expanding/collapsing
   survives tab switches within the same session.
   ══════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const CHEVRON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" xmlns="http://www.w3.org/2000/svg">' +
    '<polyline points="6 9 12 15 18 9"></polyline></svg>';

  function wrapBody(rcard) {
    /* collect all children after the header */
    const hdr = rcard.querySelector('.rcard-hdr');
    if (!hdr) return null;
    if (rcard.querySelector('.rcard-body')) return rcard.querySelector('.rcard-body');

    const body = document.createElement('div');
    body.className = 'rcard-body';

    /* move all sibling nodes after hdr into body */
    const children = [...rcard.childNodes];
    let past = false;
    children.forEach(node => {
      if (node === hdr) { past = true; return; }
      if (past) body.appendChild(node);
    });

    rcard.appendChild(body);
    /* set an explicit max-height so CSS transition works */
    body.style.maxHeight = body.scrollHeight + 'px';

    /* ...and keep it in sync with content that arrives AFTER init. The
       height used to be measured exactly once, so any card filled in
       asynchronously stayed clipped to whatever it measured while empty —
       the stoppage form's reason catalogue is fetched, so all seven of its
       section cards rendered as a 50px header with 2,000px of rows hidden
       under `overflow:hidden`. Guarded against re-entry: writing
       maxHeight resizes `body` and so re-fires the observer, which then
       computes the same value and stops. */
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () {
        if (rcard.classList.contains('collapsed')) return;
        const h = body.scrollHeight + 'px';
        if (body.style.maxHeight !== h) body.style.maxHeight = h;
      }).observe(body);
    }
    return body;
  }

  function addToggle(rcard, body, key) {
    const hdr = rcard.querySelector('.rcard-hdr');
    if (!hdr || hdr.querySelector('.rcard-toggle')) return;

    const btn = document.createElement('button');
    btn.className    = 'rcard-toggle';
    btn.title        = 'Collapse / Expand section';
    btn.innerHTML    = CHEVRON_SVG;
    btn.setAttribute('aria-expanded', 'true');

    /* insert as last child of header */
    hdr.appendChild(btn);

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const collapsed = rcard.classList.toggle('collapsed');
      btn.setAttribute('aria-expanded', !collapsed);
      if (!collapsed) {
        /* re-measure after uncollapsing so the height is correct */
        body.style.maxHeight = body.scrollHeight + 'px';
      }
      try { sessionStorage.setItem(key, collapsed ? '1' : '0'); } catch (_) {}
    });
  }

  /* ── Auto-color rcard header by icon type ─────────────────── */
  const ICON_COLOR = {
    /* Quality / Lab */
    'flask-conical': 'rch-green', 'test-tube': 'rch-green', 'microscope': 'rch-green',
    /* Stoppages / Alerts */
    'alert-triangle': 'rch-red',  'triangle-alert': 'rch-red', 'siren': 'rch-red',
    /* Dispatch / Logistics */
    'truck': 'rch-orange', 'box': 'rch-orange', 'shopping-cart': 'rch-orange',
    /* Materials / Stores */
    'package': 'rch-orange', 'warehouse': 'rch-orange',
    /* Power / Energy */
    'activity': 'rch-teal', 'zap': 'rch-teal', 'gauge': 'rch-teal',
    'battery-charging': 'rch-teal', 'plug': 'rch-teal',
    /* Pile Quality / Geology */
    'layers': 'rch-purple', 'mountain': 'rch-purple', 'gem': 'rch-purple',
  };

  function colorHeader(rcard) {
    const hdr  = rcard.querySelector('.rcard-hdr');
    if (!hdr) return;
    const icon = hdr.querySelector('[data-lucide]');
    if (!icon) return;
    const name = icon.getAttribute('data-lucide');
    const cls  = ICON_COLOR[name];
    if (cls) hdr.classList.add(cls);
  }

  function init() {
    document.querySelectorAll('.rcard').forEach((rcard, i) => {
      const key  = 'rcard-' + (rcard.id || i);
      const body = wrapBody(rcard);
      if (!body) return;
      addToggle(rcard, body, key);
      colorHeader(rcard);

      /* Restore previous collapse state */
      try {
        if (sessionStorage.getItem(key) === '1') {
          rcard.classList.add('collapsed');
          const btn = rcard.querySelector('.rcard-toggle');
          if (btn) btn.setAttribute('aria-expanded', 'false');
        }
      } catch (_) {}
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

}());
