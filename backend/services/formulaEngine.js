/*
  services/formulaEngine.js — evaluates the shared formula registry
  (forms/formula-registry.js — the SAME file the browser loads) against
  daily_reports, and applies active manual overrides.

  Evaluation model:
    1. Fetch the month's daily_reports rows for every form any fact needs.
    2. Build one entry per (date, shift): a dict of fact values resolved
       from their declared source (all 'manual' → form field today; a
       fact flipped to 'odoo' later resolves from the Odoo staging pull
       instead — formulas never know the difference).
    3. daily(facts) per entry; monthlyAgg rolls entries up (avg | sum |
       production-weighted mean).
    4. An ACTIVE row in kpi_overrides replaces the displayed value; the
       computed value is always preserved and returned alongside.
*/

const db = require('../db');
const logger = require('./logger');
const { REPORTED_STATUSES } = require('../config/forms');
const { FACTS, FORMULAS } = require('../../forms/formula-registry.js');

function num(v) {
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

function round(v, dp) {
  return v === null || v === undefined ? null : parseFloat(Number(v).toFixed(dp ?? 2));
}

/* One entry per DATE with all declared facts resolved.

   The unit of evaluation is the calendar day, not the (date, shift) pair.
   That matters because every formula is written against a day's facts —
   `kiln_prod_mt` means "clinker produced that day", and a KPI with
   monthlyAgg:'sum' means "sum over days".

   Keying entries by (date, shift) instead produced two numbers for the same
   KPI and the same month as soon as a single night-shift row existed:
   evalMonth summed both shifts while evalDaily silently kept one of them,
   so a 'sum' KPI read exactly 2x higher on a KPI card than on the trend
   chart beside it — and gatherMonthly() in services/misReport.js calls BOTH,
   so one MIS pack disagreed with itself. Verified against a scratch month:
   total-power-kwh came out 365,033 monthly against 182,517 in its own
   series. Latent rather than historical — every row written to date is
   shift='day' — but the forms accept 'night' and 'all', so it was one
   night-shift entry away from silently doubling a headline figure.

   Facts from different forms merge into the same day (that is how a formula
   spanning production + power works at all), and so do facts from different
   shifts of the same form. Where two shifts of ONE form both carry the same
   fact, the later shift wins by field, which is the same last-write-wins
   rule a single 'all'-shift row would have given. Summing them here instead
   would double-count every ratio's denominator; forms that genuinely need
   per-shift totals aggregate within the day's own row today. */
async function buildEntries(from, to) {
  const forms = [...new Set(Object.values(FACTS).map(f => f.form))];
  /* Drafts and rejected reports are not data — see REPORTED_STATUSES. */
  const result = await db.query(
    `SELECT form_type, record_date, shift, data
     FROM daily_reports
     WHERE form_type = ANY($1) AND record_date BETWEEN $2 AND $3
       AND status = ANY($4)
     ORDER BY record_date,
              CASE shift WHEN 'day' THEN 1 WHEN 'night' THEN 2 ELSE 3 END`,
    [forms, from, to, REPORTED_STATUSES]
  );

  const entries = new Map(); // "date" → { date, facts }
  for (const row of result.rows) {
    const date = String(row.record_date).slice(0, 10);
    if (!entries.has(date)) entries.set(date, { date: row.record_date, facts: {} });
    const entry = entries.get(date);
    for (const [factKey, fact] of Object.entries(FACTS)) {
      if (fact.form !== row.form_type) continue;
      const v = num(row.data ? row.data[fact.field] : null);
      /* Don't let a later shift's blank field erase an earlier shift's
         reading — only a real value overwrites. */
      if (v === null && entry.facts[factKey] !== undefined) continue;
      entry.facts[factKey] = v;
    }
  }
  return [...entries.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

function dailyValue(formula, facts, key) {
  let v;
  try {
    v = formula.daily(facts);
  } catch (err) {
    // A thrown formula renders identically to "no data submitted" if this
    // is swallowed silently — that hid two real bugs in this file's
    // history (see forms/formula-registry.js's own notes on the
    // kiln_coal_cons / pwr_cm1_kwh incidents) until a manual audit found
    // them. Logging here means a broken formula shows up in the logs the
    // moment it breaks instead of indefinitely.
    logger.warn({ formula: key, err: err.message }, 'formula.daily() threw — rendering as null');
    v = null;
  }
  return (v === null || v === undefined || Number.isNaN(v)) ? null : v;
}

function aggregate(formula, rows) {
  // rows: [{ value, facts }] with value possibly null
  const valid = rows.filter(r => r.value !== null);
  if (!valid.length) return null;

  const agg = formula.monthlyAgg || 'avg';
  if (agg === 'sum') return valid.reduce((s, r) => s + r.value, 0);
  if (agg === 'avg') return valid.reduce((s, r) => s + r.value, 0) / valid.length;
  if (agg.type === 'weighted') {
    let wSum = 0, vSum = 0;
    for (const r of valid) {
      const w = agg.weight(r.facts) || 0;
      if (w > 0) { wSum += w; vSum += r.value * w; }
    }
    return wSum > 0 ? vSum / wSum : null;
  }
  return null;
}

/* Registry metadata safe to serialize (no functions).

   `notes` — the registry's plain-English statement of method and caveats —
   is included only when asked for. It belongs in an answer to "what IS
   this KPI", which is what /api/formula/registry is; it does not belong on
   every row of /api/formula/eval, which dashboards hit on every page load
   and where the notes would add ~20KB of identical prose per request to a
   payload that is otherwise a list of numbers. Until now it reached
   neither: it was generated into docs/KPI_REFERENCE.md and was invisible
   to the UI, so a KPI the registry itself flags as provisional was shown
   against a target with no way for a reader to find out why. */
function formulaMeta(key, opts = {}) {
  const f = FORMULAS[key];
  const meta = {
    key, label: f.label, unit: f.unit, dp: f.dp, version: f.version,
    target: f.target, signage: f.signage, targetLabel: f.targetLabel,
    inputs: f.inputs,
    provisional: !!f.provisional,
    provisionalNote: f.provisionalNote || null,
  };
  if (opts.withNotes) meta.notes = f.notes || null;
  return meta;
}

function registryMeta() {
  return {
    facts: Object.fromEntries(Object.entries(FACTS).map(([k, f]) =>
      [k, { source: f.source, form: f.form, field: f.field, unit: f.unit }])),
    formulas: Object.keys(FORMULAS).map(k => formulaMeta(k, { withNotes: true })),
  };
}

async function activeOverrides(year, month) {
  const r = await db.query(
    `SELECT id, kpi_key, value_override, value_computed, reason, created_by_name, created_at
     FROM kpi_overrides
     WHERE year = $1 AND month = $2 AND cleared_at IS NULL`,
    [year, month]
  );
  return new Map(r.rows.map(row => [row.kpi_key, row]));
}

/* Monthly evaluation of every formula, with overrides applied */
async function evalMonth(year, month) {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to   = `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;

  const [entries, overrides] = await Promise.all([buildEntries(from, to), activeOverrides(year, month)]);

  return Object.keys(FORMULAS).map(key => {
    const formula = FORMULAS[key];
    const rows = entries.map(e => ({ value: dailyValue(formula, e.facts, key), facts: e.facts }));
    const computed = round(aggregate(formula, rows), formula.dp);

    const ov = overrides.get(key);
    return {
      ...formulaMeta(key),
      computed,
      value: ov ? round(num(ov.value_override), formula.dp) : computed,
      overridden: !!ov,
      override: ov ? {
        id: ov.id,
        value: num(ov.value_override),
        computedAtOverride: num(ov.value_computed),
        reason: ov.reason,
        by: ov.created_by_name,
        at: ov.created_at,
      } : null,
    };
  });
}

/* Daily series for every formula over a date range (for trend charts).
   Overrides are monthly-scoped, so they don't apply here. */
async function evalDaily(from, to) {
  const entries = await buildEntries(from, to);
  const out = {};
  for (const key of Object.keys(FORMULAS)) {
    const formula = FORMULAS[key];
    /* buildEntries already yields exactly one entry per date, so the series
       and evalMonth() are two views of the same rows by construction — the
       trend chart can no longer disagree with the KPI card above it. */
    out[key] = {
      ...formulaMeta(key),
      series: entries.map(e => ({
        date: e.date,
        value: round(dailyValue(formula, e.facts, key), formula.dp),
      })),
    };
  }
  return out;
}

module.exports = { evalMonth, evalDaily, registryMeta, FORMULAS };
