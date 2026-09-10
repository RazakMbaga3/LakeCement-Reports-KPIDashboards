/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — Excel Import  (drag-and-drop + file picker)
   ─────────────────────────────────────────────────────────────────
   Supports: dispatch · quality · materials · power-cons · pile-quality
   Uses SheetJS (xlsx.js) loaded from CDN on first use.
   Reads window._nyatiFormId set by form-persist.js.
   ══════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var XLSX_CDN = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  var _xlsxLoaded = false;
  var _xlsxQueue  = [];

  function loadXLSX(cb) {
    if (_xlsxLoaded) { cb(); return; }
    _xlsxQueue.push(cb);
    if (_xlsxQueue.length > 1) return;
    var s  = document.createElement('script');
    s.src  = XLSX_CDN;
    s.onload = function () {
      _xlsxLoaded = true;
      _xlsxQueue.splice(0).forEach(function (fn) { fn(); });
    };
    s.onerror = function () { alert('Could not load SheetJS. Check your internet connection.'); };
    document.head.appendChild(s);
  }

  /* ── Helpers ──────────────────────────────────────────────────── */
  function toNum(v) {
    if (v === '' || v == null) return null;
    var n = parseFloat(v);
    return isNaN(n) ? null : n;
  }

  function fmt(v, dec) {
    if (v === null || v === undefined || v === '') return '';
    v = parseFloat(v);
    if (isNaN(v)) return '';
    return dec != null ? v.toFixed(dec) : String(v);
  }

  function sumCols(row, idxs) {
    if (!row) return 0;
    return idxs.reduce(function (a, i) { return a + (toNum(row[i]) || 0); }, 0);
  }

  function findRow(rows, test) {
    for (var i = 0; i < rows.length; i++) {
      if (test(rows[i])) return rows[i];
    }
    return null;
  }

  function findRowIdx(rows, test) {
    for (var i = 0; i < rows.length; i++) {
      if (test(rows[i])) return i;
    }
    return -1;
  }

  function excelSerial(v) {
    /* Convert Excel date serial → "YYYY-MM-DD" */
    if (!v || isNaN(v)) return '';
    var d = new Date((v - 25569) * 86400000);
    d = new Date(d.getTime() + d.getTimezoneOffset() * 60000);
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function anyDate(v) {
    if (!v) return '';
    /* "DD.MM.YYYY" */
    var m = String(v).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m) return m[3] + '-' + m[2] + '-' + m[1];
    /* Excel serial */
    var n = parseFloat(v);
    if (!isNaN(n) && n > 40000) return excelSerial(n);
    return '';
  }

  /* ═══════════════════════════════════════════════════════════════
     PER-FORM EXTRACTORS
     Each function receives the SheetJS Workbook and returns
     { fieldName: formattedStringValue }
     _error key signals a fatal problem.
  ═══════════════════════════════════════════════════════════════ */
  var EXTRACTORS = {

    /* ── Dispatch ─────────────────────────────────────────────── */
    dispatch: function (wb) {
      var ws   = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      var dateVal  = anyDate(rows[1][17]) || anyDate(rows[2][17]);
      var salesRow = findRow(rows, function (r) { return /SALES\s+ON\s+DATE/i.test(String(r[1])); });
      var soRow    = findRow(rows, function (r) { return /PENDENCY/i.test(String(r[1])); });

      if (!salesRow) return { _error: 'Could not find "Sales on Date" row. Is this a Dispatch report?' };

      /* Column layout (0-indexed after the row's leading SR-NO/label cells):
         Regular Bags: [2]=42.5R [3]=42.5N B-M [4]=42.5N [5]=32.5N [6]=OPC 42.5N
         Bulker:       [7]=32.5N [8]=42.5R [9]=42.5N B-M [10]=42.5N [11]=OPC 42.5N
         Big Bags:     [12]=42.5R [13]=42.5N B-M [14]=42.5N
         Clinker:      [15]                                                        */
      return {
        date:                 dateVal,
        dispatch_reg_425r:    fmt(toNum(salesRow[2])),
        dispatch_reg_425nbm:  fmt(toNum(salesRow[3])),
        dispatch_reg_425n:    fmt(toNum(salesRow[4])),
        dispatch_reg_325n:    fmt(toNum(salesRow[5])),
        dispatch_reg_opc425n: fmt(toNum(salesRow[6])),
        dispatch_blk_425r:    fmt(toNum(salesRow[8])),
        dispatch_blk_425nbm:  fmt(toNum(salesRow[9])),
        dispatch_blk_425n:    fmt(toNum(salesRow[10])),
        dispatch_blk_325n:    fmt(toNum(salesRow[7])),
        dispatch_blk_opc425n: fmt(toNum(salesRow[11])),
        dispatch_bag_425r:    fmt(toNum(salesRow[12])),
        dispatch_bag_425nbm:  fmt(toNum(salesRow[13])),
        dispatch_bag_425n:    fmt(toNum(salesRow[14])),
        dispatch_clinker:     fmt(toNum(salesRow[15])),
        so_425r:         fmt(toNum(soRow ? soRow[2] : null)),
        so_425nbm:       fmt(toNum(soRow ? soRow[3] : null)),
        so_425n:         fmt(toNum(soRow ? soRow[4] : null)),
        so_325n:         fmt(toNum(soRow ? soRow[5] : null)),
        so_opc425n:      fmt(toNum(soRow ? soRow[6] : null)),
        so_bulker:       fmt(sumCols(soRow || [], [7, 8, 9, 10, 11])),
        so_bigbag:       fmt(sumCols(soRow || [], [12, 13, 14])),
        so_clinker:      fmt(toNum(soRow ? soRow[15] : null)),
      };
    },

    /* ── Quality / Lab ────────────────────────────────────────── */
    quality: function (wb) {
      var shName = wb.SheetNames.find(function (n) { return /DAILY\s+SUMMARY/i.test(n); }) || wb.SheetNames[0];
      var ws     = wb.Sheets[shName];
      var rows   = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      /* Date: row 1 col 20, or row 2 col 4 */
      var dateVal = anyDate(rows[1][20]) || anyDate(rows[2][4]);

      /* Blaine & 28-day strength from G-42.5R row */
      var r425R  = findRow(rows, function (r) { return /G\s*-\s*42\.5R/i.test(String(r[0])); });
      var blaine = r425R ? toNum(r425R[1]) : null;
      var s28d   = r425R ? toNum(r425R[12]) : null;

      /* Coal residue: AVG row in coal-mill section — col 15 = 'AVG', residue at col 20 */
      var coalAvgRow = findRow(rows, function (r) { return String(r[15]).trim().toUpperCase() === 'AVG'; });
      var coalRes = coalAvgRow ? toNum(coalAvgRow[20]) : null;

      /* Free lime: average of clinker F.CaO col across 6 four-hour periods */
      var fcHdrIdx = findRowIdx(rows, function (r) { return r.some(function (c) { return /F\.?CaO/i.test(String(c)); }); });
      var fcCol    = -1;
      if (fcHdrIdx >= 0) {
        fcCol = rows[fcHdrIdx].findIndex(function (c) { return /F\.?CaO/i.test(String(c)); });
      }
      var freeLime = null;
      if (fcHdrIdx >= 0 && fcCol >= 0) {
        var fcVals = rows.slice(fcHdrIdx + 1, fcHdrIdx + 7)
          .map(function (r) { return toNum(r[fcCol]); })
          .filter(function (v) { return v !== null; });
        if (fcVals.length) freeLime = fcVals.reduce(function (a, b) { return a + b; }, 0) / fcVals.length;
      }

      /* Raw mill LSF — 6 four-hour labels, LSF at col 21 */
      var lsfLabels = ['1 to 4', '5 to 8', '9 to 12', '13 to 16', '17 to 20', '21 to 24'];
      /* Find LSF column from header */
      var rmHdrIdx = findRowIdx(rows, function (r) {
        return String(r[0]).trim() === '' && r.some(function (c) { return String(c).trim() === 'LSF'; });
      });
      var lsfCol = 21; // default from inspection
      if (rmHdrIdx >= 0) {
        var ci = rows[rmHdrIdx].findIndex(function (c) { return String(c).trim() === 'LSF'; });
        if (ci >= 0) lsfCol = ci;
      }

      var result = {
        date:         dateVal,
        blaine_425r:  fmt(blaine, 0),
        strength_28d: fmt(s28d, 2),
        coal_residue: fmt(coalRes, 2),
        free_lime:    fmt(freeLime, 2),
      };
      lsfLabels.forEach(function (lbl, i) {
        var row = findRow(rows, function (r) { return String(r[0]).trim() === lbl; });
        result['lsf_rm_h' + (i + 1)] = fmt(row ? toNum(row[lsfCol]) : null, 2);
      });
      return result;
    },

    /* ── Raw Materials ─────────────────────────────────────────────
       Mirrors the "RAW MATERIAL REPORT" workbook 1:1. Row catalogue
       comes from window.MATERIALS_SECTIONS (defined by the form page)
       so form and importer can never drift apart. Layout (0-indexed):
       B1=SN  C2=description  F5=opening  G6/H7/I8=received d/m/y
       J9/K10/L11=consumption d/m/y  M12=closing(calc)  N13=pending GRN
       O14=min  P15=max  Q16=variance(calc). Date sits right of the
       "DATE" label near the top. Sections repeat supplier names, so
       matching is section-scoped via the header rows in column C.  */
    materials: function (wb) {
      var secs = window.MATERIALS_SECTIONS;
      if (!secs) return { _error: 'Row catalogue missing — open this import from the Raw Materials form page.' };

      var ws   = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      /* Date: find the row holding a "DATE" label, take the first
         date-parsable cell to its right (fallback: scan rows 1-4). */
      var dateVal = '';
      for (var di = 0; di < Math.min(rows.length, 6) && !dateVal; di++) {
        for (var dj = 0; dj < rows[di].length && !dateVal; dj++) {
          dateVal = anyDate(rows[di][dj]);
        }
      }

      function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9.]/g, ''); }

      /* Section header text (col C) → MATERIALS_SECTIONS id */
      var HDRS = [
        [/COAL\s*[-–]\s*KILN/i,  'ck'],
        [/COAL\s*[-–]\s*CPP/i,   'cc'],
        [/CEMENT\s+BAGS/i,       'bag'],
        [/GRINDING\s+AID/i,      'ga'],
        [/^DIESEL/i,             'dsl'],
      ];
      function secById(id) {
        for (var i = 0; i < secs.length; i++) if (secs[i].id === id) return secs[i];
        return null;
      }

      var out = { date: dateVal };
      var current = secById('main');   /* Iron Ore / Gypsum / Clinker come first */

      rows.forEach(function (r) {
        var label = String(r[2] || '').trim();
        if (!label) return;

        for (var h = 0; h < HDRS.length; h++) {
          if (HDRS[h][0].test(label)) { current = secById(HDRS[h][1]); return; }
        }
        if (!current || /^(sub\s*)?total/i.test(label)) return;

        var nl = norm(label);
        for (var i = 0; i < current.rows.length; i++) {
          var row = current.rows[i];
          if (norm(row.label) !== nl && norm(row.xl || '') !== nl) continue;
          out[row.f + '_cons']     = fmt(toNum(r[9]));
          out[row.f + '_cons_mtd'] = fmt(toNum(r[10]));
          out[row.f + '_cons_ytd'] = fmt(toNum(r[11]));
          if (!row.consOnly) {
            out[row.f + '_open']     = fmt(toNum(r[5]));
            out[row.f + '_rcvd']     = fmt(toNum(r[6]));
            out[row.f + '_rcvd_mtd'] = fmt(toNum(r[7]));
            out[row.f + '_rcvd_ytd'] = fmt(toNum(r[8]));
            out[row.f + '_grn']      = fmt(toNum(r[13]));
            out[row.f + '_min']      = fmt(toNum(r[14]));
            out[row.f + '_max']      = fmt(toNum(r[15]));
          }
          break;
        }
      });

      return out;
    },

    /* ── Power Consumption ────────────────────────────────────── */
    'power-cons': function (wb) {
      var shName = wb.SheetNames.find(function (n) { return /power.?report/i.test(n) && !/backup/i.test(n); }) || wb.SheetNames[0];
      var ws     = wb.Sheets[shName];
      var rows   = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      /* Date: row 1 col 11 */
      var dateVal = anyDate(rows[1][11]) || anyDate(rows[0][11]);

      /* Find section-total kWh by section number in col 0 */
      function secTotal(secNum) {
        var active = false;
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          if (r[0] === secNum) active = true;
          if (active && String(r[2]).trim() === 'Total') return toNum(r[5]);
        }
        return null;
      }

      return {
        date:             dateVal,
        pwr_crusher_kwh:  fmt(secTotal(1), 0),
        pwr_rawmill_kwh:  fmt(secTotal(2), 0),
        pwr_coalmill_kwh: fmt(secTotal(4), 0),
        pwr_kiln_kwh:     fmt(secTotal(5), 0),
        pwr_cm2_kwh:      fmt(secTotal(7), 0),
        pwr_packing_kwh:  fmt(secTotal(8), 0),
      };
    },

    /* ── Pile Quality (CaO) ───────────────────────────────────── */
    'pile-quality': function (wb) {
      /* Find the sheet for today, or use the last date-named sheet */
      var today = new Date();
      var todayStr = String(today.getDate()).padStart(2, '0') + '.' +
                     String(today.getMonth() + 1).padStart(2, '0') + '.' +
                     today.getFullYear();
      var dateSheets = wb.SheetNames.filter(function (n) { return /^\d{2}\.\d{2}\.\d{4}$/.test(n.trim()); });
      var shName = dateSheets.find(function (n) { return n.trim() === todayStr; }) ||
                   (dateSheets.length ? dateSheets[dateSheets.length - 1] : wb.SheetNames[0]);

      var ws   = wb.Sheets[shName];
      var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      var dateVal = anyDate(shName) || anyDate(rows[1] && rows[1][0]);

      /* Each data row: col 2 = %CaO. Skip header (row 0), read up to 18 samples */
      var dataRows = rows.slice(1).filter(function (r) {
        var v = toNum(r[2]);
        return v !== null && v > 0;
      });

      var result = { date: dateVal };
      dataRows.slice(0, 18).forEach(function (row, i) {
        result['cao_h' + (i + 1)] = fmt(toNum(row[2]), 2);
      });
      return result;
    },

    /* ── Limestone % Daily Report ────────────────────────────────── */
    limestone: function (wb) {
      /* Find the sheet for today's month. Sheet names like "MAY 2026",
         "APRIL 2026", "March 2026", etc. */
      var MONTH_NAMES = ['JAN','FEB','MAR','MARCH','APR','APRIL','MAY','JUN','JUNE',
                         'JUL','JULY','AUG','AUGUST','SEP','SEPT','SEPTEMBER','OCT','NOV','DEC'];
      var today   = new Date();
      var yr      = today.getFullYear();
      var moIdx   = today.getMonth(); // 0-based
      /* Variants of the month name that might appear in the sheet */
      var moVars  = [
        ['JAN'],['FEB'],['MAR','MARCH'],['APR','APRIL'],['MAY'],
        ['JUN','JUNE'],['JUL','JULY'],['AUG','AUGUST'],
        ['SEP','SEPT','SEPTEMBER'],['OCT'],['NOV'],['DEC']
      ][moIdx];

      var shName = wb.SheetNames.find(function (n) {
        var upper = n.trim().toUpperCase();
        return moVars.some(function (v) { return upper.includes(v); }) &&
               upper.includes(String(yr));
      }) || wb.SheetNames[wb.SheetNames.length - 1];

      var ws   = wb.Sheets[shName];
      var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      /* Find today's date column in row 1 (header row).
         Date format in Excel: "DD.MM.YYYY" */
      var todayStr = String(today.getDate()).padStart(2, '0') + '.' +
                     String(today.getMonth() + 1).padStart(2, '0') + '.' +
                     today.getFullYear();
      var hdr     = rows[1] || [];
      var dateCol = -1;
      for (var ci = 0; ci < hdr.length; ci++) {
        if (String(hdr[ci]).trim() === todayStr) { dateCol = ci; break; }
      }
      /* If today not found, use rightmost column that has any data */
      if (dateCol < 0) {
        for (var ci = hdr.length - 1; ci >= 2; ci--) {
          if (/^\d{2}\.\d{2}\.\d{4}$/.test(String(hdr[ci]).trim())) {
            var hasData = rows.some(function (r, ri) {
              return ri > 1 && r[ci] !== '' && !isNaN(parseFloat(r[ci]));
            });
            if (hasData) { dateCol = ci; break; }
          }
        }
      }
      if (dateCol < 0) {
        return { _error: 'Could not find today\'s date (' + todayStr + ') or any data column in sheet "' + shName + '".' };
      }

      /* Recover date string for the found column */
      var dateParts = String(hdr[dateCol]).trim().split('.');
      var dateIso   = dateParts.length === 3
        ? dateParts[2] + '-' + dateParts[1] + '-' + dateParts[0]
        : today.toISOString().slice(0, 10);

      /* Values in Excel are decimals (0.16 = 16%). Multiply by 100. */
      function pct(v) {
        var n = parseFloat(v);
        return (!isNaN(n) && n > 0) ? fmt(n * 100, 2) : '';
      }

      /* Fixed row indices (0-based in parsed array):
         Row  1 : Mill 1 header
         Rows 2-16 : Mill 1 data (5 grades × 3 rows = 15)
         Row 18 : Mill 2 header
         Rows 19-33 : Mill 2 data
         Row 34 : NCV
         Row 36 : Avg Clinker Cons %                              */
      var GRADE_ROWS = [
        /* [fieldPrefix, lsRow, ckRow, gyRow] */
        ['m1_425r',  2,  3,  4],
        ['m1_425n',  5,  6,  7],
        ['m1_325n',  8,  9, 10],
        ['m1_blm',  11, 12, 13],
        ['m1_opc',  14, 15, 16],
        ['m2_425r', 19, 20, 21],
        ['m2_425n', 22, 23, 24],
        ['m2_325n', 25, 26, 27],
        ['m2_blm',  28, 29, 30],
        ['m2_opc',  31, 32, 33],
      ];

      var result = { date: dateIso };
      GRADE_ROWS.forEach(function (gr) {
        var pfx = gr[0];
        result[pfx + '_ls'] = pct(rows[gr[1]] && rows[gr[1]][dateCol]);
        result[pfx + '_ck'] = pct(rows[gr[2]] && rows[gr[2]][dateCol]);
        result[pfx + '_gy'] = pct(rows[gr[3]] && rows[gr[3]][dateCol]);
      });

      /* NCV (row index 34) */
      var ncvRow = rows[34] || [];
      var ncvVal = toNum(ncvRow[dateCol]);
      if (ncvVal !== null) result['ncv'] = fmt(ncvVal, 0);

      /* Check we actually extracted something useful */
      var hasData = Object.keys(result).some(function (k) {
        return k !== 'date' && result[k] !== '';
      });
      if (!hasData) {
        return { _error: 'Found column for ' + String(hdr[dateCol]).trim() + ' but all cells are empty. Check if data has been entered for this date.' };
      }
      return result;
    },
  };

  /* ── Apply extracted data to form inputs ──────────────────────── */
  function applyToForm(data) {
    var applied = 0;
    Object.keys(data).forEach(function (field) {
      if (field === '_error' || data[field] === '' || data[field] == null) return;
      var el = document.querySelector('[data-field="' + field + '"]');
      if (!el) return;
      el.value = data[field];
      ['input', 'change'].forEach(function (evt) {
        el.dispatchEvent(new Event(evt, { bubbles: true }));
      });
      applied++;
    });
    return applied;
  }

  /* ── Preview modal ────────────────────────────────────────────── */
  function showPreview(data, formId, onApply) {
    document.getElementById('_xi-modal')?.remove();

    if (data._error) {
      var errBox = document.createElement('div');
      errBox.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;background:#C62828;color:white;padding:11px 20px;border-radius:9px;font-family:Inter,sans-serif;font-size:13px;font-weight:600;box-shadow:0 4px 24px rgba(0,0,0,.22);max-width:360px';
      errBox.textContent = '✕  ' + data._error;
      document.body.appendChild(errBox);
      setTimeout(function () { errBox.remove(); }, 5000);
      return;
    }

    var fields  = Object.keys(data).filter(function (k) { return k !== '_error' && data[k] !== '' && data[k] != null; });
    var matched = fields.filter(function (k) { return !!document.querySelector('[data-field="' + k + '"]'); });
    var extra   = fields.filter(function (k) { return !document.querySelector('[data-field="' + k + '"]'); });

    /* Build field table */
    var rowsHtml = fields.filter(function (k) { return k !== 'date'; }).map(function (k) {
      var inForm = !!document.querySelector('[data-field="' + k + '"]');
      return '<tr style="border-bottom:1px solid #EEF2F7">' +
        '<td style="padding:5px 12px;font-size:12px;color:#5A6270;font-family:monospace;white-space:nowrap">' + k + '</td>' +
        '<td style="padding:5px 12px;font-size:12px;font-weight:700;color:#111827;text-align:right">' + data[k] + '</td>' +
        '<td style="padding:5px 12px;text-align:center;font-size:13px">' + (inForm ? '<span style="color:var(--green-ink)">✓</span>' : '<span style="color:var(--text-muted)">—</span>') + '</td>' +
      '</tr>';
    }).join('');

    var modal = document.createElement('div');
    modal.id  = '_xi-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(23,49,88,.55);z-index:9995;display:flex;align-items:center;justify-content:center;padding:16px';
    modal.innerHTML =
      '<div style="background:white;border-radius:9px;max-width:480px;width:100%;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.28)">' +
        /* header */
        '<div style="background:#173158;border-radius:9px 9px 0 0;padding:13px 18px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0">' +
          '<div>' +
            '<div style="color:white;font-size:12px;font-weight:700;letter-spacing:.8px;text-transform:uppercase">Excel Import Preview</div>' +
            '<div style="color:var(--on-navy);font-size:12px;margin-top:2px">' + formId + ' · ' + matched.length + ' fields matched</div>' +
          '</div>' +
          '<button onclick="document.getElementById(\'_xi-modal\').remove()" style="background:rgba(255,255,255,.12);border:none;color:white;width:26px;height:26px;border-radius:6px;cursor:pointer;font-size:15px;line-height:1;display:flex;align-items:center;justify-content:center">✕</button>' +
        '</div>' +
        /* body */
        '<div style="padding:14px 18px;overflow-y:auto;flex:1">' +
          (data.date ? '<div style="font-size:12px;color:#5A6270;margin-bottom:10px">Report date: <strong style="color:#173158">' + data.date + '</strong></div>' : '') +
          '<div style="display:flex;gap:8px;margin-bottom:12px">' +
            '<span style="background:var(--st-good-bg);color:#065F46;font-size:12px;font-weight:700;padding:3px 10px;border-radius:9px">' + matched.length + ' matched</span>' +
            (extra.length ? '<span style="background:#F1F5F9;color:#64748B;font-size:12px;font-weight:700;padding:3px 10px;border-radius:10px">' + extra.length + ' not in form</span>' : '') +
          '</div>' +
          '<table style="width:100%;border-collapse:collapse">' +
            '<thead><tr style="background:#F7F8FA">' +
              '<th style="padding:5px 12px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#5A6270;text-align:left">Field</th>' +
              '<th style="padding:5px 12px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#5A6270;text-align:right">Value</th>' +
              '<th style="padding:5px 12px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#5A6270;text-align:center">In form</th>' +
            '</tr></thead>' +
            '<tbody>' + rowsHtml + '</tbody>' +
          '</table>' +
        '</div>' +
        /* footer */
        '<div style="padding:12px 18px;border-top:1px solid #EEF2F7;display:flex;gap:8px;justify-content:flex-end;flex-shrink:0">' +
          '<button id="_xi-cancel" style="padding:7px 18px;border-radius:6px;border:1.5px solid #CBD5E1;background:transparent;font-family:Inter,sans-serif;font-size:12px;font-weight:600;cursor:pointer;color:#173158">Cancel</button>' +
          '<button id="_xi-apply" style="padding:7px 20px;border-radius:6px;border:none;background:#F49545;font-family:Inter,sans-serif;font-size:12px;font-weight:700;cursor:pointer;color:white">Apply ' + matched.length + ' Fields →</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);
    modal.querySelector('#_xi-cancel').addEventListener('click', function () { modal.remove(); });
    modal.querySelector('#_xi-apply').addEventListener('click', function () {
      var count = applyToForm(data);
      modal.remove();
      /* Trigger kpi-live recalc */
      document.dispatchEvent(new CustomEvent('nyati:restored'));
      /* Success toast */
      var t = document.createElement('div');
      t.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;background:#239557;color:white;padding:11px 20px;border-radius:9px;font-family:Inter,sans-serif;font-size:13px;font-weight:600;box-shadow:0 4px 24px rgba(0,0,0,.22);display:flex;align-items:center;gap:10px;animation:_nytIn .2s ease';
      t.innerHTML = '<span style="font-size:15px">✓</span><span>' + count + ' fields filled from Excel</span>';
      document.body.appendChild(t);
      setTimeout(function () { t.remove(); }, 3400);
      if (onApply) onApply(count);
    });
    /* Click backdrop to close */
    modal.addEventListener('click', function (e) { if (e.target === modal) modal.remove(); });
  }

  /* ── Process a File object ────────────────────────────────────── */
  function processFile(file, formId) {
    var extractor = EXTRACTORS[formId];
    if (!extractor) {
      alert('No Excel mapping for "' + formId + '".\nSupported: dispatch, quality, materials, power-cons, pile-quality');
      return;
    }
    loadXLSX(function () {
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var wb   = XLSX.read(e.target.result, { type: 'array' });
          var data = extractor(wb);
          showPreview(data, formId, null);
        } catch (err) {
          alert('Could not parse Excel file:\n' + err.message);
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /* ── Full-page drag-and-drop overlay ─────────────────────────── */
  function setupDropZone(formId) {
    var overlay = document.createElement('div');
    overlay.id  = '_xi-drop';
    overlay.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(23,49,88,.75);z-index:9990;flex-direction:column;align-items:center;justify-content:center;color:white;pointer-events:none;transition:opacity .15s';
    overlay.innerHTML =
      '<div style="border:3px dashed rgba(255,255,255,.55);border-radius:14px;padding:52px 80px;text-align:center">' +
        '<div style="font-size:52px;margin-bottom:14px">📊</div>' +
        '<div style="font-size:20px;font-weight:700;letter-spacing:.3px">Drop Excel file to import</div>' +
        '<div style="font-size:12px;opacity:.85;margin-top:8px">.xlsx — ' + formId + ' report</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var depth = 0;
    document.addEventListener('dragenter', function (e) {
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
        if (++depth === 1) { overlay.style.display = 'flex'; overlay.style.pointerEvents = 'auto'; }
      }
    });
    document.addEventListener('dragleave', function () {
      if (--depth <= 0) { depth = 0; overlay.style.display = 'none'; overlay.style.pointerEvents = 'none'; }
    });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      overlay.style.display = 'none';
      overlay.style.pointerEvents = 'none';
      var file = e.dataTransfer.files[0];
      if (!file) return;
      if (!file.name.endsWith('.xlsx')) { alert('Please drop an .xlsx file.'); return; }
      processFile(file, formId);
    });
  }

  /* ── "Import Excel" button in toolbar ────────────────────────── */
  function addToolbarButton(formId) {
    if (!EXTRACTORS[formId]) return;
    var toolbar = document.querySelector('.toolbar');
    if (!toolbar) return;

    /* Hidden file input */
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.xlsx'; inp.style.display = 'none'; inp.id = '_xi-inp';
    inp.addEventListener('change', function () {
      if (inp.files[0]) processFile(inp.files[0], formId);
      inp.value = '';
    });
    document.body.appendChild(inp);

    /* Button — inject before btn-grp */
    var btn = document.createElement('button');
    btn.className = 'btn btn-out';
    btn.id = '_xi-btn';
    btn.title = 'Import data from Excel (.xlsx)';
    btn.style.cssText = 'border-color:#4F74B2;color:#2C5A9E;';
    btn.innerHTML =
      '<svg style="width:13px;height:13px;stroke-width:2.5;vertical-align:-2px;margin-right:4px;display:inline-block" viewBox="0 0 24 24" fill="none" stroke="currentColor">' +
        '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
        '<polyline points="14 2 14 8 20 8"/>' +
        '<polyline points="8 18 12 22 16 18"/><line x1="12" y1="12" x2="12" y2="22"/>' +
      '</svg>Import Excel';
    btn.addEventListener('click', function () { inp.click(); });

    var grp = toolbar.querySelector('.btn-grp');
    if (grp) grp.insertBefore(btn, grp.firstChild);
    else toolbar.appendChild(btn);
  }

  /* Exposed so extractors can be exercised outside the page (tests) */
  window._nyatiExtractors = EXTRACTORS;

  /* ── Bootstrap ────────────────────────────────────────────────── */
  function init() {
    var formId = window._nyatiFormId;
    if (!formId) return;
    addToolbarButton(formId);
    setupDropZone(formId);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

}());
