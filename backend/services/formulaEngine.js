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
const { FACTS, FORMULAS } = require('../../forms/formula-registry.js');

function num(v) {
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

function round(v, dp) {
  return v === null || v === undefined ? null : parseFloat(Number(v).toFixed(dp ?? 2));
}

/* One entry per (date, shift) with all declared facts resolved */
async function buildEntries(from, to) {
  const forms = [...new Set(Object.values(FACTS).map(f => f.form))];
  const result = await db.query(
    `SELECT form_type, record_date, shift, data
     FROM daily_reports
     WHERE form_type = ANY($1) AND record_date BETWEEN $2 AND $3`,
    [forms, from, to]
  );

  const entries = new Map(); // "date|shift" → { date, shift, facts }
  for (const row of result.rows) {
    const key = `${row.record_date}|${row.shift}`;
    if (!entries.has(key)) entries.set(key, { date: row.record_date, shift: row.shift, facts: {} });
    const entry = entries.get(key);
    for (const [factKey, fact] of Object.entries(FACTS)) {
      if (fact.form !== row.form_type) continue;
      entry.facts[factKey] = num(row.data ? row.data[fact.field] : null);
    }
  }
  return [...entries.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

function dailyValue(formula, facts) {
  let v;
  try { v = formula.daily(facts); } catch { v = null; }
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

/* Registry metadata safe to serialize (no functions) */
function formulaMeta(key) {
  const f = FORMULAS[key];
  return {
    key, label: f.label, unit: f.unit, dp: f.dp, version: f.version,
    target: f.target, signage: f.signage, targetLabel: f.targetLabel,
    inputs: f.inputs,
  };
}

function registryMeta() {
  return {
    facts: Object.fromEntries(Object.entries(FACTS).map(([k, f]) =>
      [k, { source: f.source, form: f.form, field: f.field, unit: f.unit }])),
    formulas: Object.keys(FORMULAS).map(formulaMeta),
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
    const rows = entries.map(e => ({ value: dailyValue(formula, e.facts), facts: e.facts }));
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
    // one value per date — prefer the 'day' shift entry when both exist
    const byDate = new Map();
    for (const e of entries) {
      if (byDate.has(e.date) && e.shift !== 'day') continue;
      byDate.set(e.date, round(dailyValue(formula, e.facts), formula.dp));
    }
    out[key] = {
      ...formulaMeta(key),
      series: [...byDate.entries()].map(([date, value]) => ({ date, value })),
    };
  }
  return out;
}

module.exports = { evalMonth, evalDaily, registryMeta, FORMULAS };
