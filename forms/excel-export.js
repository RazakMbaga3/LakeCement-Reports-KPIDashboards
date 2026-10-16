/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — Export Module  (PDF · Excel · Mail)
   ─────────────────────────────────────────────────────────────────
   Injects an "Export ▾" dropdown into the toolbar of any form page.
   Reads window._nyatiFormId set by form-persist.js.
   SheetJS served from this repo on first Excel export — see loadXLSX.
   ══════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* Same local-first loader as forms/excel-import.js — see the long
     note there for why the CDN is only a fallback and how the vendored
     copy's integrity is checked. Export had the identical defect:
     on a plant network with no internet egress, "Export ▾ → Excel"
     failed with "check internet connection". */
  var XLSX_VENDOR = '../vendor/xlsx-0.18.5/xlsx.full.min.js';
  var XLSX_CDN    = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  var _selfSrc    = (document.currentScript && document.currentScript.src) || '';
  var _xlsxReady = false;
  var _xlsxQueue = [];

  var FORM_TITLES = {
    'quality'     : 'Quality / Lab Daily Report',
    'dispatch'    : 'Dispatch & Stoppage Report',
    'materials'   : 'Raw Materials & Stores Report',
    'power-cons'  : 'Power Consumption Report',
    'pile-quality': 'Pile Quality Report',
    'stoppage'    : 'Sectional Stoppage Report',
    'cpp'         : 'CPP Daily Report'
  };

  /* ─── SheetJS loader ──────────────────────────────────────────── */
  function loadXLSX(cb) {
    if (window.XLSX) { cb(); return; }
    if (_xlsxReady)  { cb(); return; }
    _xlsxQueue.push(cb);
    if (_xlsxQueue.length > 1) return;

    var tried = [];
    function drain() {
      _xlsxReady = true;
      _xlsxQueue.splice(0).forEach(function (fn) { fn(); });
    }
    function attempt(url, onFail) {
      tried.push(url);
      var s = document.createElement('script');
      s.src = url;
      s.onload  = function () { if (!window.XLSX) onFail(); else drain(); };
      s.onerror = onFail;
      document.head.appendChild(s);
    }

    var vendor;
    try { vendor = new URL(XLSX_VENDOR, _selfSrc).href; }
    catch (e) { vendor = '/vendor/xlsx-0.18.5/xlsx.full.min.js'; }

    attempt(vendor, function () {
      attempt(XLSX_CDN, function () {
        _xlsxQueue.length = 0;   /* or one failure kills the button for the session */
        alert('Could not load the Excel library (SheetJS).\n\nTried:\n  ' + tried.join('\n  ') +
              '\n\nThe local copy should be on this server at ' +
              'vendor/xlsx-0.18.5/xlsx.full.min.js. If it is missing, re-deploy — ' +
              'exporting does not need internet access.');
      });
    });
  }

  /* ─── Helpers ─────────────────────────────────────────────────── */
  function getDateKey() {
    var di = document.querySelector('input[type="date"][data-field="date"]');
    if (di && di.value) return di.value;
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function friendlyDate(iso) {
    if (!iso) return '';
    var p = iso.split('-');
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return p[2] + ' ' + months[parseInt(p[1], 10) - 1] + ' ' + p[0];
  }

  function getSavedData(formId, dateKey) {
    var raw = localStorage.getItem('nyati-' + formId + '-' + dateKey);
    if (!raw) return { meta: null, data: {} };
    var parsed = JSON.parse(raw);
    return { meta: parsed._m || null, data: parsed.data || {} };
  }

  /* ─── Excel export ────────────────────────────────────────────── */
  function doExcelExport(formId) {
    var dateKey = getDateKey();
    var saved   = getSavedData(formId, dateKey);
    var data    = saved.data;
    var status  = saved.meta ? (saved.meta.status || 'draft').toUpperCase() : 'NO DATA';
    var title   = FORM_TITLES[formId] || formId;

    var rows = [];

    /* ── Company / report header, as every plant workbook carries ──── */
    rows.push(['LAKE CEMENT LTD — NYATI CEMENT']);
    rows.push([title]);
    rows.push(['Date:', friendlyDate(dateKey)]);
    rows.push(['Status:', status]);
    rows.push(['Exported:', new Date().toLocaleString('en-GB')]);
    /* State what an empty cell means. A blank that gets read as a real
       zero in a management meeting is the exact failure this project's
       data-integrity rule exists to prevent. */
    rows.push(['Note:', 'A blank cell means the figure was not reported — it does not mean zero.']);
    rows.push([]);

    /* ── Walk each report card, keeping the form's own table shape ────
       The form's tables ARE the plant's report layout (same columns, same
       order, same captions as the workbook each form replaced), so the
       export reproduces them instead of flattening everything to
       label/value pairs. The previous version emitted one row per input
       with the row's label repeated, which made a two-input row such as
       "Crusher | kWh" + "Crusher | MT" two identical-looking lines, and
       dropped every COMPUTED column (specific power, target, variance,
       MTD/YTD) because it only ever looked at [data-field] inputs. On the
       power report that is most of the report. */

    /* Text of one cell: a typed input's saved value, a computed .cv/.cf
       cell's rendered text, or the cell's own label text. Returns '' for
       anything not reported — never a zero, never a placeholder. */
    function cellValue(td) {
      var inp = td.querySelector('input[data-field], select[data-field], textarea[data-field]');
      if (inp) {
        var key = inp.dataset.field;
        var v = (key && data[key] !== undefined && data[key] !== '') ? data[key] : inp.value;
        return (v === undefined || v === null) ? '' : v;
      }
      /* Computed cells render '—' (or '-') when there is no value; export
         those as a genuinely empty cell rather than carrying the dash. */
      var cv = td.querySelector('.cv');
      var txt = (cv || td).textContent.trim().replace(/\s+/g, ' ');
      if (txt === '—' || txt === '-' || txt === '–') return '';
      return txt;
    }

    /* Header captions for a table: the <thead> cells, with their <br>
       unit lines flattened to "Energy (kWh)" so the unit survives.
       textContent alone would give "Energy(kWh)" — the <br> carries no
       whitespace of its own, so it is replaced with a space first. */
    function headerCells(table) {
      var head = table.querySelector('thead');
      if (!head) return null;
      var hrow = head.querySelectorAll('tr');
      if (!hrow.length) return null;
      var out = [];
      hrow[hrow.length - 1].querySelectorAll('th').forEach(function (th) {
        var clone = th.cloneNode(true);
        clone.querySelectorAll('br').forEach(function (br) {
          br.parentNode.replaceChild(document.createTextNode(' '), br);
        });
        out.push(clone.textContent.trim().replace(/\s+/g, ' '));
      });
      return out.length ? out : null;
    }

    function numberish(v) {
      if (typeof v !== 'string' || v === '') return v;
      var t = v.replace(/,/g, '');
      return (/^-?\d+(\.\d+)?$/.test(t)) ? Number(t) : v;
    }

    document.querySelectorAll('.rcard').forEach(function (card) {
      /* Skip a card the user has collapsed/hidden — the export should match
         what the page shows. */
      if (card.offsetParent === null && card.getClientRects().length === 0) return;

      var titleEl = card.querySelector('.rcard-title');
      var sec = titleEl ? titleEl.textContent.trim().replace(/\s+/g, ' ') : 'Section';
      rows.push([sec]);

      var tables = card.querySelectorAll('table');
      if (!tables.length) {
        rows.push([]);
        return;
      }

      tables.forEach(function (table) {
        var hdr = headerCells(table);
        if (hdr) rows.push(hdr);

        table.querySelectorAll('tbody tr, tr').forEach(function (tr) {
          if (tr.closest('thead')) return;

          /* A section divider row (one spanning cell, no inputs). */
          var tds = tr.querySelectorAll('td');
          if (!tds.length) return;
          var hasField = tr.querySelector('[data-field], [data-kpi], [data-var]');
          if (tds.length === 1 || (tds.length && tds[0].hasAttribute('colspan') && !hasField)) {
            var t = tds[0].textContent.trim().replace(/\s+/g, ' ');
            if (t) rows.push([t]);
            return;
          }
          /* A row with no inputs and no computed cells carries no data. */
          if (!hasField) return;

          var line = [];
          tds.forEach(function (td) { line.push(numberish(cellValue(td))); });
          /* Trailing empties add nothing. */
          while (line.length && (line[line.length - 1] === '' || line[line.length - 1] === null)) line.pop();
          if (line.length) rows.push(line);
        });

        rows.push([]);
      });
    });

    /* ── Sign-off ─────────────────────────────────────────────────── */
    var soInputs = document.querySelectorAll('.so-in[data-field], .so-time[data-field]');
    if (soInputs.length) {
      rows.push(['SIGN-OFF']);
      soInputs.forEach(function (inp) {
        var key = inp.dataset.field;
        var val = (data[key] !== undefined && data[key] !== '') ? data[key] : inp.value;
        var label = inp.placeholder || key;
        rows.push([label, val]);
      });
      rows.push([]);
    }

    loadXLSX(function () {
      var wb = window.XLSX.utils.book_new();
      var ws = window.XLSX.utils.aoa_to_sheet(rows);

      /* Column widths: a readable first column for the section/equipment
         name, then even columns for the figures. */
      var widest = 0;
      rows.forEach(function (r) { if (r.length > widest) widest = r.length; });
      var cols = [{ wch: 34 }];
      for (var i = 1; i < widest; i++) cols.push({ wch: 16 });
      ws['!cols'] = cols;
      /* Freeze the header block so the captions stay visible while
         scrolling a long report. */
      ws['!freeze'] = { xSplit: 1, ySplit: 7 };

      window.XLSX.utils.book_append_sheet(wb, ws, 'Report');
      window.XLSX.writeFile(wb, 'Nyati-' + formId + '-' + dateKey + '.xlsx');
    });
  }

  /* ─── Mail ────────────────────────────────────────────────────── */
  function doMail(formId, toAddress) {
    var dateKey = getDateKey();
    var saved   = getSavedData(formId, dateKey);
    var data    = saved.data;
    var title   = FORM_TITLES[formId] || formId;

    var lines = [
      'LAKE CEMENT LTD — NYATI CEMENT',
      title,
      'Date: ' + friendlyDate(dateKey),
      '',
    ];

    var seen = {};
    document.querySelectorAll('[data-field]').forEach(function (inp) {
      var key = inp.dataset.field;
      if (!key || key === 'date' || key.charAt(0) === '_' || seen[key]) return;   // '_' = internal (auto-named cells)
      seen[key] = true;
      var val = (data[key] !== undefined && data[key] !== '') ? data[key] : inp.value;
      if (val !== '') lines.push(key.replace(/_/g, ' ') + ': ' + val);
    });

    lines.push('', '-- ', 'Sent from Lake Cement Dashboard');

    var subject = encodeURIComponent(title + ' — ' + friendlyDate(dateKey));
    var body    = encodeURIComponent(lines.join('\r\n'));
    var to      = toAddress ? encodeURIComponent(toAddress) : '';
    window.location.href = 'mailto:' + to + '?subject=' + subject + '&body=' + body;
  }

  /* ─── Inject print header (hidden until @media print) ─────────── */
  function injectPrintHeader(formId) {
    var ph = document.createElement('div');
    ph.className = 'print-hdr';
    ph.innerHTML =
      '<img src="../NYATI-LOGO.png" class="print-hdr-logo" alt="Nyati Cement" />' +
      '<div class="print-hdr-text">' +
      '  <div class="print-hdr-company">Lake Cement Ltd — Nyati Cement</div>' +
      '  <div class="print-hdr-title" id="print-hdr-title">' + (FORM_TITLES[formId] || '') + '</div>' +
      '  <div class="print-hdr-date" id="print-hdr-date"></div>' +
      '</div>';
    document.body.insertBefore(ph, document.body.firstChild);

    /* keep date in sync with toolbar date picker */
    function syncDate() {
      var el = document.getElementById('print-hdr-date');
      if (el) el.textContent = friendlyDate(getDateKey());
    }
    syncDate();
    var datePicker = document.querySelector('input[type="date"][data-field="date"]');
    if (datePicker) datePicker.addEventListener('change', syncDate);
  }

  /* ─── Build toolbar dropdown ──────────────────────────────────── */
  function addExportUI(formId) {
    var btnGrp = document.querySelector('.btn-grp');
    if (!btnGrp) return;

    var wrap = document.createElement('div');
    wrap.className = 'exp-wrap';
    wrap.innerHTML =
      '<button class="btn btn-out exp-toggle" id="exp-toggle">' +
      '  <i data-lucide="share-2" class="btn-icon"></i> Export' +
      '  <i data-lucide="chevron-down" class="btn-icon exp-chevron" id="exp-chevron"></i>' +
      '</button>' +
      '<div class="exp-panel" id="exp-panel" role="menu">' +
      '  <button class="exp-item" id="exp-pdf">' +
      '    <i data-lucide="printer" class="exp-item-icon"></i>' +
      '    <div class="exp-item-text"><strong>Save as PDF</strong><span>Opens print dialog — choose "Save as PDF"</span></div>' +
      '  </button>' +
      '  <button class="exp-item" id="exp-xls">' +
      '    <i data-lucide="table-2" class="exp-item-icon"></i>' +
      '    <div class="exp-item-text"><strong>Download Excel</strong><span>Downloads filled .xlsx with all values</span></div>' +
      '  </button>' +
      '  <div class="exp-divider"></div>' +
      '  <div class="exp-mail-row">' +
      '    <i data-lucide="mail" class="exp-item-icon"></i>' +
      '    <input type="email" class="exp-email-in" id="exp-email-in" data-nopersist' +
      '      placeholder="recipient@example.com" autocomplete="email" />' +
      '    <button class="btn exp-send" id="exp-send">Send</button>' +
      '  </div>' +
      '</div>';

    /* insert as first child of btn-grp (same pattern as excel-import) */
    btnGrp.insertBefore(wrap, btnGrp.firstChild);

    if (window.lucide) lucide.createIcons();

    /* toggle */
    var toggle  = document.getElementById('exp-toggle');
    var panel   = document.getElementById('exp-panel');
    var chevron = document.getElementById('exp-chevron');

    function openPanel() {
      panel.classList.add('exp-open');
      chevron.style.transform = 'rotate(180deg)';
    }
    function closePanel() {
      panel.classList.remove('exp-open');
      chevron.style.transform = '';
    }

    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.classList.contains('exp-open') ? closePanel() : openPanel();
    });
    document.addEventListener('click', closePanel);
    panel.addEventListener('click', function (e) { e.stopPropagation(); });

    /* PDF */
    document.getElementById('exp-pdf').addEventListener('click', function () {
      closePanel();
      window.print();
    });

    /* Excel */
    document.getElementById('exp-xls').addEventListener('click', function () {
      closePanel();
      doExcelExport(formId);
    });

    /* Mail — send on button click or Enter in email field */
    function sendMail() {
      var addr = document.getElementById('exp-email-in').value.trim();
      closePanel();
      doMail(formId, addr);
    }
    document.getElementById('exp-send').addEventListener('click', sendMail);
    document.getElementById('exp-email-in').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') sendMail();
    });
  }

  /* ─── Init ────────────────────────────────────────────────────── */
  function _init() {
    var formId = window._nyatiFormId;
    if (!formId) return;
    injectPrintHeader(formId);
    addExportUI(formId);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
