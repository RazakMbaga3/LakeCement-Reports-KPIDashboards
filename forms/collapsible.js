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

  function init() {
    document.querySelectorAll('.rcard').forEach((rcard, i) => {
      const key  = 'rcard-' + (rcard.id || i);
      const body = wrapBody(rcard);
      if (!body) return;
      addToggle(rcard, body, key);

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
