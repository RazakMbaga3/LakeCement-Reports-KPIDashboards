/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — Export Module  (PDF · Excel · Mail)
   ─────────────────────────────────────────────────────────────────
   Injects an "Export ▾" dropdown into the toolbar of any form page.
   Reads window._nyatiFormId set by form-persist.js.
   SheetJS loaded from CDN on first Excel export.
   ══════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var XLSX_CDN = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
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
    var s = document.createElement('script');
    s.src = XLSX_CDN;
    s.onload = function () {
      _xlsxReady = true;
      _xlsxQueue.splice(0).forEach(function (fn) { fn(); });
    };
    s.onerror = function () { alert('Could not load Excel library. Check internet connection.'); };
    document.head.appendChild(s);
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

    /* company header */
    rows.push(['LAKE CEMENT LTD — NYATI CEMENT']);
    rows.push([title]);
    rows.push(['Date:', friendlyDate(dateKey)]);
    rows.push(['Status:', status]);
    rows.push([]);

    /* walk visible rcard sections */
    document.querySelectorAll('.rcard').forEach(function (card) {
      var titleEl = card.querySelector('.rcard-title');
      var sec = titleEl ? titleEl.textContent.trim().replace(/\s+/g, ' ') : 'Section';
      rows.push([sec.toUpperCase()]);

      card.querySelectorAll('tr').forEach(function (tr) {
        var labelEl = tr.querySelector('.tp');
        var inputs  = tr.querySelectorAll('input[data-field], select[data-field], textarea[data-field]');
        if (!labelEl || !inputs.length) return;

        var label = labelEl.textContent.trim();
        inputs.forEach(function (inp) {
          var key = inp.dataset.field;
          var val = (data[key] !== undefined && data[key] !== '') ? data[key] : inp.value;
          if (key) rows.push(['', label, val]);
        });
      });

      rows.push([]);
    });

    /* sign-off fields */
    var soInputs = document.querySelectorAll('.so-in[data-field], .so-time[data-field]');
    if (soInputs.length) {
      rows.push(['SIGN-OFF']);
      soInputs.forEach(function (inp) {
        var key = inp.dataset.field;
        var val = (data[key] !== undefined && data[key] !== '') ? data[key] : inp.value;
        var label = inp.placeholder || key;
        rows.push(['', label, val]);
      });
      rows.push([]);
    }

    loadXLSX(function () {
      var wb = window.XLSX.utils.book_new();
      var ws = window.XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{ wch: 2 }, { wch: 42 }, { wch: 22 }];
      window.XLSX.utils.book_append_sheet(wb, ws, 'Report');
      window.XLSX.writeFile(wb, formId + '-' + dateKey + '.xlsx');
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
