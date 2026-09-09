/* ══════════════════════════════════════════════════════════════════════
   Lake Cement Ltd — ACCESSIBLE NAMES  |  a11y.js
   ──────────────────────────────────────────────────────────────────────
   Gives the two things a WCAG 2.2 AA audit found missing across the app
   and that no amount of CSS can supply: an accessible name for every
   form control, and keyboard reach into every scrollable region.

   The problem it solves
   ─────────────────────
   axe-core reported 400 unlabelled form controls on 11 pages and 20
   selects with no accessible name. Not an oversight so much as a
   consequence of the shape: in a shift grid a field's meaning comes from
   its row heading ("LSF") and its column heading ("04:00–08:00"). A
   sighted officer reads both at a glance. A screen reader announces
   "edit text, blank" — 84 times, identically, on one report.

   So the name is composed from exactly what a sighted user reads:
   row heading, then column heading, then any unit or spec hint.
     -> "LSF, 04:00–08:00" ... "Blaine (Fineness), 42.5 R Day Avg"

   Two rules it holds to
   ─────────────────────
   1. It only ever FILLS A GAP. An aria-label overrides the visible label
      for screen-reader users, so a control that already has a real label
      — wrapped, `for`-associated, aria-labelled — is left alone. Names it
      adds are marked `data-a11y-name`, and withdrawn if a real label
      appears later (which is what happens when mobile-entry.js moves a
      field into a <label> card on a phone).
   2. It never invents. If nothing in the DOM names the control, it adds
      nothing rather than guessing — a wrong name is worse than none.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

var LCL_A11Y = (function () {

  var CTRL = 'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]),' +
             ' select, textarea';

  function squash(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  /* ══════════════════════════════════════════════════════════════════
     HEADER MATRIX
     A <thead> with rowspan and colspan cannot be read by column index:
     dispatch-form.html stacks "Regular Bags" / "42.5 R" / "On Date"
     across three rows, and the leaf "On Date" appears thirteen times
     meaning something different each time. This walks the header the way
     a browser does and returns, per column, the headings covering it.

     Shared deliberately: forms/mobile-entry.js needs the same answer for
     its card labels and calls this rather than keeping a second copy of
     a subtle algorithm.
     ══════════════════════════════════════════════════════════════════ */
  function headerMatrix(table) {
    var thead = table.tHead;
    if (!thead) return [];

    var grid = [];
    Array.prototype.forEach.call(thead.rows, function (tr, r) {
      var c = 0;
      Array.prototype.forEach.call(tr.cells, function (th) {
        while (grid[r] && grid[r][c]) c++;
        var rs = th.rowSpan || 1, cs = th.colSpan || 1;
        for (var dr = 0; dr < rs; dr++) {
          var rr = r + dr;
          grid[rr] = grid[rr] || [];
          for (var dc = 0; dc < cs; dc++) grid[rr][c + dc] = th;
        }
        c += cs;
      });
    });

    var width = grid.reduce(function (m, row) { return Math.max(m, row ? row.length : 0); }, 0);
    var cols = [];
    for (var c2 = 0; c2 < width; c2++) {
      var parts = [], seen = null;
      for (var r2 = 0; r2 < grid.length; r2++) {
        var th = grid[r2] && grid[r2][c2];
        if (!th || th === seen) continue;
        seen = th;
        var txt = headerText(th);
        if (txt) parts.push(txt);
      }
      cols.push(parts);
    }
    return cols;
  }

  /* Text of a cell, with <br> read as a space.
     textContent ignores <br> entirely, and 84 headers in this app use one
     as a line break — which is how "Moisture<br>On Date" was being read as
     "MoistureOn Date", and "Opening<br>Stock" as "OpeningStock", in both
     card labels and screen-reader names. */
  function cellText(el) {
    if (!el) return '';
    var clone = el.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('.spec-range, .unit'), function (n) {
      n.parentNode.removeChild(n);
    });
    Array.prototype.forEach.call(clone.querySelectorAll('br'), function (n) {
      n.parentNode.replaceChild(document.createTextNode(' '), n);
    });
    return squash(clone.textContent);
  }

  function headerText(th) { return cellText(th); }

  /* ══════════════════════════════════════════════════════════════════
     DOES IT ALREADY HAVE A NAME?
     ══════════════════════════════════════════════════════════════════ */
  function hasRealName(el) {
    if (el.getAttribute('aria-label') && !el.hasAttribute('data-a11y-name')) return true;
    var lb = el.getAttribute('aria-labelledby');
    if (lb && lb.split(/\s+/).some(function (id) { return document.getElementById(id); })) return true;
    if (el.closest('label')) return true;
    if (el.id) {
      try {
        if (document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]')) return true;
      } catch (_) { /* an id that cannot be escaped is not one we can match */ }
    }
    if (squash(el.getAttribute('title'))) return true;
    return false;
  }

  /* ══════════════════════════════════════════════════════════════════
     COMPOSE A NAME
     ══════════════════════════════════════════════════════════════════ */
  function nameFromTable(el) {
    var td = el.closest('td, th');
    if (!td) return '';
    var tr = td.parentElement;
    var table = el.closest('table');
    if (!tr || !table) return '';

    /* The row's own heading is its first cell — the label column. */
    var head = tr.cells[0];
    var rowLabel = (head && head !== td) ? cellText(head) : '';

    /* Column index has to account for colspan on the way across. */
    var ci = 0, found = -1;
    for (var i = 0; i < tr.cells.length; i++) {
      if (tr.cells[i] === td) { found = ci; break; }
      ci += tr.cells[i].colSpan || 1;
    }
    var cols = headerMatrix(table);
    var colParts = (found > -1 && cols[found]) ? cols[found] : [];

    var parts = [];
    if (rowLabel) parts.push(rowLabel);
    if (colParts.length) parts.push(colParts.join(' '));
    return parts.join(', ');
  }

  /* Outside a table: the visible thing sitting next to the control. */
  function nameFromNeighbours(el) {
    var group = el.closest('.tb-group, .filter-card, .field, .form-row, .me-field');
    if (group) {
      var lbl = group.querySelector('.tb-lbl, label, .field-label, .filter-card > label');
      if (lbl && !lbl.contains(el)) {
        var t = squash(lbl.textContent);
        if (t) return t;
      }
    }
    /* Walk back through siblings, then up a couple of levels and back
       again. purchases.html puts two selects inside a <span> whose only
       clue is the section title one level up — the first version of this
       stopped at the sibling list and named neither. */
    var node = el;
    for (var up = 0; up < 3 && node; up++) {
      var prev = node.previousElementSibling;
      while (prev) {
        if (!prev.querySelector || !prev.querySelector(CTRL)) {
          var pt = squash(prev.textContent);
          if (pt && pt.length < 60) return pt;
        }
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
      if (node && (node === document.body || node.classList.contains('main'))) break;
    }
    return '';
  }

  function composeName(el) {
    var n = nameFromTable(el);
    if (!n) n = nameFromNeighbours(el);
    if (!n) n = squash(el.getAttribute('placeholder'));
    if (!n) {
      /* data-field is a machine key, but "coal_ncv" read aloud still
         beats "edit text, blank" — and it is what the officer's own
         spreadsheet calls the column. */
      var f = el.getAttribute('data-field') || el.getAttribute('name');
      if (f) n = f.replace(/[_-]+/g, ' ').trim();
    }
    return squash(n).slice(0, 120);
  }

  function nameControls(scope) {
    (scope || document).querySelectorAll(CTRL).forEach(function (el) {
      if (hasRealName(el)) {
        /* A real label appeared (mobile-entry moved it into a card):
           withdraw ours so the visible text is what gets announced. */
        if (el.hasAttribute('data-a11y-name')) {
          el.removeAttribute('aria-label');
          el.removeAttribute('data-a11y-name');
        }
        return;
      }
      var n = composeName(el);
      if (!n) return;                       /* never invent a name */
      el.setAttribute('aria-label', n);
      el.setAttribute('data-a11y-name', '1');
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     SCROLLABLE REGIONS
     A region that scrolls but holds no focusable content is unreachable
     by keyboard — you can see there is more table to the right and have
     no way to get there. Making it focusable is the standard remedy;
     naming it is what makes the stop worth landing on.
     ══════════════════════════════════════════════════════════════════ */
  function nameScrollRegions(scope) {
    /* Found by COMPUTED OVERFLOW, not by a list of class names. The first
       version listed the wrappers this app happened to use and missed
       .rl-rcfa-more-scroll, .cp-table-wrap and an anonymous div inside
       every equipment card — the ones nobody remembered to add. */
    var root = scope || document;
    var all = root.querySelectorAll('div, section, main, aside, td, li, article');
    Array.prototype.forEach.call(all, function (w) {
      if (w.dataset.a11yScroll) return;
      var cs = getComputedStyle(w);
      var scrolls = /(auto|scroll)/.test(cs.overflowX) || /(auto|scroll)/.test(cs.overflowY);
      if (!scrolls) return;
      /* 1px, not 4. axe flags a region the moment it actually scrolls, so
         a 4px grace band left a window — a table overflowing its wrapper
         by two or three pixels was unreachable by keyboard and reported
         as such, while this pass walked past it. Any padding change
         anywhere can slide a table into that window, which is how it was
         found. 1px absorbs sub-pixel rounding and nothing else. */
      if (w.scrollWidth <= w.clientWidth + 1 && w.scrollHeight <= w.clientHeight + 1) return;
      /* Disabled controls are not focusable, so a wrapper holding only
         disabled inputs — every form a role does not own — is still
         unreachable. This is what axe was flagging and the first
         version of this check was missing. */
      if (w.querySelector('a[href], button:not([disabled]), input:not([disabled]),' +
                          ' select:not([disabled]), textarea:not([disabled]),' +
                          ' [tabindex]:not([tabindex="-1"])')) return;

      w.dataset.a11yScroll = '1';
      w.setAttribute('tabindex', '0');
      w.setAttribute('role', 'region');

      var heading = '';
      var sec = w.closest('section, .mis-section, .in-card, .fm-section, article');
      if (sec) {
        var h = sec.querySelector('h1, h2, h3, h4, .sec-title, .in-section-title, .mis-sec-title, .fm-sec-title');
        if (h) heading = squash(h.textContent).slice(0, 80);
      }
      w.setAttribute('aria-label', heading ? heading + ' — scrollable table' : 'Scrollable table');
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     BOOT
     Tables and toolbars are API-driven and arrive after first paint, so
     this runs again on mutation rather than once.
     ══════════════════════════════════════════════════════════════════ */
  var pending = null;
  function refresh() {
    try { nameControls(); } catch (_) {}
    try { nameScrollRegions(); } catch (_) {}
  }
  function schedule() {
    if (pending) return;
    pending = setTimeout(function () { pending = null; refresh(); }, 250);
  }

  function init() {
    refresh();
    [600, 1500, 3000].forEach(function (t) { setTimeout(refresh, t); });

    var target = document.querySelector('.main') || document.body;
    if (target && window.MutationObserver) {
      new MutationObserver(schedule).observe(target, { childList: true, subtree: true });
    }
    window.addEventListener('resize', schedule);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { headerMatrix: headerMatrix, cellText: cellText, refresh: refresh, nameControls: nameControls };
})();
