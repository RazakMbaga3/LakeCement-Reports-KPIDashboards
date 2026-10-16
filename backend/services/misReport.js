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
const overburden = require('./overburden');
const crusher    = require('./crusher');
const { RAWMAT_VIEW_ROLES, MINES_VIEW_ROLES } = require('../../forms/access-registry.js');
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
       strings mines-report.html parses — for what is WEIGHED. Two things
       on the plant head's Mining block are not weighed and come from
       elsewhere (2026-10-15):
       • Overburden → Odoo's Waste Material Entry, mirrored by
         services/odooWasteSync.js (services/overburden.js reads it). The
         old "South / North Mine to Dump" rows were keyed on weighbridge
         movements no ticket has ever carried, so they were permanently
         "unavailable" while the real figure sat in Odoo. Tonnage there is
         trips × a fixed load per trip, and the section note says so.
       • Crusher production, apron-feeder hours and TPH → the Production
         Report's ls_crusher_prod_mt / ls_crusher_apron_hrs
         (services/crusher.js). TPH for a period is Σproduction ÷ Σapron
         hours over the days that carry both, never a mean of daily TPHs.

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

/* The Production Report's cement total — read from the registry rather than
   restated here. This used to be a local eight-field copy kept "deliberately
   the same as CM_GRADES so the two cannot drift apart", justified by CM-1
   42.5N BM having no form field and no stored value. Both stopped being true
   once the Odoo autofill began filling cm1_425n_bm_mt, and because the copy
   matched the registry, both stayed wrong together. One list removes the
   possibility of that, rather than relying on two being kept in step. */
const { CEMENT_GRADES: CEMENT_GRADE_FIELDS } = require('../../forms/formula-registry.js');

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

/* "South / North Mine to Dump" (MV.S_WD / MV.N_WD) were rows here until
   2026-10-15. Not one weighbridge ticket has ever carried either movement —
   overburden is hauled by trip count, not weighed — so both rows were
   permanently "unavailable". They are replaced by the overburden rows built
   from Odoo's Waste Material Entry in gatherDailySummary(); the mine split
   is NOT carried over, because Odoo records the mine only in free-text
   remarks and presenting a parsed split as fact would be inventing it. */
