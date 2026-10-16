/*
  test/mis-export-quality.test.js — guards the quality of the MIS exports
  (services/misExcel.js, misRender.js, misFieldMeta.js).

  These assert the things a manager actually notices when the file lands in
  their inbox, and the one rule this project does not bend: a figure that was
  never reported must arrive EMPTY, never as a zero or a placeholder.

  Pure unit tests — fixture payloads shaped like misReport.gatherDaily /
  gatherMonthly output. No database, no network.
*/

const { test } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');

const meta = require('../services/misFieldMeta');
const excel = require('../services/misExcel');
const render = require('../services/misRender');

/* ── Fixtures ──────────────────────────────────────────────────────── */

const DAILY = {
  kind: 'daily',
  date: '2026-04-21',
  generatedAt: '2026-04-22T03:00:00.000Z',
  missing: ['pile-quality', 'mines'],
  kpis: [
    { key: 'kiln-output', label: 'Kiln Output', unit: 'MT', dp: 0,
      target: 2000, signage: '>=', value: 1210 },
    { key: 'ste', label: 'Specific Thermal Energy Consumption', unit: 'kcal/kg',
      dp: 0, target: 780, signage: '<', value: 916 },
    /* Not reported for the day — must stay empty end to end. */
    { key: 'bags-packed', label: 'Bags Packed', unit: 'bags', dp: 0,
      target: 7000, signage: '>=', value: null },
  ],
  forms: [
    {
      formType: 'production', label: 'Production Summary', shift: 'day',
      status: 'approved', submittedBy: 'Godhania Natha',
      fields: [
        { key: 'kiln_prod_mt',   label: 'Kiln Prod Mt',   value: 1210 },
        { key: 'coal_kiln',      label: 'Coal Kiln',      value: 204 },
        { key: 'spc_rm1_kwh',    label: 'Spc Rm1 Kwh',    value: 52317 },
        { key: 'rm2_run_hrs',    label: 'Rm2 Run Hrs',    value: 13 },
        { key: 'bag_425r_max',   label: 'Bag 425r Max',   value: 800000 },
        { key: 'dsl_pmh_cons',   label: 'Dsl Pmh Cons',   value: 553 },
        /* not reported */
        { key: 'cm1_425r_mt',    label: 'Cm1 425r Mt',    value: null },
        { key: 'gypsum_cons_mtd', label: 'Gypsum Cons Mtd', value: 980 },
      ],
    },
  ],
};

const MONTHLY = {
  kind: 'monthly', year: 2026, month: 6, from: '2026-06-01', to: '2026-06-30',
  monthName: 'June', generatedAt: '2026-07-01T03:00:00.000Z',
  kpis: DAILY.kpis,
  benchmarks: {
    'kiln-output': {
      prevMonth: { period: '2026-05', value: 1452 },
      lastYear:  { period: '2025-06', value: null },
      bestEver:  { period: '2026-08', value: 2046 },
    },
  },
  forms: [
    {
      formType: 'production', label: 'Production Summary',
      fields: [
        { key: 'kiln_prod_mt',    label: 'Kiln Prod Mt' },
        { key: 'coal_ncv',        label: 'Coal Ncv' },
        { key: 'rm1_open',        label: 'Rm1 Open' },
        { key: 'gypsum_cons_mtd', label: 'Gypsum Cons Mtd' },
      ],
      days: [
        { date: '2026-06-01', shift: 'day', values: [1300, 5472, 1267.64, 100] },
        { date: '2026-06-02', shift: 'day', values: [1400, 5408, null, 200] },
      ],
    },
  ],
};

async function load(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}
/* Row index of the data header, found by its first cell. */
function headerRow(ws, firstCell) {
  for (let r = 1; r <= ws.rowCount; r++) {
    if (String(ws.getRow(r).getCell(1).value || '').trim() === firstCell) return r;
  }
  throw new Error('header row "' + firstCell + '" not found');
}
function colValues(ws, from, col) {
  const out = [];
  for (let r = from; r <= ws.rowCount; r++) out.push(ws.getRow(r).getCell(col).value);
  return out;
}

/* ══ 1. The honesty rule ══════════════════════════════════════════════ */

test('a KPI that was not reported exports as an empty cell, not zero', async () => {
  const ws = (await load(await excel.dailyWorkbook(DAILY))).getWorksheet('KPI Summary');
  const h = headerRow(ws, 'KPI');
  const row = colValues(ws, h + 1, 1).indexOf('Bags Packed') + h + 1;
  const cell = ws.getRow(row).getCell(4);
  assert.strictEqual(cell.value, null, 'unreported KPI must be blank');
  assert.notStrictEqual(cell.value, 0);
});

