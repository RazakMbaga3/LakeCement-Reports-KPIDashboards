/*
  services/misExcel.js — turns a misReport payload into an .xlsx buffer
  (exceljs). One "KPI Summary" sheet plus one sheet per form. Nyati brand
  colors on headers; numbers stay numbers so Excel can chart them.
*/

const ExcelJS = require('exceljs');
const { kpiStatus } = require('./misRender');

const NAVY   = 'FF173158';
const ORANGE = 'FFF49545';
const LIGHT  = 'FFEEF2F7';

function styleHeaderRow(row, color) {
  row.eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color || NAVY } };
    c.alignment = { vertical: 'middle' };
  });
  row.height = 18;
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

function addKpiSheet(wb, kpis, valueHeader) {
  const ws = wb.addWorksheet('KPI Summary');
  ws.columns = [
    { header: 'KPI', width: 42 }, { header: 'Unit', width: 10 },
    { header: 'Target', width: 12 }, { header: valueHeader, width: 16 },
    { header: 'Status', width: 14 }, { header: 'Override', width: 50 },
  ];
  styleHeaderRow(ws.getRow(1), NAVY);

  for (const k of kpis) {
    const st = kpiStatus(k);
    const row = ws.addRow([
      k.label, k.unit || '',
      k.target == null ? null : asNumber(k.target),
      k.value == null ? null : asNumber(k.value),
      st.text,
      k.overridden && k.override ? `${k.override.by || ''}: ${k.override.reason || ''}` : '',
    ]);
    if (st.text) {
      row.getCell(5).font = { bold: true, color: { argb: st.cls === 'ok' ? 'FF239557' : 'FFDC2626' } };
    }
    if (k.overridden) {
      row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
    }
  }
  return ws;
}

/* ── Daily workbook: KPI sheet + one field/value sheet per form ── */
async function dailyWorkbook(p) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lake Cement MIS';

  addKpiSheet(wb, p.kpis, `Value ${p.date}`);

  for (const f of p.forms) {
    const ws = wb.addWorksheet(sheetName(f.label));
    ws.columns = [{ header: 'Field', width: 40 }, { header: 'Value', width: 18 }];
    styleHeaderRow(ws.getRow(1), ORANGE);
    for (const fl of f.fields) ws.addRow([fl.label, asNumber(fl.value)]);
    ws.addRow([]);
    ws.addRow(['Submitted by', f.submittedBy || '—']);
    ws.addRow(['Status', f.status]);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ── Monthly workbook: KPI sheet + day-by-day sheet per form ──── */
async function monthlyWorkbook(p) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lake Cement MIS';

  addKpiSheet(wb, p.kpis, `Actual ${p.monthName} ${p.year}`);

  for (const f of p.forms) {
    const ws = wb.addWorksheet(sheetName(f.label));
    ws.columns = [{ header: 'Date', width: 12 }]
      .concat(f.fields.map(fl => ({ header: fl.label, width: 15 })));
    styleHeaderRow(ws.getRow(1), ORANGE);
    for (const d of f.days) {
      ws.addRow([d.date + (d.shift !== 'day' ? ` (${d.shift})` : '')].concat(d.values.map(asNumber)));
    }
    // zebra striping for readability
    for (let i = 3; i <= ws.rowCount; i += 2) {
      ws.getRow(i).eachCell(c => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
      });
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { dailyWorkbook, monthlyWorkbook };
