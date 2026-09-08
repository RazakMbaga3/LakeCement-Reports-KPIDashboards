/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — Custom Date Picker
   ─────────────────────────────────────────────────────────────────
   The browser's native <input type="date"> calendar popup is tiny,
   can't be restyled, and gives no fast way to jump between months —
   painful for a report where people regularly browse back across a
   whole quarter. This replaces the POPUP only; the underlying
   <input type="date"> stays exactly as it was (same data-field, same
   value format, same 'change' event), so every existing page that
   reads/writes it (form-persist.js, report-loader.js, this app's own
   inline scripts) keeps working with zero changes.

   How it works: every input[type="date"] on the page is made
   `readonly` (which suppresses Chrome/Edge/Firefox's native popup
   without blocking programmatic .value / dispatchEvent, and without
   removing it from the tab order) and gets a click/focus handler that
   opens this custom panel instead. Selecting a day sets the input's
   value and fires a real 'change' event, then closes the panel —
   from the rest of the app's point of view, nothing is different
   about how the date field behaves.

   Usage: just include the script. No init call needed — it finds
   every input[type="date"] on the page itself, immediately and via
   a MutationObserver for any added later (e.g. inline-edit panels).
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var MONTH_NAMES = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
  var WEEKDAYS = ['Mo','Tu','We','Th','Fr','Sa','Su'];

  var panel = null;      // the single shared popup, reused for every input
  var activeInput = null;
  var viewYear, viewMonth;   // 0-indexed month, the calendar currently being *shown*
  var mode = 'days';         // 'days' | 'months'

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function isoOf(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }
  function todayParts() {
    var t = new Date();
    return { y: t.getFullYear(), m: t.getMonth(), d: t.getDate() };
  }

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.className = 'ndp-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Choose a date');
    panel.tabIndex = -1;
    document.body.appendChild(panel);

    document.addEventListener('mousedown', function (e) {
      if (!panel || panel.style.display === 'none') return;
      if (panel.contains(e.target) || (activeInput && activeInput.contains(e.target))) return;
      close();
    });
    document.addEventListener('keydown', function (e) {
      if (!panel || panel.style.display === 'none') return;
      if (e.key === 'Escape') { close(); activeInput && activeInput.focus(); }
    });
    window.addEventListener('resize', function () { if (panel.style.display !== 'none') position(); });
    window.addEventListener('scroll', function () { if (panel.style.display !== 'none') position(); }, true);
    return panel;
  }

  function position() {
    var r = activeInput.getBoundingClientRect();
    var pw = panel.offsetWidth || 360;
    var left = r.left + window.scrollX;
    // keep on-screen if the input is near the right edge
    if (left + pw > window.scrollX + document.documentElement.clientWidth - 8) {
      left = window.scrollX + document.documentElement.clientWidth - pw - 8;
    }
    panel.style.left = Math.max(8, left) + 'px';
    panel.style.top  = (r.bottom + window.scrollY + 6) + 'px';
  }

  function open(input) {
    ensurePanel();
    activeInput = input;
    var v = input.value; // YYYY-MM-DD
    var parts = v ? v.split('-').map(Number) : null;
    var t = todayParts();
    viewYear  = parts ? parts[0] : t.y;
    viewMonth = parts ? parts[1] - 1 : t.m;
    mode = 'days';
    panel.style.display = 'block';
    render();
    position();
  }

  function close() {
    if (panel) panel.style.display = 'none';
    activeInput = null;
  }

  function selectDay(y, m, d) {
    activeInput.value = isoOf(y, m, d);
    activeInput.dispatchEvent(new Event('change', { bubbles: true }));
    activeInput.dispatchEvent(new Event('input', { bubbles: true }));
    close();
  }

  function render() {
    panel.innerHTML = '';
    var header = document.createElement('div');
    header.className = 'ndp-hdr';

    var prev = button('‹', 'ndp-nav', function () { step(-1); });
    var next = button('›', 'ndp-nav', function () { step(1); });
    prev.setAttribute('aria-label', mode === 'days' ? 'Previous month' : 'Previous year');
    next.setAttribute('aria-label', mode === 'days' ? 'Next month' : 'Next year');

    var label = document.createElement('button');
    label.type = 'button';
    label.className = 'ndp-title';
    label.textContent = mode === 'days' ? (MONTH_NAMES[viewMonth] + ' ' + viewYear) : String(viewYear);
    label.onclick = function () { mode = (mode === 'days' ? 'months' : 'days'); render(); };

    header.appendChild(prev);
    header.appendChild(label);
    header.appendChild(next);
    panel.appendChild(header);

    if (mode === 'days') renderDays(); else renderMonths();

    var footer = document.createElement('div');
    footer.className = 'ndp-ftr';
    var t = todayParts();
    footer.appendChild(button('Today', 'ndp-link', function () { selectDay(t.y, t.m, t.d); }));
    footer.appendChild(button('Clear', 'ndp-link ndp-link-muted', function () {
      activeInput.value = '';
      activeInput.dispatchEvent(new Event('change', { bubbles: true }));
      close();
    }));
    panel.appendChild(footer);
  }

  function step(dir) {
    if (mode === 'days') {
      viewMonth += dir;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    } else {
      viewYear += dir;
    }
    render();
  }

  function button(text, cls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.onclick = onClick;
    return b;
  }

  function renderDays() {
    var wk = document.createElement('div');
    wk.className = 'ndp-weekdays';
    WEEKDAYS.forEach(function (w) {
      var s = document.createElement('span');
      s.textContent = w;
      wk.appendChild(s);
    });
    panel.appendChild(wk);

    var grid = document.createElement('div');
    grid.className = 'ndp-grid';

    var first = new Date(viewYear, viewMonth, 1);
    var startOffset = (first.getDay() + 6) % 7; // Monday-first
    var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    var daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();

    var t = todayParts();
    var selParts = activeInput.value ? activeInput.value.split('-').map(Number) : null;

    var cell = 0;
    for (; cell < startOffset; cell++) {
      grid.appendChild(dayCell(daysInPrevMonth - startOffset + cell + 1, true, false, false));
    }
    for (var d = 1; d <= daysInMonth; d++, cell++) {
      var isToday = (viewYear === t.y && viewMonth === t.m && d === t.d);
      var isSelected = selParts && selParts[0] === viewYear && selParts[1] - 1 === viewMonth && selParts[2] === d;
      grid.appendChild(dayCell(d, false, isToday, isSelected));
    }
    for (var trail = 1; cell < 42; cell++, trail++) {
      grid.appendChild(dayCell(trail, true, false, false));
    }
    panel.appendChild(grid);
  }

  function dayCell(num, muted, isToday, isSelected) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = num;
    b.className = 'ndp-day' + (muted ? ' ndp-day-muted' : '') + (isToday ? ' ndp-day-today' : '') + (isSelected ? ' ndp-day-sel' : '');
    if (!muted) {
      b.onclick = function () { selectDay(viewYear, viewMonth, num); };
    } else {
      b.tabIndex = -1;
      b.disabled = true;
    }
    return b;
  }

  function renderMonths() {
    var grid = document.createElement('div');
    grid.className = 'ndp-month-grid';
    var t = todayParts();
    MONTH_NAMES.forEach(function (name, idx) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = name.slice(0, 3);
      b.className = 'ndp-month' + (viewYear === t.y && idx === t.m ? ' ndp-day-today' : '') + (idx === viewMonth ? ' ndp-day-sel' : '');
      b.onclick = function () { viewMonth = idx; mode = 'days'; render(); };
      grid.appendChild(b);
    });
    panel.appendChild(grid);
  }

  var STYLE = '\
.ndp-panel{position:absolute;z-index:9999;display:none;width:352px;background:#fff;\
  border:1px solid var(--border,#DDE3EC);border-radius:var(--radius,6px);\
  box-shadow:var(--shadow-md,0 4px 16px rgba(0,0,0,.12));padding:16px;\
  font-family:"Inter",system-ui,sans-serif;user-select:none;}\
.ndp-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}\
.ndp-nav{width:36px;height:36px;border:1px solid var(--border,#DDE3EC);background:#fff;border-radius:8px;\
  font-size:18px;line-height:1;color:var(--navy,#173158);cursor:pointer;}\
.ndp-nav:hover{background:var(--off-white,#F7F8FA);border-color:var(--navy,#173158);}\
.ndp-title{border:none;background:none;font-size:16px;font-weight:800;color:var(--navy,#173158);\
  cursor:pointer;padding:6px 10px;border-radius:8px;}\
.ndp-title:hover{background:var(--off-white,#F7F8FA);}\
.ndp-weekdays{display:grid;grid-template-columns:repeat(7,1fr);margin-bottom:4px;}\
.ndp-weekdays span{text-align:center;font-size:12px;font-weight:700;letter-spacing:.4px;\
  color:var(--text-muted,#5A6270);text-transform:uppercase;padding:4px 0;}\
.ndp-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;}\
.ndp-day{aspect-ratio:1;border:none;background:none;border-radius:8px;font-size:14px;\
  font-weight:600;color:var(--navy,#173158);cursor:pointer;min-height:42px;}\
.ndp-day:hover:not(:disabled){background:var(--off-white,#F7F8FA);}\
.ndp-day-muted{color:#C3CAD6;cursor:default;}\
.ndp-day-today{box-shadow:inset 0 0 0 1.5px var(--orange,#F49545);}\
.ndp-day-sel{background:var(--navy,#173158)!important;color:#fff!important;font-weight:800;}\
.ndp-month-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:4px 0 6px;}\
.ndp-month{padding:14px 8px;border:none;border-radius:8px;background:var(--off-white,#F7F8FA);\
  font-size:14px;font-weight:700;color:var(--navy,#173158);cursor:pointer;}\
.ndp-month:hover{background:#E9EDF3;}\
.ndp-ftr{display:flex;justify-content:space-between;margin-top:10px;padding-top:10px;\
  border-top:1px solid var(--border,#DDE3EC);}\
.ndp-link{border:none;background:none;font-size:12.5px;font-weight:700;color:var(--orange-ink);\
  cursor:pointer;padding:4px 6px;}\
.ndp-link:hover{text-decoration:underline;}\
.ndp-link-muted{color:var(--text-muted,#5A6270);}\
input[type="date"].ndp-enhanced{cursor:pointer;background:#fff;}\
input[type="date"].ndp-enhanced::-webkit-calendar-picker-indicator{cursor:pointer;}\
@media (max-width:480px){.ndp-panel{width:calc(100vw - 24px);}}\
';

  function injectStyle() {
    if (document.getElementById('ndp-style')) return;
    var s = document.createElement('style');
    s.id = 'ndp-style';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function enhance(input) {
    if (input.dataset.ndpEnhanced) return;
    input.dataset.ndpEnhanced = '1';
    input.readOnly = true;
    input.classList.add('ndp-enhanced');
    input.addEventListener('click', function () { open(input); });
    input.addEventListener('focus', function () { open(input); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); open(input); }
    });
  }

  function scan(root) {
    (root || document).querySelectorAll('input[type="date"]').forEach(enhance);
  }

  function init() {
    injectStyle();
    scan();
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        m.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          if (n.matches && n.matches('input[type="date"]')) enhance(n);
          if (n.querySelectorAll) scan(n);
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