test('a form field that was not reported exports as an empty cell, not zero', async () => {
  const ws = (await load(await excel.dailyWorkbook(DAILY))).getWorksheet('Production Summary');
  const h = headerRow(ws, 'Measure');
  const labels = colValues(ws, h + 1, 1);
  const i = labels.findIndex(v => String(v || '').startsWith('CM-1 42.5R'));
  assert.ok(i >= 0, 'CM-1 42.5R row present');
  assert.strictEqual(ws.getRow(h + 1 + i).getCell(3).value, null);
});

test('asNumber never turns a missing value into a number', () => {
  for (const v of [null, undefined, '']) assert.strictEqual(excel.asNumber(v), null);
  assert.strictEqual(excel.asNumber('1,210'), 1210);
  assert.strictEqual(excel.asNumber(0), 0);          // a real reported zero survives
});

test('both exports state that a blank does not mean zero', async () => {
  const wb = await load(await excel.dailyWorkbook(DAILY));
  const text = [];
  wb.getWorksheet('KPI Summary').getSheetValues()
    .forEach(r => r && r.forEach(c => c && text.push(String(c))));
  assert.match(text.join(' '), /blank cell means .* not reported/i);
  assert.match(render.renderDailyHtml(DAILY), /does not mean zero/i);
});

/* ══ 2. Units and terminology ═════════════════════════════════════════ */

test('field units come from the formula registry / stores config, not a guess', () => {
  assert.equal(meta.unitFor('kiln_prod_mt'), 'MT');
  assert.equal(meta.unitFor('spc_rm1_kwh'), 'kWh');
  assert.equal(meta.unitFor('rm2_run_hrs'), 'Hrs');
  assert.equal(meta.unitFor('coal_ncv'), 'kcal/kg');
  assert.equal(meta.unitFor('stop_cm1_other'), 'min');
  /* Blaine is m²/kg per docs/KPI_REFERENCE.md — not cm²/g. */
  assert.equal(meta.unitFor('blaine_425r'), 'm²/kg');
  /* Packing bags are counts and diesel is litres — NOT tonnes. Getting
     these wrong turns an 800,000-bag re-order level into 800,000 MT. */
  assert.equal(meta.unitFor('bag_425r_max'), 'bags');
  assert.equal(meta.unitFor('dsl_pmh_cons'), 'Litres');
  assert.equal(meta.unitFor('gypsum_max'), 'MT');
});

test('an unknown field gets no unit rather than an invented one', () => {
  assert.equal(meta.unitFor('some_field_nobody_declared'), '');
  /* Moduli are genuinely dimensionless, and must not acquire a unit. */
  assert.equal(meta.unitFor('lsf_ck'), '');
  assert.equal(meta.unitFor('am_kf'), '');
});

test('labels use the plant\'s terminology, not database column names', () => {
  assert.equal(meta.labelFor('kiln_prod_mt'), 'Kiln Production');
  assert.equal(meta.labelFor('coal_kiln'), 'Coal to Kiln');
  assert.equal(meta.labelFor('cm1_425r_mt'), 'CM-1 42.5R');
  assert.equal(meta.labelFor('rm2_run_hrs'), 'RM-2 Running Hours');
  assert.equal(meta.labelFor('stop_cm1_other'), 'CM-1 stoppage — Other');
  assert.equal(meta.labelFor('stop_cm_coal_mech'), 'Coal Mill stoppage — Mechanical');
  /* No raw key should survive into a caption. */
  for (const k of ['kiln_prod_mt', 'spc_rm1_kwh', 'dsl_pmh_cons']) {
    assert.ok(!meta.labelFor(k).includes('_'), k + ' label still contains an underscore');
  }
});

test('the unit is not repeated inside the label', () => {
  assert.ok(!/\bMt\b/.test(meta.labelFor('kiln_prod_mt')));
  assert.ok(!/Kwh/.test(meta.labelFor('spc_rm1_kwh')));
});

test('running totals are marked as MTD/YTD, not shown as a day figure', () => {
  assert.ok(meta.isPeriodAggregate('gypsum_cons_mtd'));
  assert.ok(meta.isPeriodAggregate('clinker_rcvd_ytd'));
  assert.ok(!meta.isPeriodAggregate('kiln_prod_mt'));
  assert.match(meta.labelFor('gypsum_cons_mtd'), /MTD/);
});

test('the daily sheet separates day figures from running totals', async () => {
  const ws = (await load(await excel.dailyWorkbook(DAILY))).getWorksheet('Production Summary');
  const all = ws.getSheetValues().flat().filter(Boolean).map(String);
  assert.ok(all.some(v => /Figures for the day/i.test(v)));
  assert.ok(all.some(v => /running totals/i.test(v)));
});

/* ══ 3. Readability / self-describing file ════════════════════════════ */

test('every sheet carries a company + report + date title block', async () => {
  const wb = await load(await excel.dailyWorkbook(DAILY));
  for (const ws of wb.worksheets) {
    const head = ws.getSheetValues().slice(0, 7).flat().filter(Boolean).map(String).join(' ');
    assert.match(head, /LAKE CEMENT LTD/, ws.name + ' has no company header');
    assert.match(head, /21 April 2026/, ws.name + ' does not state the report date');
  }
});

