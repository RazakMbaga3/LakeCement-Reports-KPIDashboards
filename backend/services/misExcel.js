/*
  services/misExcel.js — turns a misReport payload into an .xlsx buffer
  (exceljs). One "KPI Summary" sheet plus one sheet per form. Nyati brand
  colors on headers; numbers stay numbers so Excel can chart them.

  DESIGN NOTES (2026-10-14 export-quality pass)
  ---------------------------------------------
  This plant runs on Excel: every report here began as a workbook a manager
  emailed round, and the MD/Plant Head read these files beside those. The
  earlier version of this module dumped `Field | Value` with the raw database
  column as the caption and no unit — "Coal Kiln | 204" with no way to tell
  MT from kWh — so the export looked like a downgrade from the workbook it
  replaced. This version follows the plant's own report conventions:

    * a title block (company, report name, date/range, generated-at) so a
      printed or emailed sheet is self-describing, exactly as the plant's
      own workbooks are;
    * three columns — Measure | Unit | Value — with the readable name and
      the unit from services/misFieldMeta.js (authority: the formula
      registry and the stores config, NOT a guess);
    * real Excel number formats (#,##0.00) so 171080 reads as 171,080, and
      dates as dates;
    * frozen header rows and an autofilter, because the monthly sheets run
      to ~100 columns × 31 rows and are unusable without them;
    * targets printed WITH their signage ("< 780", ">= 2,000"): a bare
      "Target 3 / Actual 3.3" cannot be read as pass or fail;
    * print setup (landscape, fit-to-width, repeating header) so Ctrl-P
      gives a usable page instead of 40 sheets of spill.

  HONESTY RULE (project-wide, non-negotiable)
  -------------------------------------------
  A missing value is written as a genuinely EMPTY cell — never 0, never a
  placeholder. `asNumber` returns null for null/undefined/'' and exceljs
  writes null as a blank cell. An exported 0 that actually meant "not
  reported" is precisely the defect this project's data-integrity audit
  exists to prevent, so the "not reported" note in the title block tells
  the reader what a blank means rather than letting them assume zero.
  Nothing in this file substitutes, defaults or back-fills a figure.
*/

const ExcelJS = require('exceljs');
const { kpiStatus } = require('./misRender');
const meta = require('./misFieldMeta');

const NAVY   = 'FF173158';
const ORANGE = 'FFF49545';
const LIGHT  = 'FFEEF2F7';
const GREY   = 'FF64748B';

const COMPANY = 'LAKE CEMENT LTD — NYATI CEMENT';

function styleHeaderRow(row, color) {
  row.eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color || NAVY } };
    c.alignment = { vertical: 'middle', wrapText: true };
    c.border = { bottom: { style: 'thin', color: { argb: NAVY } } };
  });
  row.height = 22;
}

/* ── Title block ──────────────────────────────────────────────────────
   Mirrors the heading every plant workbook carries (company, report name,
   date) so a sheet that gets printed or forwarded still says what it is.
   Callers add their own header row immediately after this returns. */
function addTitleBlock(ws, title, subtitle, width, generatedAt) {
  const span = Math.max(3, width);
  const put = (text, opts) => {
    const row = ws.addRow([text]);
    ws.mergeCells(row.number, 1, row.number, span);
    const c = row.getCell(1);
    c.font = opts.font;
    c.alignment = { vertical: 'middle' };
    if (opts.height) row.height = opts.height;
    return row;
  };

  put(COMPANY, { font: { bold: true, size: 12, color: { argb: NAVY } }, height: 18 });
  put(title,   { font: { bold: true, size: 14, color: { argb: NAVY } }, height: 20 });
  if (subtitle) put(subtitle, { font: { size: 10, color: { argb: GREY } } });

  const gen = generatedAt ? new Date(generatedAt) : new Date();
  put(`Generated ${gen.toLocaleString('en-GB')} · Lake Cement Ltd — internal use only`,
    { font: { size: 9, italic: true, color: { argb: GREY } } });
  /* Say explicitly what an empty cell means, so nobody reads a blank as a
     zero in a management meeting. */
  put('A blank cell means the figure was not reported — it does not mean zero.',
    { font: { size: 9, italic: true, color: { argb: GREY } } });

  /* Orange brand rule under the block. */
  const rule = ws.addRow([]);
  ws.mergeCells(rule.number, 1, rule.number, span);
  rule.height = 4;
  rule.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ORANGE } };

  ws.addRow([]);
}

/* Lay out columns without exceljs's ws.columns (which writes its own header
   row at row 1 and would sit above the title block). */
function applyColumns(ws, cols) {
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });
}

/* A printed MIS pack should fit the page, not spill one column per sheet. */
function setupPrint(ws, headerRow, landscape) {
  ws.pageSetup = {
    orientation: landscape ? 'landscape' : 'portrait',
    fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    paperSize: 9,                                  // A4
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
  };
  ws.headerFooter = { oddFooter: '&L' + COMPANY + '&CPage &P of &N&R&D' };
  if (headerRow) ws.pageSetup.printTitlesRow = `${headerRow}:${headerRow}`;
}

function asNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isNaN(n) ? String(v) : n;
}

/* Sheet names: ≤31 chars, no []:*?/\ */
function sheetName(s) {
  return s.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31);
}

/* Target with its signage, so pass/fail is readable: "< 780", ">= 2,000".
   Without it, a free-lime target of 3 and a kiln target of 2000 look like
   the same kind of number and the reader cannot tell which way is good. */
function targetText(k) {
  if (k.target == null) return null;
  const n = asNumber(k.target);
  const shown = typeof n === 'number'
    ? n.toLocaleString('en-US', { maximumFractionDigits: k.dp ?? 2 })
    : String(k.target);
  return k.signage ? `${k.signage} ${shown}` : shown;
}

function addKpiSheet(wb, kpis, valueHeader, benchmarks, title, subtitle, generatedAt) {
  const ws = wb.addWorksheet('KPI Summary', { views: [{ state: 'frozen' }] });

  const cols = [
    { header: 'KPI', width: 42 }, { header: 'Unit', width: 18 },
    { header: 'Target', width: 14 }, { header: valueHeader, width: 16 },
  ];
  if (benchmarks) {
    cols.push({ header: 'Prev month', width: 13 }, { header: 'Same month LY', width: 14 },
              { header: 'Best ever', width: 13 }, { header: 'Best (when)', width: 12 });
  }
  cols.push({ header: 'Status', width: 14 }, { header: 'Override note', width: 50 });
  applyColumns(ws, cols);

  addTitleBlock(ws, title, subtitle, cols.length, generatedAt);
  const header = ws.addRow(cols.map(c => c.header));
  styleHeaderRow(header, NAVY);
  ws.views = [{ state: 'frozen', ySplit: header.number }];

  for (const k of kpis) {
    const st = kpiStatus(k);
    const vals = [
      k.label, k.unit || '',
      targetText(k),
      k.value == null ? null : asNumber(k.value),
    ];
    if (benchmarks) {
      const b = benchmarks[k.key] || {};
      vals.push(
        b.prevMonth && b.prevMonth.value != null ? asNumber(b.prevMonth.value) : null,
        b.lastYear && b.lastYear.value != null ? asNumber(b.lastYear.value) : null,
        b.bestEver ? asNumber(b.bestEver.value) : null,
        b.bestEver ? b.bestEver.period : null,
      );
    }
    vals.push(st.text,
      k.overridden && k.override ? `${k.override.by || ''}: ${k.override.reason || ''}` : '');
    const row = ws.addRow(vals);

    /* Each KPI carries its own decimal precision from the registry, so a
       kcal/kg figure is not shown to two places and a ratio is not rounded
       to a whole number. */
    const fmt = (k.dp ?? 2) === 0 ? '#,##0' : '#,##0.' + '0'.repeat(k.dp ?? 2);
    const valueCols = benchmarks ? [4, 5, 6, 7] : [4];
    for (const ci of valueCols) row.getCell(ci).numFmt = fmt;
    row.getCell(3).alignment = { horizontal: 'right' };

    const statusCol = benchmarks ? 9 : 5;
    if (st.text) {
      row.getCell(statusCol).font = { bold: true, color: { argb: st.cls === 'ok' ? 'FF239557' : 'FFDC2626' } };
    }
    if (k.overridden) {
      row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
    }
  }

  ws.autoFilter = {
    from: { row: header.number, column: 1 },
    to:   { row: ws.rowCount, column: cols.length },
  };
  setupPrint(ws, header.number, !!benchmarks);
  return ws;
}

