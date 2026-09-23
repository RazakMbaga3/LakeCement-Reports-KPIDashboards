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

    /* ── Quality / Lab ──────────────────────────────────────────────
       Reads the plant's "QC DAILY REPORT" workbook (sheet DAILY SUMMARY)
       and fills forms/quality-form.html end to end — 130-odd fields, the
       whole daily lab sheet in one drop.

       Two things about this sheet drive every choice below.

       1. Its used range starts at column B, and SheetJS indexes a row
          array from the range's first column — so index 0 is column B and
          index 12 is column N, not L. Rather than carry that off-by-one
          around, nothing here hard-codes a column NUMBER: every column is
          located by its own heading inside its own section's header row.
          That matters because the same heading appears in three different
          tables at three different columns ("LSF" is at W in Raw Mill, P
          in Kiln Feed, O in Clinker), and twice within one of them (Raw
          Mill prints R90/R212 once for RM-1 and again for RM-2).

       2. Raw Mill, Kiln Feed and Clinker are recorded FOUR-HOURLY — six
          rows labelled "1 to 4" … "21 to 24". The form holds one day
          average per parameter (2026-09-22), so the mean of those six
          rows is taken here. The averaging moved into the importer, where
          the four-hourly readings actually are; it did not disappear.  */
    quality: function (wb) {
      var shName = wb.SheetNames.find(function (n) { return /DAILY\s+SUMMARY/i.test(n); }) || wb.SheetNames[0];
      var ws     = wb.Sheets[shName];
      var rows   = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      function txt(v) { return String(v == null ? '' : v).trim(); }
      function cell(r, c) { return (c < 0 || !rows[r]) ? null : toNum(rows[r][c]); }

      /* Column index of a heading WITHIN one header row. `nth` picks
         between repeats (Raw Mill's two R90/R212 pairs: RM-1 then RM-2). */
      function colOf(hdr, name, nth) {
        var want = name.toUpperCase(), seen = 0;
        for (var i = 0; i < hdr.length; i++) {
          if (txt(hdr[i]).toUpperCase() !== want) continue;
          if (seen === (nth || 0)) return i;
          seen++;
        }
        return -1;
      }
      function colMatching(hdr, re) {
        for (var i = 0; i < hdr.length; i++) if (re.test(txt(hdr[i]))) return i;
        return -1;
      }

      var out = {};
      /* Report date — scanned out of the title block rather than read from
         a fixed cell. The sheet's used range does not start on the same
         row in every copy of this workbook (the April file reports
         B2:Y83, the September one B1:Y83), so a row index taken from one
         of them is off by one in the other; the first date-shaped value
         near the top is the report date in both. */
      out.date = '';
      for (var di = 0; di < Math.min(rows.length, 6) && !out.date; di++) {
        for (var dj = 0; dj < rows[di].length && !out.date; dj++) out.date = anyDate(rows[di][dj]);
      }

      /* ── Block 1 — PHYSICAL LAB REPORT ───────────────────────────
         Grade labels repeat across the three mill sections ("G - 42.5R"
         is a row in both Cement mill-1 and Cement mill-2), so a grade is
         only ever looked up INSIDE its section — between that section's
         banner row and the next banner (or the RAWMILL heading). Matching
         on the label alone, as this importer used to, silently read
         Cement mill-1's 42.5R for all three sections. */
      var physHdrIdx = findRowIdx(rows, function (r) {
        return r.some(function (c) { return /^Blaine/i.test(txt(c)); });
      });
      var physHdr = physHdrIdx >= 0 ? rows[physHdrIdx] : [];
      var PHYS_COLS = {
        blaine: colMatching(physHdr, /^Blaine/i),
        r45:    colMatching(physHdr, /^R\s*45/i),
        lce:    colMatching(physHdr, /L\s*\/\s*C\s*Expansion/i),
        cs1:    colMatching(physHdr, /^1\s*Day/i),
        cs2:    colMatching(physHdr, /^2\s*Days?/i),
        cs7:    colMatching(physHdr, /^7\s*Days?/i),
        cs28:   colMatching(physHdr, /^28\s*Days?/i)
      };
      var PHYS_SECTIONS = [
        { id: 'cm1', banner: /^Cement\s*mill\s*-?\s*1$/i },
        { id: 'cm2', banner: /^Cement\s*mill\s*-?\s*2$/i },
        { id: 'ld',  banner: /^Loading$/i }
      ];
      var PHYS_GRADES = [
        { key: '425r',  label: /^[GL]\s*-\s*42\.5\s*R$/i },
        { key: '425n',  label: /^[GL]\s*-\s*42\.5\s*N$/i },
        { key: '325n',  label: /^[GL]\s*-\s*32\.5\s*N$/i },
        { key: 'spot',  label: /^SPOT$/i },
        { key: 'opc',   label: /^[GL]\s*-\s*OPC$/i },
        { key: 'bmill', label: /^B\s*\/\s*Mill$/i }
      ];
      /* The two cells the shared cross-dashboard KPI registry already
         names (forms/formula-registry.js FACTS). They keep their original
         field names — renaming them to the cem_* scheme would orphan the
         blaine-425r and strength-28d KPIs and every row already filed. */
      var PHYS_LEGACY = { 'cm1.425r.blaine': 'blaine_425r', 'cm1.425r.cs28': 'strength_28d' };

      var physEnd = findRowIdx(rows, function (r) { return /^RAWMILL/i.test(txt(r[0])); });
      if (physEnd < 0) physEnd = rows.length;
      var bannerIdx = PHYS_SECTIONS.map(function (s) {
        return findRowIdx(rows, function (r) { return s.banner.test(txt(r[0])); });
      });
      PHYS_SECTIONS.forEach(function (sec, si) {
        var from = bannerIdx[si];
        if (from < 0) return;
        var next = bannerIdx[si + 1];
        var to   = (next > from) ? next : physEnd;
        for (var i = from + 1; i < to && i < rows.length; i++) {
          var label = txt(rows[i][0]);
          PHYS_GRADES.forEach(function (g) {
            if (!g.label.test(label)) return;
            Object.keys(PHYS_COLS).forEach(function (p) {
              var key = sec.id + '.' + g.key + '.' + p;
              var f   = PHYS_LEGACY[key] || ('cem_' + sec.id + '_' + g.key + '_' + p);
              out[f]  = fmt(cell(i, PHYS_COLS[p]), p === 'blaine' ? 0 : 2);
            });
          });
        }
      });

      /* ── Block 2 — COAL MILL ─────────────────────────────────────
         The hourly mill block prints MIN / MAX / AVG / STD. Only AVG is
         a figure about the day; the other three describe its spread. */
      var coalHdrIdx = findRowIdx(rows, function (r) {
        return r.some(function (c) { return /^90\s*Mic/i.test(txt(c)); });
      });
      if (coalHdrIdx >= 0) {
        var coalHdr = rows[coalHdrIdx];
        var coalAvgIdx = -1;
        for (var ci = coalHdrIdx + 1; ci < coalHdrIdx + 8 && ci < rows.length; ci++) {
          if (rows[ci].some(function (c) { return txt(c).toUpperCase() === 'AVG'; })) { coalAvgIdx = ci; break; }
        }
        if (coalAvgIdx >= 0) {
          out.coal_moisture = fmt(cell(coalAvgIdx, colMatching(coalHdr, /^M\.?\s*C\s*%?$/i)), 2);
          out.coal_residue  = fmt(cell(coalAvgIdx, colMatching(coalHdr, /^90\s*Mic/i)), 2);
          out.coal_r212     = fmt(cell(coalAvgIdx, colMatching(coalHdr, /^212\s*Mic/i)), 2);
        }
      }

      /* "DAY AVERAGE FINE COAL" — a header row, a units row ("%",
         "K.cal/Kg"), then one data row. Found by walking down from the
         header to the first row carrying a number, so an extra units or
         spacer row cannot shift the read. */
      var fcHdrIdx = findRowIdx(rows, function (r) {
        return r.some(function (c) { return /^GCV\s*-\s*ADB$/i.test(txt(c)); });
      });
      if (fcHdrIdx >= 0) {
        var fcHdr = rows[fcHdrIdx];
        var FC = {
          coal_im:      colOf(fcHdr, 'IM'),
          coal_vm:      colOf(fcHdr, 'VM'),
          coal_ash:     colOf(fcHdr, 'ASH'),
          coal_gcv_adb: colOf(fcHdr, 'GCV-ADB'),
          coal_gcv_arb: colOf(fcHdr, 'GCV-ARB'),
          coal_ncv_adb: colOf(fcHdr, 'NCV-ADB'),
          coal_ncv_arb: colOf(fcHdr, 'NCV-ARB'),
          coal_sulphur: colOf(fcHdr, 'SULPHUR')
        };
        var fcIdx = -1;
        for (var fi = fcHdrIdx + 1; fi < fcHdrIdx + 6 && fi < rows.length; fi++) {
          if (toNum(rows[fi][FC.coal_im]) !== null) { fcIdx = fi; break; }
        }
        if (fcIdx >= 0) {
          Object.keys(FC).forEach(function (f) {
            out[f] = fmt(cell(fcIdx, FC[f]), /_(gcv|ncv)_/.test(f) ? 0 : 2);
          });
        }
      }

      /* ── Blocks 3-5 — the three four-hourly tables ───────────────
         Raw Mill, Kiln Feed and Clinker, in sheet order. Each is found by
         its own header row: the only rows with a blank first column that
         carry an "LSF" heading. Their six "N to M" rows are then averaged
         into the single day figure the form holds. */
      var PERIOD = /^\d{1,2}\s*to\s*\d{1,2}$/i;
      function periodRows(hdrIdx) {
        var got = [];
        for (var i = hdrIdx + 1; i < rows.length && got.length < 6; i++) {
          if (PERIOD.test(txt(rows[i][0]))) got.push(rows[i]);
          else if (got.length) break;      /* section ended */
        }
        return got;
      }
      function meanOf(rs, col) {
        if (col < 0) return null;
        var v = rs.map(function (r) { return toNum(r[col]); })
                  .filter(function (n) { return n !== null; });
        return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
      }

      var chemHdrIdx = [];
      rows.forEach(function (r, i) {
        if (txt(r[0]) === '' && r.some(function (c) { return txt(c).toUpperCase() === 'LSF'; })) chemHdrIdx.push(i);
      });
      /* [field, heading, nth-occurrence] per table, in sheet order. */
      var CHEM_MAP = [
        { lsf_rm: ['LSF'], sm_rm: ['SM'], am_rm: ['AM'],
          r90_rm1: ['R90', 0], r212_rm1: ['R212', 0],
          r90_rm2: ['R90', 1], r212_rm2: ['R212', 1] },
        { lsf_kf: ['LSF'], sm_kf: ['SM'], am_kf: ['AM'],
          r90_kf: ['R90'], r212_kf: ['R212'] },
        /* free_lime is the clinker's F.CaO — the same column this importer
           always read it from. It used to be written into a "Free Lime"
           row in the FINISHED CEMENT block, which the workbook has no
           column for; the form now carries it in the clinker block where
           it is measured. */
        { ltrwt_ck: ['LTR. WT.'], free_lime: ['F.CaO'],
          lsf_ck: ['LSF'], sm_ck: ['SM'], am_ck: ['AM'],
          c3s_ck: ['C3S'], c2s_ck: ['C2S'], c3a_ck: ['C3A'],
          c4af_ck: ['C4AF'], liquid_ck: ['Liquid'] }
      ];
      chemHdrIdx.slice(0, CHEM_MAP.length).forEach(function (hdrIdx, ti) {
        var hdr = rows[hdrIdx], rs = periodRows(hdrIdx), map = CHEM_MAP[ti];
        if (!rs.length) return;
        Object.keys(map).forEach(function (f) {
          out[f] = fmt(meanOf(rs, colOf(hdr, map[f][0], map[f][1])), f === 'ltrwt_ck' ? 1 : 2);
        });
      });

      if (physHdrIdx < 0 && !chemHdrIdx.length) {
        return { _error: 'No "PHYSICAL LAB REPORT" or four-hourly chemistry tables found. Is this a QC Daily Report?' };
      }
      return out;
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
    /* ── Power Consumption Report ────────────────────────────────────
       Rebuilt 2026-09-22 against a real report (20.09.2026.xlsx) — the
       old version only matched sections by a number in column A, so it
       silently skipped Raw Mill-2, Cement Mill-1, Packing Plant-2 and
       all of Utilities/Colony (there is no section 3 or 6 in the col-A
       numbering; it isn't sequential) and never touched any Production
       (MT) field at all.

       Layout: column B ("Sections") names a section on its FIRST row
       only; column C ("Description") names each equipment/meter line
       under it; column F is that line's On-Date kWh; column G is the
       section's On-Date Production (MT) — entered once, on the section's
       first row, same convention forms/power-form.html's own Section 1
       table now uses (one Production value per section, not per meter).
       A section's own "Total" row (column C) is trusted for its combined
       kWh rather than re-summed here, except where the form still wants
       a sub-split (Raw Mill-1 vs -2), which this sheet's row labels do
       carry.

       Packing Plant-1 vs Plant-2: NOT separable in this sheet — its
       "Packing Section" lists MCCs (IMCC-6, IMCC-6A…), not per-plant
       lines. The section Total goes into pwr_packing_kwh only; the
       combined Specific Power comes out correct either way since the
       form now sums both boxes, but pwr_packing2_kwh is left for manual
       entry if the officer knows the true per-plant split. */
    'power-cons': function (wb) {
      var shName = wb.SheetNames.find(function (n) { return /power.?report/i.test(n) && !/backup/i.test(n); }) || wb.SheetNames[0];
      var ws   = wb.Sheets[shName];
      var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      var SEC = 1, DESC = 2, KWH = 5, PROD = 6;

      var dateVal = '';
      for (var di = 0; di < Math.min(rows.length, 6) && !dateVal; di++) {
        for (var dj = 0; dj < rows[di].length; dj++) {
          dateVal = anyDate(rows[di][dj]);
          if (dateVal) break;
        }
      }

      function findIdx(re, from) {
        for (var i = from || 0; i < rows.length; i++) {
          if (re.test(String(rows[i][SEC] || '').trim())) return i;
        }
        return -1;
      }
      /* First "Total" row (Description column) between [from, end) */
      function totalKwh(from, end) {
        for (var i = from; i < end; i++) {
          if (/^Total$/i.test(String(rows[i][DESC] || '').trim())) return toNum(rows[i][KWH]);
        }
        return null;
      }
      function rowByDesc(re, from, end) {
        for (var i = from; i < end; i++) {
          if (re.test(String(rows[i][DESC] || '').trim())) return rows[i];
        }
        return null;
      }

      var SECTIONS = [
        { re: /Lime\s*Stone\s*Crusher|^Crusher/i,        prod: 'pwr_crusher_prod_mt' },
        { re: /Raw\s*mill\s*Section/i,                   prod: 'pwr_rawmill_prod_mt',   rawmill: true },
        { re: /Coal\s*mill\s*Section/i,                  prod: 'pwr_coalmill_prod_mt',  kwh: 'pwr_coalmill_kwh' },
        { re: /^Kiln\s*Section/i,                        prod: 'pwr_kiln_prod_mt',      kwh: 'pwr_kiln_kwh' },
        { re: /Cement\s*mill\s*-?\s*1\s*Section/i,       prod: 'pwr_cm1_prod_mt',       kwh: 'pwr_cm1_kwh' },
        { re: /Cement\s*mill\s*-?\s*2\s*Section/i,       prod: 'pwr_cm2_prod_mt',       kwh: 'pwr_cm2_kwh' },
        { re: /Packing\s*Section/i,                      prod: 'pwr_packing_prod_mt',   kwh: 'pwr_packing_kwh' },
        { re: /^Utilit(y|ies)/i,                          prod: 'pwr_utilities_prod_mt', utility: true },
      ];
      /* Crusher's own field is 'pwr_crusher_kwh' — added after the map
         above so its key literal doesn't collide with the regex column. */
      SECTIONS[0].kwh = 'pwr_crusher_kwh';

      var starts = SECTIONS.map(function (s) { return findIdx(s.re); });
      var out = { date: dateVal };
      var anyFound = false;

      SECTIONS.forEach(function (s, i) {
        var start = starts[i];
        if (start < 0) return;
        anyFound = true;
        var end = rows.length;
        for (var j = i + 1; j < starts.length; j++) { if (starts[j] >= 0) { end = starts[j]; break; } }

        out[s.prod] = fmt(toNum(rows[start][PROD]), 2);

        if (s.rawmill) {
          var splitIdx = -1;
          for (var k = start; k < end; k++) {
            if (/Raw\s*mill\s*-?\s*2/i.test(String(rows[k][DESC] || ''))) { splitIdx = k; break; }
          }
          var totalIdx = -1;
          for (var t = start; t < end; t++) { if (/^Total$/i.test(String(rows[t][DESC] || '').trim())) { totalIdx = t; break; } }
          if (totalIdx < 0) totalIdx = end;
          function sumKwh(from, to) {
            var sum = 0, found = false;
            for (var r = from; r < to; r++) {
              var lbl = String(rows[r][DESC] || '').trim();
              if (!lbl || /^Total$/i.test(lbl) || /^Target$/i.test(lbl)) continue;
              var v = toNum(rows[r][KWH]);
              if (v !== null) { sum += v; found = true; }
            }
            return found ? sum : null;
          }
          var rm1 = sumKwh(start, splitIdx >= 0 ? splitIdx : totalIdx);
          out.pwr_rawmill_kwh = fmt(rm1, 2);
          if (splitIdx >= 0) out.pwr_rawmill2_kwh = fmt(sumKwh(splitIdx, totalIdx), 2);
        } else if (s.utility) {
          var lightRow = rowByDesc(/Plant\s*Lighting/i, start, end);
          if (lightRow) out.pwr_lighting_kwh = fmt(toNum(lightRow[KWH]), 2);
          var colonyRow = rowByDesc(/Colony\s*Supply/i, start, end);
          if (colonyRow) out.pwr_colony_kwh = fmt(toNum(colonyRow[KWH]), 2);
        } else {
          out[s.kwh] = fmt(totalKwh(start, end), 2);
        }
      });

      if (!anyFound) {
        return { _error: 'Could not find any recognised section ("Lime Stone Crusher", "Rawmill Section", "Packing Section"…). Is this a Power Consumption report?' };
      }
      return out;
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

    /* ── Production Report ───────────────────────────────────────
       Unlike the fixed-cell reports above, this sheet's row COUNT
       shifts day to day — a material row (Bauxite, Mill Dust Iron
       Ore…) is only present when something was actually used that
       day — and even its SPECIFIC POWER header has changed column
       layout between samples (RAW MILL-1/RAW MILL-2 split in one
       month's report, a single combined RAW MILL column in
       another). Confirmed against two real reports three months
       apart (21.04.2026, 01.07.2026): every row is found by matching
       its label text, and the Specific Power block reads its own
       header row to build a column→field map rather than assuming
       fixed positions. A combined "RAW MILL" column (no -1/-2 split)
       fills spc_rm1_kwh only — there is no way to recover the true
       RM1/RM2 split from a single combined figure, and guessing a
       ratio would silently invent numbers. */
    production: function (wb) {
      var shName = wb.SheetNames.find(function (n) { return /^\d{2}\.\d{2}\.\d{4}$/.test(n.trim()); }) || wb.SheetNames[0];
      var ws   = wb.Sheets[shName];
      var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      /* Section-header labels aren't in a consistent column — the sheet
         has "RAW MATERIAL CONSUMPTION"/"PLANT OPERATIONS"/"SPECIFIC
         POWER"/"MATERIAL RETURN…" in column B but "CEMENT GRINDING" one
         column over, in C — so scan the row's leading cells instead of
         trusting one fixed position. */
      function findIdx(re) {
        for (var i = 0; i < rows.length; i++) {
          for (var c = 0; c < 6; c++) {
            if (re.test(String(rows[i][c] || '').trim())) return i;
          }
        }
        return -1;
      }

      /* Date: a "DATE" label cell, value in the next non-empty cell
         to its right — same row it's found on. */
      var dateVal = '';
      for (var di = 0; di < Math.min(rows.length, 8) && !dateVal; di++) {
        var drow = rows[di];
        for (var dj = 0; dj < drow.length; dj++) {
          if (/^DATE$/i.test(String(drow[dj] || '').trim())) {
            for (var dk = dj + 1; dk < drow.length; dk++) {
              dateVal = anyDate(drow[dk]);
              if (dateVal) break;
            }
            break;
          }
        }
      }

      var rawIdx   = findIdx(/^RAW MATERIAL CONSUMPTION/i);
      var cementIdx = findIdx(/^CEMENT GRINDING/i);
      var plantIdx = findIdx(/^PLANT OPERATIONS/i);
      var specIdx  = findIdx(/^SPECIFIC POWER/i);
      var iucIdx   = findIdx(/^MATERIAL RETURN/i);

      if (rawIdx < 0 && plantIdx < 0) {
        return { _error: 'Could not find "RAW MATERIAL CONSUMPTION" or "PLANT OPERATIONS" section. Is this a Production report?' };
      }

      /* Every real sample (Apr + Jul 2026, plus the June master report's
         other sheets) leaves column A blank, so SheetJS's used-range
         starts at column B and every field lands one column left of
         where its letter would suggest — column C ("DESCRIPTION") is
         array index 1, not 2. Detected at runtime off the header itself
         rather than hardcoded, so a file that ever did start at column A
         still lines up instead of quietly reading the wrong cell. */
      var descCol = -1;
      for (var hi = 0; hi < rows.length && descCol < 0; hi++) {
        for (var hc = 0; hc < 8; hc++) {
          if (String(rows[hi][hc] || '').trim().toUpperCase() === 'DESCRIPTION') { descCol = hc; break; }
        }
      }
      var OFF = descCol >= 0 ? (descCol - 1) : 0;

      var out = { date: dateVal };

      /* ── Raw Material Consumption + Cement Grinding ──────────
         Column layout is the same for both tables (open, recv on-date,
         cons on-date), so one pass covers both; `inCement` flips once
         the CEMENT GRINDING header is crossed, which matters only
         because "LIMESTONE" is a material in both tables (raw feed vs.
         a grinding additive) and needs a different field prefix in
         each. */
      var DESC = 1 + OFF, SEC = 2 + OFF, OPEN_C = 3 + OFF, RECV_C = 4 + OFF, CONS_C = 7 + OFF;
      var matStart = rawIdx >= 0 ? rawIdx : 0;
      var matEnd   = plantIdx >= 0 ? plantIdx : rows.length;
      var inCement = false;
      var category = '';
      for (var mi = matStart; mi < matEnd; mi++) {
        var mr = rows[mi];
        var c2 = String(mr[DESC] || '').trim();
        var c3 = String(mr[SEC] || '').trim();
        if (/^CEMENT GRINDING/i.test(c2)) { inCement = true; category = ''; continue; }
        if (c2) category = c2.toUpperCase();
        var CAT  = category;
        var SUB  = c3.toUpperCase();
        var open = fmt(toNum(mr[OPEN_C]), 2);
        var recv = fmt(toNum(mr[RECV_C]), 2);
        var cons = fmt(toNum(mr[CONS_C]), 2);

        if (!inCement) {
          if (c2 === 'LIMESTONE') { out.rmm_limestone_open = open; out.rmm_limestone_recv = recv; out.rmm_limestone_cons = cons; }
          else if (c2 === 'CLAY') { out.rmm_clay_open = open; out.rmm_clay_recv = recv; out.rmm_clay_cons = cons; }
          else if (c2 === 'IRON ORE') { out.rmm_ironore_open = open; out.rmm_ironore_recv = recv; out.rmm_ironore_cons = cons; }
          else if (c2 === 'INDUSTRIAL CLAY') { out.rmm_industrialclay_open = open; out.rmm_industrialclay_recv = recv; out.rmm_industrialclay_cons = cons; }
          else if (c2 === 'BAUXITE') { out.rmm_bauxite_open = open; out.rmm_bauxite_recv = recv; out.rmm_bauxite_cons = cons; }
          else if (/MILL.*DUST.*IRON.*ORE/i.test(c2)) { out.rmm_milldustironore_open = open; out.rmm_milldustironore_recv = recv; out.rmm_milldustironore_cons = cons; }
          else if (CAT === 'COAL' && SUB === 'KILN') { out.coal_kiln_open = open; out.coal_kiln_recv = recv; out.coal_kiln = cons; }
          else if (CAT === 'COAL' && SUB === 'CPP') { out.coal_cpp_open = open; out.coal_cpp_recv = recv; out.coal_cpp = cons; }
        } else {
          if (CAT === 'CLINKER' && SUB === 'OWN') { out.cm_clinker_own_cons = cons; }
          else if (SUB === 'CLINKER PURCHASED') { out.cm_clinker_purch_open = open; out.cm_clinker_purch_recv = recv; out.cm_clinker_purch_cons = cons; }
          else if (c2 === 'LIMESTONE') { out.cm_limestone_recv = recv; out.cm_limestone_cons = cons; }
          else if (c2 === 'GYPSUM') { out.cm_gypsum_open = open; out.cm_gypsum_recv = recv; out.cm_gypsum_cons = cons; }
          else if (SUB === 'STAREX') { out.cm_starex_open = open; out.cm_starex_recv = recv; out.cm_starex_cons = cons; }
          else if (SUB === 'MAPIE') { out.cm_grind_aid_open = open; out.cm_grind_aid_recv = recv; out.cm_grind_aid_cons = cons; }
          else if (/FLY\s*ASH/i.test(SUB) || /FLY\s*ASH/i.test(c2)) { out.cm_flyash_open = open; out.cm_flyash_recv = recv; out.cm_flyash_cons = cons; }
        }
      }

      /* ── Plant Operations ─────────────────────────────────────
         Rated cap / running hours / opening / production / consumption,
         left to right. SKU sub-rows (Cement Mill / Cement Mill-2) carry
         their grade in the same column as the section sub-label above
         (SEC) once the department itself is set in the DESC column. */
      var plantStart = plantIdx >= 0 ? plantIdx : rows.length;
      var plantEnd   = specIdx >= 0 ? specIdx : rows.length;
      var dept = '';
      var RUNHRS_C = 4 + OFF, OPENBAL_C = 7 + OFF, PROD_C = 8 + OFF, PCONS_C = 11 + OFF;
      var CM1_SKU = { '32.5N': 'cm1_325n', '42.5R': 'cm1_425r', '42.5N': 'cm1_425n', 'OPC': 'cm1_opc', '42.5NBM': 'cm1_425n_bm' };
      var CM2_SKU = { '32.5N': 'cm2_325n', '42.5R': 'cm2_425r', '42.5N': 'cm2_425n', 'OPC': 'cm2_opc', '42.5NBM': 'cm2_425n_bm' };
      for (var pi = plantStart; pi < plantEnd; pi++) {
        var pr = rows[pi];
        var pc2 = String(pr[DESC] || '').trim();
        var pc3 = String(pr[SEC] || '').trim();
        if (pc2) dept = pc2.toUpperCase().replace(/\s+/g, ' ').trim();
        var pRunHrs = fmt(toNum(pr[RUNHRS_C]), 2);
        var pOpen   = fmt(toNum(pr[OPENBAL_C]), 2);
        var pProd   = fmt(toNum(pr[PROD_C]), 2);
        var pCons   = fmt(toNum(pr[PCONS_C]), 2);
        var isRM  = /^RAW\s*MILL/.test(dept);
        var isCM1 = /^CEMENT\s*MILL/.test(dept) && !/2/.test(dept);
        var isCM2 = /^CEMENT\s*MILL/.test(dept) && /2/.test(dept);

        if (dept === 'LS CRUSHER') { out.ls_crusher_run_hrs = pRunHrs; out.ls_crusher_open = pOpen; out.ls_crusher_prod_mt = pProd; out.ls_crusher_cons_mt = pCons; }
        else if (isRM && !/2/.test(dept)) { out.rm1_run_hrs = pRunHrs; out.rm1_open = pOpen; out.rm1_prod_mt = pProd; out.rm1_cons_mt = pCons; }
        else if (isRM && /2/.test(dept)) { out.rm2_run_hrs = pRunHrs; out.rm2_prod_mt = pProd; out.rm2_cons_mt = pCons; }
        else if (dept === 'COAL MILL') { out.coalmill_run_hrs = pRunHrs; out.coalmill_open = pOpen; out.coalmill_prod_mt = pProd; out.coalmill_cons_mt = pCons; }
        else if (dept === 'KILN') { out.kiln_run_hrs = pRunHrs; out.kiln_clinker_open = pOpen; out.kiln_prod_mt = pProd; }
        else if (isCM1 || isCM2) {
          var skuKey = pc3.toUpperCase().replace(/\s+/g, '');
          var map = isCM1 ? CM1_SKU : CM2_SKU;
          var pfx = map[skuKey];
          if (pfx) { out[pfx + '_run_hrs'] = pRunHrs; out[pfx + '_open'] = pOpen; out[pfx + '_mt'] = pProd; out[pfx + '_cons_mt'] = pCons; }
        }
      }

      /* ── Specific Power (kWh) — header-driven, see note above ── */
      if (specIdx >= 0) {
        var specEnd = iucIdx >= 0 ? iucIdx : rows.length;
        var hdrRow = null, hdrRowIdx = -1;
        for (var si = specIdx; si < specEnd; si++) {
          if (rows[si].some(function (v) { return /^CRUSHER$/i.test(String(v || '').trim()); })) { hdrRow = rows[si]; hdrRowIdx = si; break; }
        }
        if (hdrRow) {
          var colMap = {};
          for (var ci = 0; ci < hdrRow.length; ci++) {
            var h = String(hdrRow[ci] || '').trim();
            if (!h) continue;
            if (/^CRUSHER$/i.test(h)) colMap[ci] = 'spc_crusher_kwh';
            else if (/RAW\s*MILL/i.test(h)) colMap[ci] = /2/.test(h) ? 'spc_rm2_kwh' : 'spc_rm1_kwh';
            else if (/PYRO/i.test(h)) colMap[ci] = 'spc_kiln_kwh';
            else if (/COAL\s*MILL/i.test(h)) colMap[ci] = 'spc_coalmill_kwh';
            else if (/CEM\s*MILL/i.test(h)) colMap[ci] = 'spc_cemmill_kwh';
            else if (/LOSSES/i.test(h)) colMap[ci] = 'spc_losses_kwh';
            else if (/P\.?\s*PLANT/i.test(h)) colMap[ci] = 'spc_pplant_kwh';
            else if (/OTHERS/i.test(h)) colMap[ci] = 'spc_others_kwh';
          }
          var totRow = null;
          for (var ti = hdrRowIdx; ti < specEnd; ti++) {
            if (/TOTAL\s*UNIT\s*CONSUMED/i.test(String(rows[ti][DESC] || ''))) { totRow = rows[ti]; break; }
          }
          if (totRow) {
            Object.keys(colMap).forEach(function (ci) { out[colMap[ci]] = fmt(toNum(totRow[ci]), 0); });
          }
        }
        /* Coal NCV: label cell, value is the first numeric cell after it */
        for (var ni = specIdx; ni < specEnd && out.coal_ncv == null; ni++) {
          var nrow = rows[ni];
          for (var nci = 0; nci < nrow.length; nci++) {
            if (/COAL\s*NCV/i.test(String(nrow[nci] || ''))) {
              for (var nvj = nci + 1; nvj < nrow.length; nvj++) {
                var nval = toNum(nrow[nvj]);
                if (nval !== null) { out.coal_ncv = fmt(nval, 0); break; }
              }
              break;
            }
          }
        }
      }

      /* ── Internal Use Cement — fixed order after its anchor row,
         since the grade label itself is inconsistently typed (a bare
         number for "42.5", a string for "42.5N") and unsafe to parse. */
      if (iucIdx >= 0) {
        var iucAnchor = -1;
        for (var ii = iucIdx; ii < rows.length; ii++) {
          if (/INTERNAL USE CEMENT/i.test(String(rows[ii][DESC] || ''))) { iucAnchor = ii; break; }
        }
        if (iucAnchor >= 0) {
          var IUC_DAY_C = 4 + OFF;
          ['iuc_425r', 'iuc_425n', 'iuc_325n', 'iuc_opc'].forEach(function (f, k) {
            if (rows[iucAnchor + k]) out[f] = fmt(toNum(rows[iucAnchor + k][IUC_DAY_C]), 2);
          });
        }
      }

      return out;
    },

    /* ── CPP / Power Plant Report ──────────────────────────────────
       Flat "Description | Unit | On Date | MTD | YTD" table — most of
       the form's cpp_* fields map 1:1 to a labelled row, matched by
       text rather than a fixed row number (this sheet keeps a stable
       row order across samples, but text-matching costs nothing and
       survives a row being added/removed). Net Exported, Aux %,
       Average Gen, PLF, Specific Steam/Fuel Consumption and both Heat
       Rate rows are NOT extracted — power-plant-report.html computes
       all seven from the fields this pulls in (see its data-kpi cells
       and the "Auto-calculated" title on the heat-rate inputs), so
       importing them too would just be overwritten on the next
       recalc. Confirmed against the one real sample this app has
       (21.04.2026). */
    cpp: function (wb) {
      var ws   = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      var descCol = -1;
      for (var hi = 0; hi < rows.length && descCol < 0; hi++) {
        for (var hc = 0; hc < 6; hc++) {
          if (/^description$/i.test(String(rows[hi][hc] || '').trim())) { descCol = hc; break; }
        }
      }
      var OFF = descCol >= 0 ? (descCol - 1) : 0;
      var DESC = 1 + OFF, ONDATE = 3 + OFF;

      /* Date: a "DATE" label cell, value in the next non-empty cell —
         this sheet stores it as a real Excel date, not "DD.MM.YYYY"
         text, so it arrives as a serial number that anyDate() already
         converts. */
      var dateVal = '';
      for (var di = 0; di < Math.min(rows.length, 6) && !dateVal; di++) {
        var drow = rows[di];
        for (var dj = 0; dj < drow.length; dj++) {
          if (/^DATE$/i.test(String(drow[dj] || '').trim())) {
            for (var dk = dj + 1; dk < drow.length; dk++) {
              dateVal = anyDate(drow[dk]);
              if (dateVal) break;
            }
            break;
          }
        }
      }

      var LABELS = [
        [/^Gross Power Generation$/i,       'cpp_gross_gen_kwh'],
        [/^Auxiliary Power Consumption$/i,  'cpp_aux_kwh'],   /* the kWhr row — the "( % )" row below shares this text and is skipped by the unit check */
        [/^Plant Running Hours$/i,          'cpp_run_hrs'],
        [/^Feed Water Consumption$/i,       'cpp_feed_water_mt'],
        [/^Boiler Steam Generation$/i,      'cpp_boiler_steam_mt'],
        [/^Bleed Steam$/i,                  'cpp_bleed_steam_mt'],
        [/^Turbine Steam Consumption$/i,    'cpp_turbine_steam_mt'],
        [/^Condensate Generation$/i,        'cpp_condensate_mt'],
        [/^Auxilairy Steam Consumption$/i,  'cpp_aux_steam_mt'],  /* sic — matches the sheet's own misspelling */
        [/^Auxiliary Steam Consumption$/i,  'cpp_aux_steam_mt'],  /* the correctly-spelled variant, in case a future export fixes the typo */
        [/^DG Power Generation$/i,          'cpp_dg_gen_kwh'],
        [/^Coal Consumption$/i,             'cpp_coal_cons'],
        [/^GCV\s*\(\s*ADB\s*\)$/i,          'cpp_coal_gcv'],
        [/^DM Water Generation$/i,          'cpp_dm_water_gen_m3'],
        [/^DM Water Consumption$/i,         'cpp_dm_water_cons_m3'],
        [/^CT Makeup Water Consumption$/i,  'cpp_ct_makeup_m3'],
        [/^Fly Ash to Cement ?mill$/i,      'cpp_flyash_to_cm_mt'],
        [/^Fly Ash to Coalyard/i,           'cpp_flyash_to_coalyard_nos'],
        [/^Fly Ash to Dumpyard/i,           'cpp_flyash_to_dumpyard_nos'],
      ];

      var out = { date: dateVal };
      var unitCol = 2 + OFF;
      rows.forEach(function (r) {
        var label = String(r[DESC] || '').trim();
        if (!label) return;
        var unit = String(r[unitCol] || '').trim();
        /* "Auxiliary Power Consumption" appears twice — once in kWhr,
           once a few rows down in "( % )". Only the kWhr row is a raw
           input; the percentage is computed (cpp_aux_pct). */
        if (/^Auxiliary Power Consumption$/i.test(label) && /%/.test(unit)) return;
        for (var i = 0; i < LABELS.length; i++) {
          if (LABELS[i][0].test(label)) { out[LABELS[i][1]] = fmt(toNum(r[ONDATE]), 2); break; }
        }
      });

      /* "Fly Ash Combustible / GCV" packs two different units into one
         row — only the combustible % (On Date column) is unambiguous;
         its neighbour cell's meaning isn't clear enough in the one
         sample seen to risk assigning it to cpp_flyash_gcv. */
      var flyRow = rows.find(function (r) { return /Fly Ash Combustible/i.test(String(r[DESC] || '')); });
      if (flyRow) out.cpp_flyash_combustible_pct = fmt(toNum(flyRow[ONDATE]), 2);

      /* Coal receipt-by-source lines are free text ("STAMICO:- 66TON"),
         not a labelled table — first number in the matching line. */
      var SOURCES = [
        [/MARKET\s*INSIGHT/i, 'cpp_coal_recv_market_insight'],
        [/^CONNECT/i,         'cpp_coal_recv_connect'],
        [/STAMICO/i,          'cpp_coal_recv_stamico'],
        [/RUVUMA/i,           'cpp_coal_recv_ruvuma'],
        [/MCHEKANAI/i,        'cpp_coal_recv_mchekanai'],
        [/JITEGEMEE/i,        'cpp_coal_recv_jitegemee'],
      ];
      rows.forEach(function (r) {
        var text = String(r[DESC] || '').trim();
        if (!text) return;
        for (var i = 0; i < SOURCES.length; i++) {
          if (SOURCES[i][0].test(text)) {
            var m = text.match(/(\d+(?:\.\d+)?)/);
            if (m) out[SOURCES[i][1]] = fmt(parseFloat(m[1]), 2);
            break;
          }
        }
      });

      var hasData = Object.keys(out).some(function (k) { return k !== 'date' && out[k] !== ''; });
      if (!hasData) {
        return { _error: 'Could not find "Gross Power Generation" or any other CPP row. Is this a Power Plant report?' };
      }
      return out;
    },

    /* ── Stoppage Report ────────────────────────────────────────────
       Nothing like the others: this workbook is a MONTHLY matrix (one
       sheet per equipment section, one row per named fault, one column
       per day of the month), not a single day's snapshot — so a column
       matching the report's own date has to be picked out of each
       sheet first. And the target fields aren't fixed column names —
       every hours box on the page is data-field="stopr_<reasonId>",
       one per row of the governed reason catalogue (see
       forms/stoppage-reasons.js and migration 017), rendered from
       whatever forms/stoppage-reasons.js already cached in
       localStorage on page load. So the match is by (equipment, cause,
       label) against that catalogue, not a hardcoded field map — this
       workbook is in fact the exact source the catalogue was seeded
       from (417 rows, "verbatim"), so an exact label match is expected
       to work rather than needing fuzzy text matching.

       Section → cause is read off the sheet's own row structure: a
       header row (e.g. "Mechanical", "Common") has no value in the
       date column, while every real reason row does (0 counts as a
       value) — that difference is what tells the two apart, since a
       per-section catch-all reason is also just named "Others" and
       would otherwise be indistinguishable from the "Others" section
       header itself. "Common" bundles Planned Maintenance and Power
       Restriction under one heading; split by keyword, same doctrine
       migration 017's own comment describes using to seed the table. */
    stoppage: function (wb) {
      var CACHE_KEY = 'nyati-stoppage-reasons';
      var reasons = null;
      try { reasons = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { /* ignore */ }
      if (!Array.isArray(reasons) || !reasons.length) {
        return { _error: 'The stoppage reason list has not loaded on this page yet. Reload the page (so the reason boxes render), then try Import Excel again.' };
      }
      function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
      var byKey = {};
      reasons.forEach(function (r) { byKey[r.equipment + '|' + r.cause + '|' + norm(r.label)] = r.id; });

      var dateEl = document.querySelector('[data-field="date"]');
      var targetDate = (dateEl && dateEl.value) ? dateEl.value : (function () {
        var d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      }());

      var SHEET_EQUIP = [
        [/^crusher/i, 'crusher'], [/raw\s*mill/i, 'rm'], [/coal\s*mill/i, 'cm_coal'],
        [/cement\s*mill\s*-?\s*1/i, 'cm1'], [/cement\s*mill\s*-?\s*2/i, 'cm2'],
        [/^kiln/i, 'kiln'], [/packing/i, 'packing'],
      ];

      var out = { date: targetDate };
      var anySheetMatched = false;

      wb.SheetNames.forEach(function (shName) {
        var equip = null;
        for (var si = 0; si < SHEET_EQUIP.length; si++) {
          if (SHEET_EQUIP[si][0].test(shName)) { equip = SHEET_EQUIP[si][1]; break; }
        }
        if (!equip) return; /* e.g. the derived "Summary" sheet */

        var ws   = wb.Sheets[shName];
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

        var hdrIdx = -1;
        for (var hi = 0; hi < Math.min(rows.length, 10); hi++) {
          if (anyDate(rows[hi][1])) { hdrIdx = hi; break; }
        }
        if (hdrIdx < 0) return;
        var hdr = rows[hdrIdx];
        var dateCol = -1;
        for (var ci = 1; ci < hdr.length; ci++) {
          if (anyDate(hdr[ci]) === targetDate) { dateCol = ci; break; }
        }
        if (dateCol < 0) return; /* this workbook doesn't cover the report's date */
        anySheetMatched = true;

        /* Section order is POSITIONAL, not text-matched — every sheet
           carries exactly 5 section headers in this fixed order, but
           the header TEXT isn't reliable (Cement Mill -1's 5th header
           is literally the number 3, not the word "Others"; matches
           migration 017's own note about this). A header row is any
           row with a label but no value in the date column; three more
           header-shaped rows follow the real 5 (CRITICAL/MEDIUM/Under
           Control severity bands) and are excluded rather than treated
           as a 6th section. */
        var SECTION_ORDER = ['mech', 'ei', 'prod', 'COMMON', 'other'];
        var sectionIdx = -1;
        for (var ri = hdrIdx + 1; ri < rows.length; ri++) {
          var label = String(rows[ri][0] || '').trim();
          if (!label) continue;
          var cellVal = rows[ri][dateCol];
          if (cellVal === '' || cellVal == null) {
            if (/CRITICAL|MEDIUM|Under\s*Control/i.test(label)) continue;
            if (sectionIdx < SECTION_ORDER.length - 1) sectionIdx++;
            continue;
          }
          if (sectionIdx < 0) continue;
          var section = SECTION_ORDER[sectionIdx];
          var cause = section;
          if (section === 'COMMON') {
            if (/planned/i.test(label)) cause = 'planned';
            else if (/power|restrict/i.test(label)) cause = 'power';
            else continue;
          }
          var reasonId = byKey[equip + '|' + cause + '|' + norm(label)];
          if (reasonId == null) continue;
          var hrs = toNum(cellVal);
          if (hrs !== null) out['stopr_' + reasonId] = fmt(hrs, 2);
        }
      });

      if (!anySheetMatched) {
        return { _error: 'Could not find ' + targetDate + ' as a day column in any equipment sheet. Set the report date in the toolbar first, or check this workbook covers that month.' };
      }
      return out;
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
          '<button id="_xi-apply" style="padding:7px 20px;border-radius:6px;border:none;background:#F49545;font-family:Inter,sans-serif;font-size:12px;font-weight:700;cursor:pointer;color:var(--on-orange)">Apply ' + matched.length + ' Fields →</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);
    modal.querySelector('#_xi-cancel').addEventListener('click', function () { modal.remove(); });
    modal.querySelector('#_xi-apply').addEventListener('click', function () {
      var count = applyToForm(data);
      modal.remove();
      /* Trigger kpi-live recalc */
      document.dispatchEvent(new CustomEvent('nyati:restored'));
      /* Imported figures ARE the person's work, but they arrive by script and
         so do not look like typing to form-persist.js — tell it, or they would
         only be saved if the user remembered to press Save Draft. */
      if (window.NyatiPersist && typeof window.NyatiPersist.markDirty === 'function') window.NyatiPersist.markDirty();
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