test('the monthly workbook states the date range it covers', async () => {
  const wb = await load(await excel.monthlyWorkbook(MONTHLY));
  const head = wb.getWorksheet('KPI Summary').getSheetValues()
    .slice(0, 7).flat().filter(Boolean).map(String).join(' ');
  assert.match(head, /June 2026/);
  assert.match(head, /2026-06-01 to 2026-06-30/);
});

test('numbers carry a thousands separator and sensible decimals', async () => {
  const ws = (await load(await excel.dailyWorkbook(DAILY))).getWorksheet('Production Summary');
  const h = headerRow(ws, 'Measure');
  const labels = colValues(ws, h + 1, 1);
  const i = labels.findIndex(v => String(v || '').includes('Power RM-1'));
  const cell = ws.getRow(h + 1 + i).getCell(3);
  assert.equal(cell.value, 52317);                 // still a number, so Excel can chart it
  assert.match(cell.numFmt, /#,##0/);              // ...but displayed 52,317
});

test('targets print with their signage so pass/fail is readable', async () => {
  const ws = (await load(await excel.dailyWorkbook(DAILY))).getWorksheet('KPI Summary');
  const h = headerRow(ws, 'KPI');
  const labels = colValues(ws, h + 1, 1);
  const kiln = ws.getRow(h + 1 + labels.indexOf('Kiln Output')).getCell(3).value;
  const ste  = ws.getRow(h + 1 + labels.indexOf('Specific Thermal Energy Consumption')).getCell(3).value;
  assert.equal(kiln, '>= 2,000');
  assert.equal(ste, '< 780');
  /* A target with no signage must not gain a fake one. */
  assert.equal(excel.targetText({ target: null }), null);
});

test('headers are frozen and filterable, and the sheet is set up to print', async () => {
  const wb = await load(await excel.dailyWorkbook(DAILY));
  const ws = wb.getWorksheet('KPI Summary');
  assert.ok(ws.views && ws.views[0] && ws.views[0].ySplit > 0, 'header row not frozen');
  assert.ok(ws.autoFilter, 'no autofilter');
  assert.equal(ws.pageSetup.fitToWidth, 1);
  const monthly = (await load(await excel.monthlyWorkbook(MONTHLY)))
    .getWorksheet('Production Summary');
  /* ~100 columns: the date column must stay on screen too. */
  assert.equal(monthly.views[0].xSplit, 1);
  assert.equal(monthly.pageSetup.orientation, 'landscape');
});

test('the monthly day-by-day sheet puts the unit under each column', async () => {
  const ws = (await load(await excel.monthlyWorkbook(MONTHLY)))
    .getWorksheet('Production Summary');
  const h = headerRow(ws, 'Date');
  assert.deepEqual(
    [2, 3, 4].map(c => ws.getRow(h).getCell(c).value),
    ['Kiln Production', 'Coal NCV', 'RM-1 Opening Stock']);
  assert.deepEqual(
    [2, 3, 4].map(c => ws.getRow(h + 1).getCell(c).value),
    ['MT', 'kcal/kg', 'MT']);
});

/* ══ 4. Totals that would mislead are left out ════════════════════════ */

test('monthly totals are only added where summing is meaningful', async () => {
  const ws = (await load(await excel.monthlyWorkbook(MONTHLY)))
    .getWorksheet('Production Summary');
  const last = ws.getRow(ws.rowCount);
  assert.equal(last.getCell(1).value, 'Total');
  /* Tonnes per day add up to a real monthly figure. */
  assert.ok(last.getCell(2).value && last.getCell(2).value.formula,
    'kiln production should be totalled');
  /* A calorific value, a stock balance and a running MTD total do not. */
  assert.equal(last.getCell(3).value, null, 'kcal/kg must not be summed');
  assert.equal(last.getCell(4).value, null, 'an opening stock balance must not be summed');
  assert.equal(last.getCell(5).value, null, 'an MTD running total must not be summed');
});

/* ══ 5. The two export formats agree ══════════════════════════════════ */

test('the HTML print view uses the same labels and units as the Excel', () => {
  const html = render.renderDailyHtml(DAILY);
  for (const label of ['Kiln Production', 'Coal to Kiln', 'RM-2 Running Hours']) {
    assert.ok(html.includes(label), 'print view missing label: ' + label);
  }
  assert.ok(!/Kiln Prod Mt/.test(html), 'print view still shows a raw column name');
  assert.match(html, /<th[^>]*>Unit<\/th>/);
});

test('the print view shows an unreported value as a dash, never 0', () => {
  const html = render.renderMonthlyHtml(MONTHLY);
  assert.ok(html.includes('—'), 'no em-dash placeholder for missing data');
  assert.equal(render.fmt(null), '—');
  assert.equal(render.fmt(''), '—');
  assert.equal(render.fmt(0), '0');     // a real reported zero still shows
});