/* ── Daily workbook: KPI sheet + one measure/value sheet per form ── */
async function dailyWorkbook(p) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lake Cement MIS';
  wb.created = new Date();

  const dateText = new Date(p.date + 'T00:00:00').toLocaleDateString('en-GB',
    { day: '2-digit', month: 'long', year: 'numeric' });

  addKpiSheet(wb, p.kpis, 'Value', null,
    'Daily MIS Report — Key Performance Indicators',
    dateText + (p.missing && p.missing.length
      ? '  ·  No submission received for: ' + p.missing.join(', ')
      : ''),
    p.generatedAt);

  for (const f of p.forms) {
    const ws = wb.addWorksheet(sheetName(f.label));
    const cols = [
      { header: 'Measure', width: 46 },
      { header: 'Unit', width: 12 },
      { header: 'Value', width: 16 },
    ];
    applyColumns(ws, cols);

    const sub = [
      dateText,
      f.shift && f.shift !== 'day' ? f.shift + ' shift' : null,
      'Submitted by ' + (f.submittedBy || 'not recorded'),
      'status: ' + f.status,
    ].filter(Boolean).join('  ·  ');

    addTitleBlock(ws, f.label, sub, cols.length, p.generatedAt);
    const header = ws.addRow(cols.map(c => c.header));
    styleHeaderRow(header, ORANGE);
    ws.views = [{ state: 'frozen', ySplit: header.number }];

    /* Day figures first, then the running totals, each under its own
       sub-heading. Mixing them silently let an MTD total be read as a
       figure for the day. */
    const dayFields = f.fields.filter(fl => !meta.isPeriodAggregate(fl.key));
    const aggFields = f.fields.filter(fl =>  meta.isPeriodAggregate(fl.key));

    const addSection = (label, fields) => {
      if (!fields.length) return;
      if (label) {
        const sr = ws.addRow([label]);
        ws.mergeCells(sr.number, 1, sr.number, cols.length);
        sr.getCell(1).font = { bold: true, size: 10, color: { argb: NAVY } };
        sr.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
      }
      for (const fl of fields) {
        const m = meta.fieldMeta(fl.key);
        const row = ws.addRow([m.label || fl.label, m.unit, asNumber(fl.value)]);
        const c = row.getCell(3);
        if (typeof c.value === 'number') c.numFmt = m.numFmt;
      }
    };

    addSection(aggFields.length ? 'Figures for the day' : null, dayFields);
    addSection('Month / year to date (running totals)', aggFields);

    ws.autoFilter = {
      from: { row: header.number, column: 1 },
      to:   { row: ws.rowCount, column: cols.length },
    };
    setupPrint(ws, header.number, false);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ── Monthly workbook: KPI sheet + day-by-day sheet per form ──── */
async function monthlyWorkbook(p) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lake Cement MIS';
  wb.created = new Date();

  const rangeText = `${p.monthName} ${p.year}  (${p.from} to ${p.to})`;

  addKpiSheet(wb, p.kpis, `Actual ${p.monthName} ${p.year}`, p.benchmarks,
    'Monthly MIS Report — Key Performance Indicators',
    rangeText + '  ·  Manual overrides are highlighted and noted',
    p.generatedAt);

  for (const f of p.forms) {
    const ws = wb.addWorksheet(sheetName(f.label));
    const fieldMetas = f.fields.map(fl => ({ ...meta.fieldMeta(fl.key), fallback: fl.label }));
    const width = fieldMetas.length + 1;

    ws.getColumn(1).width = 14;
    fieldMetas.forEach((m, i) => { ws.getColumn(i + 2).width = 16; });

    addTitleBlock(ws, f.label + ' — day by day', rangeText, Math.min(width, 12), p.generatedAt);

    /* Two header rows: the measure name, then its unit. The plant's own
       workbooks caption a column and print the unit beneath it, and with
       ~100 columns there is no room to repeat "(MT)" in every name. */
    const nameRow = ws.addRow(['Date'].concat(fieldMetas.map(m => m.label || m.fallback)));
    styleHeaderRow(nameRow, ORANGE);
    const unitRow = ws.addRow([''].concat(fieldMetas.map(m => m.unit || '')));
    unitRow.eachCell(c => {
      c.font = { italic: true, size: 9, color: { argb: GREY } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
      c.alignment = { vertical: 'middle' };
    });

    /* Freeze the date column as well as the headers — scrolling right
       through 100 columns is meaningless without it. */
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: unitRow.number }];

    for (const d of f.days) {
      const row = ws.addRow(
        [d.date + (d.shift !== 'day' ? ` (${d.shift})` : '')].concat(d.values.map(asNumber)));
      fieldMetas.forEach((m, i) => {
        const c = row.getCell(i + 2);
        if (typeof c.value === 'number') c.numFmt = m.numFmt;
      });
    }

    /* Column totals, but only where adding up is meaningful. A sum of daily
       tonnes or kWh is a real monthly figure. A sum of percentages, ratios,
       calorific values or running MTD totals is nonsense — and so is a sum
       of STOCK LEVELS: adding 30 daily opening balances gives a number that
       looks like a quantity but means nothing. Blank days are skipped by
       SUM(), so a total never implies a zero was reported. */
    const SUMMABLE = new Set(['MT', 'kWh', 'min', 'Hrs', 'Litres', 'bags', 'Nos', 'm3']);
    const isBalance = key => /_(open|clos|min|max)$/.test(String(key || ''));
    const firstDataRow = unitRow.number + 1;
    if (ws.rowCount >= firstDataRow) {
      const lastDataRow = ws.rowCount;
      const totals = ['Total'].concat(fieldMetas.map((m, i) => {
        if (!SUMMABLE.has(m.unit) || meta.isPeriodAggregate(m.key) || isBalance(m.key)) return null;
        const col = ws.getColumn(i + 2).letter;
        return { formula: `SUM(${col}${firstDataRow}:${col}${lastDataRow})` };
      }));
      const tr = ws.addRow(totals);
      tr.eachCell(c => {
        c.font = { bold: true, size: 10, color: { argb: NAVY } };
        c.border = { top: { style: 'thin', color: { argb: NAVY } } };
      });
      fieldMetas.forEach((m, i) => {
        const c = tr.getCell(i + 2);
        if (c.value) c.numFmt = m.numFmt;
      });
    }

    // zebra striping for readability
    for (let i = firstDataRow + 1; i <= ws.rowCount; i += 2) {
      ws.getRow(i).eachCell(c => {
        if (!c.fill || c.fill.pattern !== 'solid') {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
        }
      });
    }

    setupPrint(ws, unitRow.number, true);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { dailyWorkbook, monthlyWorkbook, targetText, asNumber };