const MINING_ROWS = [
  { key: 'south_pile', label: 'South Mine to Pile',       movements: [MV.S_CR, MV.S_DP] },
  { key: 'south_yard', label: 'South Mine to Stock Yard', movements: [MV.S_SY] },
  { key: 'north_pile', label: 'North Mine to Pile',       movements: [MV.N_CR, MV.N_DP] },
  { key: 'north_yard', label: 'North Mine to Stock Yard', movements: [MV.N_SY] },
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

/* Which section a role may see. The Daily Summary puts raw-material stock
   and quarry movements on the Executive Summary — the one page every role
   can open — so the payload itself is filtered, not just the rendering.
   kpi-data.js applies the same rule client-side; this is the half that
   holds when someone calls the endpoint directly.

   Production carries no gate: Kiln Output, Despatch/Day and Specific Heat
   Consumption have always been on the Executive Summary for every role
   that can see it, so this section exposes nothing new.

   A section key with no entry here is withheld — a future section has to
   state its own audience rather than inherit "visible to all" by
   omission. */
const DAILY_SUMMARY_SECTION_ROLES = {
  production:     null,                 // null = no additional gate
  mining:         MINES_VIEW_ROLES,
  stock:          RAWMAT_VIEW_ROLES,
  raw_mill_stock: RAWMAT_VIEW_ROLES,
  quarry_stock:   RAWMAT_VIEW_ROLES,
};

function canSeeSection(key, role) {
  if (!Object.prototype.hasOwnProperty.call(DAILY_SUMMARY_SECTION_ROLES, key)) return false;
  const allowed = DAILY_SUMMARY_SECTION_ROLES[key];
  return allowed === null || allowed.includes(role);
}

async function gatherDailySummary(date, role) {
  const fyFrom = fiscalYearStart(date);
  const moFrom = monthStart(date);

  const [prodRows, matRow, mining, ob] = await Promise.all([
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
    /* Overburden (Odoo Waste Material Entry, approved entries only). A
       server whose database predates migration 041 has no mirror table:
       that one case degrades to an explained "unavailable" row rather than
       failing the whole summary. Every other error still propagates. */
    overburden.overburdenTotals(date, moFrom, fyFrom).catch(err => {
      if (err && err.code === '42P01') return null;
      throw err;
    }),
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

  /* ── Stock: Stores ledger ──
     The four lines the plant head reads first — Iron Ore, Coal (Kiln + CPP),
     Clinker, Gypsum — and where each CLOSING figure comes from:

       up to 2026-06-30   the Raw Material report (materials form) through
                          stores._snapshotRows, as before — those days are
                          the plant's own typed Excel ledger.
       from 2026-07-01    the verified Production Report stock ledger
                          (services/odooStockLedger.js): the plant's own
                          30-Jun closing rolled forward with Odoo's flows.

     Why the switch (2026-10-16): from 1 Jul the only materials rows are the
     Odoo autofill's, whose opening chain starts from ZERO on 2026-08-31
     (odooMaterialsAutofill.carryForwardOpening) — on 14 Oct it read clinker
     4,898 t and coal ~19,300 t against a real pile of ~9,000 t, and this
     section printed those numbers as stock. The verified ledger reproduces
     the plant's own 30.08.2026 sheet — Iron Ore 3,148.95 (exact), Clinker
     562.18 (562.21 = own 341.35 + purchased 220.86), Gypsum 1,036.52
     (1,037.36), Coal 3,870.38 (3,839.76: one truck the plant booked a day
     before Odoo validated it) — and lands on Odoo's live stock today. See
     config/odooStockLedger.js for every check.

     A line with no verified figure is returned unavailable WITH its reason
     (an Odoo day not approved yet, a closing that would be negative, the
     ledger not computed on this server) — never the materials chain as a
     fallback for these dates, and never a zero. Min/max stay the officer's
     thresholds from the Raw Material report: they are policy, not stock. */
  const stockLedger = require('./odooStockLedger');
  const { ANCHOR: STOCK_ANCHOR } = require('../config/odooStockLedger');

  const matStockRows = matRow.rows.length ? stores._snapshotRows(matRow.rows[0].data || {}) : [];
  const byField = Object.fromEntries(matStockRows.map(r => [r.field, r]));

  /* Coal is one line on the plant head's sheet but is entered per supplier
     across the kiln and CPP sections — the workbook's own "TOTAL RAW COAL"
     row. Its min/max are likewise the sum of whichever supplier thresholds
     were entered, which is how the sheet derives kiln's 10,000 / 18,000
     from two suppliers each carrying 5,000 / 9,000. */
  const coalRows = matStockRows.filter(r => r.category === 'coal' && r.closing !== null);
  const sumOrNull = vals => {
    const v = vals.filter(x => x !== null && x !== undefined);
    return v.length ? v.reduce((s, x) => s + x, 0) : null;
  };
  const thresholds = {
    iron_ore:   { min: byField.iron_ore ? byField.iron_ore.min : null, max: byField.iron_ore ? byField.iron_ore.max : null },
    coal_total: { min: sumOrNull(coalRows.map(r => r.min)), max: sumOrNull(coalRows.map(r => r.max)) },
    clinker:    { min: byField.clinker ? byField.clinker.min : null, max: byField.clinker ? byField.clinker.max : null },
    gypsum:     { min: byField.gypsum ? byField.gypsum.min : null, max: byField.gypsum ? byField.gypsum.max : null },
  };

  /* line key -> label, the materials-form source (≤ anchor), and the
     verified ledger(s) it is the sum of (> anchor). */
  const STOCK_LINES = [
    { key: 'iron_ore',   label: 'Iron Ore',          materials: () => (byField.iron_ore ? byField.iron_ore.closing : null), has: () => !!byField.iron_ore, ledgers: ['iron_ore'] },
    { key: 'coal_total', label: 'Coal (Kiln + CPP)', materials: () => (coalRows.length ? coalRows.reduce((s, r) => s + num(r.closing), 0) : null), has: () => coalRows.length > 0, ledgers: ['coal'] },
    { key: 'clinker',    label: 'Clinker',           materials: () => (byField.clinker ? byField.clinker.closing : null), has: () => !!byField.clinker, ledgers: ['clinker_own', 'clinker_purchased'] },
    { key: 'gypsum',     label: 'Gypsum',            materials: () => (byField.gypsum ? byField.gypsum.closing : null), has: () => !!byField.gypsum, ledgers: ['gypsum'] },
  ];

  const useLedger = date > STOCK_ANCHOR.date;
  const ledgerDay = useLedger ? await stockLedger.closingsFor(date) : null;
  const ledgerMissingReason = require('./odooDb').isConfigured()
    ? 'The verified stock ledger has not been computed for this date yet (it runs with the Odoo sync every 30 minutes).'
    : 'The verified stock ledger is rolled from Odoo\'s database, which this server is not connected to yet — no stock figure is shown rather than the unverified Raw Material chain.';

  const storesStock = STOCK_LINES.map(line => {
    const th = thresholds[line.key];
    if (!useLedger) {
      const closing = line.materials();
      return {
        key: line.key, label: line.label,
        closing: round2(closing), min: th.min, max: th.max,
        status: line.has() ? stockStatus(closing, th.min, th.max) : null,
        available: line.has(),
      };
    }
    const parts = line.ledgers.map(k => (ledgerDay ? ledgerDay[k] : null));
    const missing = parts.findIndex(p => !p || p.closing === null);
    if (missing >= 0) {
      const p = parts[missing];
      const why = !p ? ledgerMissingReason
        : (line.ledgers.length > 1 ? `${p.label}: ${p.reason}` : p.reason);
      return {
        key: line.key, label: line.label,
        closing: null, min: th.min, max: th.max, status: null,
        available: false, reason: why || 'No verified closing for this date.',
      };
    }
    const closing = parts.reduce((s, p) => s + p.closing, 0);
    return {
      key: line.key, label: line.label,
      closing: round2(closing), min: th.min, max: th.max,
      status: stockStatus(closing, th.min, th.max),
      available: true,
    };
  });

  /* The section's own available/note (below) test `stockRows.length`; from
     1 Jul that must mean "a verified line is available", not "a Raw
     Material row exists" — otherwise July and August (no materials rows at
     all) would read "No data" over verified figures. */
  const stockRows = useLedger ? storesStock.filter(r => r.available) : matStockRows;

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
    /* A row whose movement types appear nowhere in the ticket log has no
       figure — it is not a measured zero. Both "… to Golani Waste dump"
       movements (MV.S_WD / MV.N_WD) match none of the 8 movement types the
       46,985 tickets actually carry, so "South Mine to Dump  0.00 MT" was
       printing in the MIS pack as reconciled fact on every run. miningAvailable
       is true whenever ANY ticket exists anywhere, so it could never catch
       this; the distinction has to be per row. Same discipline as sumFields()
       and unavailable() elsewhere in this file. */
    let seen = false;
    for (const mv of row.movements) {
      const t = mvTotals[mv];
      if (!t) continue;
      seen = true;
      onDate += num(t.on_date);
      mtd    += num(t.mtd);
      ytd    += num(t.ytd);
    }
    const has = miningAvailable && seen;
    return {
      key: row.key, label: row.label, unit: 'MT',
      onDate: has ? round2(onDate) : null,
      mtd:    has ? round2(mtd)    : null,
      ytd:    has ? round2(ytd)    : null,
      available: has,
      ...(miningAvailable && !seen
        ? { reason: 'no weighbridge ticket has ever carried this movement type' }
        : {}),
    };
  });

  const unavailable = (rows, reason) => rows.map(r => ({
    key: r.key, label: r.label, available: false, reason,
    onDate: null, mtd: null, ytd: null, closing: null, min: null, max: null, status: null,
  }));

  /* ── Mining: overburden (Odoo Waste Material Entry) ──
     A row is available when ANY approved entry falls in the fiscal year;
     its on-date cell is still null on a day with no entry (entries arrive
     days late — "not recorded yet" is not "nothing hauled"). Nothing in the
     mirror at all reads as unavailable with the reason, not as zero. */
  const obAvailable = !!ob && ob.daysWithEntries > 0;
  const obReason = ob && ob.status.entriesStored
    ? 'No approved Waste Material Entry in Odoo for this fiscal year.'
    : 'Overburden is read from Odoo\'s Waste Material Entry, which has not been synced to this server yet.';
  const obRow = (key, label, unit, v) => (obAvailable
    ? { key, label, unit, onDate: v.onDate, mtd: v.mtd, ytd: v.ytd, available: true }
    : unavailable([{ key, label }], obReason)[0]);
  const overburdenRows = [
    obRow('overburden_mt', 'Overburden removed (waste handling)', 'MT', ob && ob.mt),
    /* No unit: the page appends it to the label, and "— trips trips" reads
       as a typo. The label already says what is counted. */
    obRow('overburden_trips', 'Overburden removed — truck trips', null, ob && ob.trips),
  ];

  /* ── Mining: crusher (Production Report facts) ──
     Read from the fiscal-year production rows already loaded above, so no
     second query. A row is available when any day in the year carries its
     fact; until apron-feeder hours reach the Production Report, the hours
     and TPH rows say so instead of printing a figure. */
  const cr = crusher.crusherPeriod(crusher.crusherDays(prodRows.rows), date, moFrom);
  const crRow = (key, label, unit, v, reason) => (v.ytd !== null
    ? { key, label, unit, onDate: v.onDate, mtd: v.mtd, ytd: v.ytd, available: true }
    : unavailable([{ key, label }], reason)[0]);
  const noApron = 'Apron-feeder hours are not on any Production Report this fiscal year yet.';
  const crusherRows = [
    crRow('crusher_prod', 'Crusher production', 'MT', cr.prod,
      'No crusher production on any Production Report this fiscal year.'),
    crRow('crusher_apron_hrs', 'Crusher apron feeder hours', 'h', cr.apron, noApron),
    crRow('crusher_tph', 'Crusher TPH (production ÷ apron feeder hours)', 'TPH', cr.tph, noApron),
  ];

  const miningNotes = [];
  if (!miningAvailable) miningNotes.push('No weighbridge tickets loaded for this fiscal year — import them on the Quarry page.');
  if (obAvailable) {
    miningNotes.push(overburden.LOAD_FACTOR_NOTE + ' Approved entries only.');
    if (ob && ob.pending.entries) {
      miningNotes.push(`${ob.pending.entries} overburden entr${ob.pending.entries === 1 ? 'y' : 'ies'} `
        + `(${ob.pending.mt.toLocaleString('en-GB')} t) still awaiting approval in Odoo — not counted.`);
    }
  }
  if (cr.tph.ytd !== null) miningNotes.push('Crusher TPH = Σ production ÷ Σ apron-feeder hours over the days that report both.');

  const sections = [
    {
      key: 'mining', label: 'Mining Report', columns: ['onDate', 'mtd', 'ytd'],
      available: miningAvailable || obAvailable || crusherRows.some(r => r.available),
      note: miningNotes.length ? miningNotes.join(' ') : null,
      rows: miningRows.concat(overburdenRows, crusherRows, unavailable(
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
  ];

  return {
    kind: 'daily-summary',
    date, monthFrom: moFrom, fiscalFrom: fyFrom,
    daysWithProduction: prodRows.rows.length,
    sections: sections.filter(sec => canSeeSection(sec.key, role)),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { gatherDaily, gatherMonthly, gatherCompleteness, gatherDailySummary, FORM_LABELS, prettifyField };
