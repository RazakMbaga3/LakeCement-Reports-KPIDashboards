/*
  services/misReport.js — gathers everything a daily or monthly MIS report
  needs into one plain payload object. Rendering lives elsewhere
  (misRender.js → printable HTML, misExcel.js → XLSX); this module is the
  single source for WHAT goes in a report.
*/

const db       = require('../db');
const engine   = require('./formulaEngine');
const insights = require('./insights');

/* Display names + section order for the report */
const FORM_LABELS = {
  'production':   'Production Summary',
  'quality':      'Quality Control',
  'pile-quality': 'Pile Quality (CaO)',
  'limestone':    'Limestone Crushing',
  'mines':        'Mines / Quarry',
  'materials':    'Raw Materials',
  'power-cons':   'Power Consumption',
  'power-plant':  'Power Plant (CPP)',
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
    `SELECT r.form_type, r.shift, r.data, r.submitted_at, r.updated_at, u.full_name AS submitted_by_name
     FROM daily_reports r LEFT JOIN users u ON r.submitted_by = u.id
     WHERE r.record_date = $1
     ORDER BY r.form_type, r.shift`,
    [date]
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
        status: (r.data && r.data._status) || 'submitted',
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
     WHERE record_date BETWEEN $1 AND $2`,
    [from, to]
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
     WHERE record_date BETWEEN $1 AND $2
     ORDER BY form_type, record_date, shift`,
    [from, to]
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

module.exports = { gatherDaily, gatherMonthly, gatherCompleteness, FORM_LABELS, prettifyField };
