/*
  services/misReport.js — gathers everything a daily or monthly MIS report
  needs into one plain payload object. Rendering lives elsewhere
  (misRender.js → printable HTML, misExcel.js → XLSX); this module is the
  single source for WHAT goes in a report.
*/

const db       = require('../db');
const engine   = require('./formulaEngine');
const insights = require('./insights');
const stores   = require('./stores');
const { REPORTED_STATUSES } = require('../config/forms');

/* Display names + section order for the report */
/* Retired 'power-plant' (2026-08-31): no page submitted it and it never held
   a row, so it showed as a form that was missed every single day. */
const FORM_LABELS = {
  'production':   'Production Summary',
  'quality':      'Quality Control',
  'pile-quality': 'Pile Quality (CaO)',
  'limestone':    'Limestone Crushing',
  'mines':        'Mines / Quarry',
  'materials':    'Raw Materials',
  'power-cons':   'Power Consumption',
  'cpp':          'CPP Operation',
  'dispatch':     'Dispatch',
  'stoppage':     'Stoppages',
};
const FORM_ORDER = Object.keys(FORM_LABELS);

/* kiln_prod_mt → "Kiln Prod Mt"; keys starting with _ are internal */
function prettifyField(key) {
  return key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function cleanData(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (k.startsWith('_') || v === '' || v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/* ── Daily report payload ──────────────────────────────────── */
async function gatherDaily(date) {
  const rows = await db.query(
    `SELECT r.form_type, r.shift, r.data, r.status, r.submitted_at, r.updated_at, u.full_name AS submitted_by_name
     FROM daily_reports r LEFT JOIN users u ON r.submitted_by = u.id
     WHERE r.record_date = $1 AND r.status = ANY($2)
     ORDER BY r.form_type, r.shift`,
    [date, REPORTED_STATUSES]
  );

  const forms = [];
  for (const formType of FORM_ORDER) {
    const formRows = rows.rows.filter(r => r.form_type === formType);
    for (const r of formRows) {
      const data = cleanData(r.data);
      if (!Object.keys(data).length) continue;
      forms.push({
        formType,
        label: FORM_LABELS[formType] || formType,
        shift: r.shift,
        /* The real column (migration 010), not the legacy data._status blob
           form-persist.js used to write before an approval workflow existed. */
        status: r.status || 'submitted',
        submittedBy: r.submitted_by_name,
        submittedAt: r.updated_at || r.submitted_at,
        fields: Object.entries(data).map(([k, v]) => ({ key: k, label: prettifyField(k), value: v })),
      });
    }
  }

  const missing = FORM_ORDER.filter(f => !forms.some(x => x.formType === f));

  // Daily KPI values from the formula layer (single day range)
  const daily = await engine.evalDaily(date, date);
  const kpis = Object.values(daily)
    .map(k => ({ ...k, value: k.series.length ? k.series[0].value : null }))
    .map(({ series, inputs, ...rest }) => rest); // eslint-disable-line no-unused-vars

  return { kind: 'daily', date, forms, missing, kpis, generatedAt: new Date().toISOString() };
}

/* ── Entry-completeness payload (for a calendar heatmap) ──────────────
   Same "row exists with non-empty data" rule as gatherDaily's `missing`
   list, extended across a date range in one query instead of looping
   gatherDaily per day. Read-only / retrospective — does not touch
   cutoff-lateness (that's watchdog.js's same-day alerting concern). */
async function gatherCompleteness(from, to) {
  const rows = await db.query(
    `SELECT record_date, form_type, data
     FROM daily_reports
     WHERE record_date BETWEEN $1 AND $2 AND status = ANY($3)`,
    [from, to, REPORTED_STATUSES]
  );

  // present[date][formType] = true if any row for that date+form has
  // non-empty cleaned data (a form can have multiple shifts; one non-empty
  // shift is enough to count the day as covered)
  const present = {};
  for (const r of rows.rows) {
    const date = String(r.record_date).slice(0, 10);
    if (!Object.keys(cleanData(r.data)).length) continue;
    (present[date] || (present[date] = {}))[r.form_type] = true;
  }

  const days = [];
  for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    days.push({
      date,
      forms: FORM_ORDER.map(formType => ({
        formType,
        label: FORM_LABELS[formType] || formType,
        present: !!(present[date] && present[date][formType]),
      })),
    });
  }

  return { kind: 'completeness', from, to, forms: FORM_ORDER.map(f => ({ formType: f, label: FORM_LABELS[f] })), days };
}

/* ── Monthly report payload ────────────────────────────────── */
async function gatherMonthly(year, month) {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to   = `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;

  // KPIs: monthly aggregates (overrides applied) + the daily series behind
  // them + historical benchmarks (prev month / last year / best-ever)
  const [kpis, daily, benchmarks] = await Promise.all([
    engine.evalMonth(year, month),
    engine.evalDaily(from, to),
    insights.benchmark(year, month),
  ]);
  const series = Object.fromEntries(Object.entries(daily).map(([k, v]) => [k, v.series]));
  const benchByKey = Object.fromEntries(benchmarks.map(b => [b.key, b]));

  // Per-form day-by-day table: union of field keys across the month
  const rows = await db.query(
    `SELECT form_type, record_date, shift, data
     FROM daily_reports
     WHERE record_date BETWEEN $1 AND $2 AND status = ANY($3)
     ORDER BY form_type, record_date, shift`,
    [from, to, REPORTED_STATUSES]
  );

  const forms = [];
  for (const formType of FORM_ORDER) {
    const formRows = rows.rows.filter(r => r.form_type === formType);
    if (!formRows.length) continue;
    const fieldKeys = [];
    for (const r of formRows) {
      for (const k of Object.keys(cleanData(r.data))) {
        if (!fieldKeys.includes(k)) fieldKeys.push(k);
      }
    }
    forms.push({
      formType,
      label: FORM_LABELS[formType] || formType,
      fields: fieldKeys.map(k => ({ key: k, label: prettifyField(k) })),
      days: formRows.map(r => ({
        date: r.record_date, shift: r.shift,
        values: fieldKeys.map(k => (cleanData(r.data)[k] ?? null)),
      })),
    });
  }

  return {
    kind: 'monthly', year, month, from, to,
    monthName: new Date(year, month - 1, 1).toLocaleString('en-GB', { month: 'long' }),
    kpis, series, forms, benchmarks: benchByKey, generatedAt: new Date().toISOString(),
  };
}

/* ── Daily Summary Report ──────────────────────────────────────────
   The one-page "DAILY SUMMARY REPORT dd.mm.yyyy" table that covers the
   eight MIS workbooks in the plant head's morning mail — Mining, Stock
   and Production, every row carrying ON DATE / MTD / YTD. Rebuilt here
   from data the app already holds so the Executive Summary can speak in
   the numbers he checks first, not only in monthly KPI averages.

   Sourcing was verified cell-for-cell against the 30.08.2026 workbook
   set (2026-09-02). Where the app cannot produce a line, the line is
   still returned with available:false and a reason — the plant head
   should see at a glance what the dashboard does not yet cover, rather
   than find a row he knows by heart quietly missing.

     Production   → `production` daily report
       Clinker           kiln_prod_mt         (Plant Operations, KILN → Production)
       Cement            Σ CM-1 + CM-2 grades (CEMENT MILL TOTAL + CEMENT MILL-2 TOTAL)
       Coal for Clinker  coalmill_cons_mt     (COAL MILL → Consumption: fine coal fired)
       Coal for CPP      coal_cpp             (Raw Material Consumption, COAL / CPP)

     Stock        → `materials` daily report, through the SAME closing-stock
       arithmetic the Stores dashboard uses (stores._snapshotRows), so the
       two pages can never disagree. Iron Ore 3,148.95 · Gypsum 1,036.52 ·
       Clinker 562.18 · Coal 3,870.38 all reconciled to the workbook.

     Raw Mill pile → `production` closing stock (opening + received −
       consumed). This is NOT the quarry stockyard stock the plant head's
       sheet shows: on 30.08.2026 limestone read 3,335 MT at the crusher
       pile and 63,820 MT in the quarry ledger. Reported under its own
       heading rather than mislabelled as the quarry figure.

     Mining       → weighbridge_tickets, keyed on the same movement-type
       strings mines-report.html parses.

   Deliberately NOT sourced (returned as unavailable, never estimated):
     • Quarry stockyard stock — HG / LG / HGHMGO / Clay / ID Clay. Lives in
       the Quarry dashboard, whose opening balances are still client-side.
     • Surface Miner hours and fuel (KSM-1 / KSM-2) — no form captures them.
     • "Max For Pre Rains" — a hand-set seasonal threshold on the plant
       head's sheet, not a value the app stores.
*/

const FY_START_MONTH = 4;   // fiscal year runs April → March (workbook convention)

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
/* Sum of `fields`, or null when the record carries none of them.
   The difference matters: the 15 Jul 2026 production row holds only the
   four generic placeholder keys, so summing it as zeros would report
   "Coal for CPP: 0 MT" for a day nobody filed a coal figure on. A blank
   reads as "not entered"; a zero reads as "nothing was consumed", and the
   plant head would act on the second. */
function sumFields(data, fields) {
  let total = 0, seen = false;
  for (const f of fields) {
    const v = data[f];
    if (v === undefined || v === null || v === '') continue;
    seen = true;
    total += num(v);
  }
  return seen ? total : null;
}
function round2(v) {
  return v === null || v === undefined ? null : Math.round(v * 100) / 100;
}

function fiscalYearStart(date) {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return (m >= FY_START_MONTH ? y : y - 1) + '-' + String(FY_START_MONTH).padStart(2, '0') + '-01';
}
function monthStart(date) { return date.slice(0, 8) + '01'; }

/* The Production Report's cement total. Deliberately the same eight fields
   as forms/formula-registry.js's CM_GRADES so this figure and the
   clinker-factor KPI cannot drift apart. CM-1's 42.5N BM production has no
   field on the form at all — only its opening, run-hours and stock-ledger
   consumption exist, and no stored row carries cm1_425n_bm_mt — so that
   mill-grade is absent from both, not just from here. */
const CEMENT_GRADE_FIELDS = [
  'cm1_425r_mt', 'cm1_425n_mt', 'cm1_325n_mt', 'cm1_opc_mt',
  'cm2_425r_mt', 'cm2_425n_mt', 'cm2_425n_bm_mt', 'cm2_325n_mt',
];

const PRODUCTION_ROWS = [
  { key: 'clinker',      label: 'Clinker',          unit: 'MT', fields: ['kiln_prod_mt'] },
  { key: 'cement',       label: 'Cement',           unit: 'MT', fields: CEMENT_GRADE_FIELDS },
  { key: 'coal_clinker', label: 'Coal for Clinker', unit: 'MT', fields: ['coalmill_cons_mt'] },
  { key: 'coal_cpp',     label: 'Coal for CPP',     unit: 'MT', fields: ['coal_cpp'] },
];

/* Raw-mill pile closing stock from the production report's own ledger.
   `f` is the field prefix: <f>_open + <f>_recv − <f>_cons. */
const RAW_MILL_PILE_ROWS = [
  { key: 'rmm_limestone',       f: 'rmm_limestone',       label: 'Limestone (crusher pile)' },
  { key: 'rmm_clay',            f: 'rmm_clay',            label: 'Clay' },
  { key: 'rmm_industrialclay',  f: 'rmm_industrialclay',  label: 'Industrial Clay' },
  { key: 'rmm_bauxite',         f: 'rmm_bauxite',         label: 'Bauxite' },
  { key: 'rmm_milldustironore', f: 'rmm_milldustironore', label: 'Mill Dust Iron Ore' },
];

/* Movement-type strings exactly as the Odoo weighbridge exports them —
   the same constants mines-report.html matches on. */
const MV = {
  S_CR: 'South Mine to Pile (through Crusher)',
  S_DP: 'South Mine to Direct Pile (Bypass Crusher)',
  S_SY: 'South Mine to Stock Yard',
  S_WD: 'South Mine to Golani Waste dump',
  N_CR: 'North Mine to Pile (through Crusher)',
  N_DP: 'North Mine to Direct Pile (Bypass Crusher)',
  N_SY: 'North Mine to Stock Yard',
  N_WD: 'North Mine to Golani Waste dump',
  Y_CR: 'Stock Yard to Pile (through Crusher)',
  Y_DP: 'Stock Yard to Direct Pile (Bypass Crusher)',
};

const MINING_ROWS = [
  { key: 'south_pile', label: 'South Mine to Pile',       movements: [MV.S_CR, MV.S_DP] },
  { key: 'south_yard', label: 'South Mine to Stock Yard', movements: [MV.S_SY] },
  { key: 'south_dump', label: 'South Mine to Dump',       movements: [MV.S_WD] },
  { key: 'north_pile', label: 'North Mine to Pile',       movements: [MV.N_CR, MV.N_DP] },
  { key: 'north_yard', label: 'North Mine to Stock Yard', movements: [MV.N_SY] },
  { key: 'north_dump', label: 'North Mine to Dump',       movements: [MV.N_WD] },
  { key: 'yard_pile',  label: 'Stock Yard to Pile',       movements: [MV.Y_CR, MV.Y_DP] },
];

/* Quarry stockyard grades the plant head's sheet lists that the server has
   no ledger for yet. Named explicitly so each row appears with its reason
   instead of vanishing from a report he reads every morning. */
const QUARRY_STOCK_ROWS = [
  { key: 'hg', label: 'HG' },
  { key: 'lg', label: 'LG' },
  { key: 'hghmgo', label: 'HGHMGO' },
  { key: 'id_clay', label: 'ID Clay' },
  { key: 'clay', label: 'Clay' },
];

/* below-min / above-max — the only judgment the source sheet's Action
   column ever carries. Null when the threshold itself was never entered. */
function stockStatus(closing, min, max) {
  if (closing === null || closing === undefined) return null;
  if (min !== null && min !== undefined && closing < min) return 'below_min';
  if (max !== null && max !== undefined && closing > max) return 'above_max';
  return 'ok';
}

async function gatherDailySummary(date) {
  const fyFrom = fiscalYearStart(date);
  const moFrom = monthStart(date);

  const [prodRows, matRow, mining] = await Promise.all([
    db.query(
      `SELECT record_date, data FROM daily_reports
       WHERE form_type = 'production' AND record_date BETWEEN $1 AND $2
         AND status = ANY($3)
       ORDER BY record_date`,
      [fyFrom, date, REPORTED_STATUSES]
    ),
    db.query(
      `SELECT data FROM daily_reports
       WHERE form_type = 'materials' AND record_date = $1 AND status = ANY($2)
       ORDER BY shift LIMIT 1`,
      [date, REPORTED_STATUSES]
    ),
    /* One grouped pass over the fiscal year rather than shipping every
       ticket to Node — a busy quarry books thousands of rows a month. */
    db.query(
      `SELECT movement_type,
              COALESCE(SUM(net_qty) FILTER (WHERE ticket_date = $2), 0) AS on_date,
              COALESCE(SUM(net_qty) FILTER (WHERE ticket_date >= $3), 0) AS mtd,
              COALESCE(SUM(net_qty), 0) AS ytd
       FROM weighbridge_tickets
       WHERE ticket_date BETWEEN $1 AND $2
       GROUP BY movement_type`,
      [fyFrom, date, moFrom]
    ),
  ]);

  /* ── Production ── */
  const onDateProd = prodRows.rows.find(r => String(r.record_date).slice(0, 10) === date);
  const production = PRODUCTION_ROWS.map(row => {
    /* Accumulate only the days that actually carry the field, and stay null
       if none of them do — an empty period must not read as a real zero. */
    let mtd = null, ytd = null;
    for (const r of prodRows.rows) {
      const v = sumFields(r.data || {}, row.fields);
      if (v === null) continue;
      ytd = (ytd || 0) + v;
      if (String(r.record_date).slice(0, 10) >= moFrom) mtd = (mtd || 0) + v;
    }
    const onDate = onDateProd ? sumFields(onDateProd.data || {}, row.fields) : null;
    return {
      key: row.key, label: row.label, unit: row.unit,
      onDate: round2(onDate), mtd: round2(mtd), ytd: round2(ytd),
      available: onDate !== null || ytd !== null,
    };
  });

  /* ── Stock: Stores ledger (materials form) ──
     Through stores._snapshotRows so closing stock here is arithmetically
     the same figure the Stores dashboard shows, special cases included. */
  const stockRows = matRow.rows.length ? stores._snapshotRows(matRow.rows[0].data || {}) : [];
  const byField = Object.fromEntries(stockRows.map(r => [r.field, r]));
  const pickStock = (field, label) => {
    const r = byField[field];
    return {
      key: field, label,
      closing: r ? round2(r.closing) : null,
      min: r ? r.min : null,
      max: r ? r.max : null,
      status: r ? stockStatus(r.closing, r.min, r.max) : null,
      available: !!r,
    };
  };

  /* Coal is one line on the plant head's sheet but is entered per supplier
     across the kiln and CPP sections — the workbook's own "TOTAL RAW COAL"
     row. Its min/max are likewise the sum of whichever supplier thresholds
     were entered, which is how the sheet derives kiln's 10,000 / 18,000
     from two suppliers each carrying 5,000 / 9,000. */
  const coalRows = stockRows.filter(r => r.category === 'coal' && r.closing !== null);
  const coalMins = coalRows.map(r => r.min).filter(v => v !== null && v !== undefined);
  const coalMaxs = coalRows.map(r => r.max).filter(v => v !== null && v !== undefined);
  const coalClosing = coalRows.length ? coalRows.reduce((s, r) => s + num(r.closing), 0) : null;
  const coalMin = coalMins.length ? coalMins.reduce((s, v) => s + v, 0) : null;
  const coalMax = coalMaxs.length ? coalMaxs.reduce((s, v) => s + v, 0) : null;

  const storesStock = [
    pickStock('iron_ore', 'Iron Ore'),
    {
      key: 'coal_total', label: 'Coal (Kiln + CPP)',
      closing: round2(coalClosing), min: coalMin, max: coalMax,
      status: stockStatus(coalClosing, coalMin, coalMax),
      available: coalRows.length > 0,
    },
    pickStock('clinker', 'Clinker'),
    pickStock('gypsum', 'Gypsum'),
  ];

  /* ── Stock: raw-mill pile (production form's own ledger) ── */
  const pileData = onDateProd ? (onDateProd.data || {}) : null;
  const rawMillStock = RAW_MILL_PILE_ROWS.map(row => {
    const opening = pileData ? sumFields(pileData, [row.f + '_open']) : null;
    const received = pileData ? sumFields(pileData, [row.f + '_recv']) : null;
    const consumed = pileData ? sumFields(pileData, [row.f + '_cons']) : null;
    const entered = opening !== null || received !== null || consumed !== null;
    return {
      key: row.key, label: row.label,
      closing: entered ? round2(num(opening) + num(received) - num(consumed)) : null,
      min: null, max: null, status: null,
      available: entered,
    };
  });
  const pileAvailable = rawMillStock.some(r => r.available);

  /* ── Mining ── */
  const mvTotals = Object.fromEntries(mining.rows.map(r => [r.movement_type, r]));
  const miningAvailable = mining.rows.length > 0;
  const miningRows = MINING_ROWS.map(row => {
    let onDate = 0, mtd = 0, ytd = 0;
    for (const mv of row.movements) {
      const t = mvTotals[mv];
      if (!t) continue;
      onDate += num(t.on_date);
      mtd    += num(t.mtd);
      ytd    += num(t.ytd);
    }
    return {
      key: row.key, label: row.label, unit: 'MT',
      onDate: miningAvailable ? round2(onDate) : null,
      mtd:    miningAvailable ? round2(mtd)    : null,
      ytd:    miningAvailable ? round2(ytd)    : null,
      available: miningAvailable,
    };
  });

  const unavailable = (rows, reason) => rows.map(r => ({
    key: r.key, label: r.label, available: false, reason,
    onDate: null, mtd: null, ytd: null, closing: null, min: null, max: null, status: null,
  }));

  return {
    kind: 'daily-summary',
    date, monthFrom: moFrom, fiscalFrom: fyFrom,
    daysWithProduction: prodRows.rows.length,
    sections: [
      {
        key: 'mining', label: 'Mining Report', columns: ['onDate', 'mtd', 'ytd'],
        available: miningAvailable,
        note: miningAvailable ? null
          : 'No weighbridge tickets loaded for this fiscal year — import them on the Quarry page.',
        rows: miningRows.concat(unavailable(
          [{ key: 'ksm1_hours', label: 'Surface Miner KSM-1 — hours' },
           { key: 'ksm1_fuel',  label: 'Surface Miner KSM-1 — fuel (Ltr)' },
           { key: 'ksm2_hours', label: 'Surface Miner KSM-2 — hours' },
           { key: 'ksm2_fuel',  label: 'Surface Miner KSM-2 — fuel (Ltr)' }],
          'No form in the dashboard captures surface-miner hours or fuel yet.'
        )),
      },
      {
        key: 'stock', label: 'Stock Report — Stores Ledger', columns: ['closing', 'min', 'max'],
        available: stockRows.length > 0,
        note: stockRows.length ? null : 'No Raw Materials report entered for this date.',
        rows: storesStock,
      },
      {
        key: 'raw_mill_stock', label: 'Stock Report — Raw Mill Pile', columns: ['closing'],
        available: pileAvailable,
        note: pileAvailable
          ? 'Closing stock at the plant, from the Production Report ledger. Not the quarry stockyard figure — see the Quarry page for that.'
          : 'No raw-material stock entered on this date’s Production Report. (This ledger holds plant closing stock, not the quarry stockyard figure — see the Quarry page for that.)',
        rows: rawMillStock,
      },
      {
        key: 'quarry_stock', label: 'Stock Report — Quarry Stockyard', columns: ['closing'],
        available: false,
        note: 'The quarry stockyard ledger still keeps its opening balances on the Quarry page rather than on the server, so these grades cannot be reported here yet.',
        /* No per-row reason: the card note already gives it once, and the
           same sentence repeated down five rows is noise, not candour. */
        rows: unavailable(QUARRY_STOCK_ROWS, null),
      },
      {
        key: 'production', label: 'Production Report', columns: ['onDate', 'mtd', 'ytd'],
        available: production.some(r => r.available),
        note: onDateProd ? null
          : 'No Production Report entered for this date — MTD and YTD still cover the days that were entered.',
        rows: production,
      },
    ],
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { gatherDaily, gatherMonthly, gatherCompleteness, gatherDailySummary, FORM_LABELS, prettifyField };
