/*
  services/insights.js — the "moat" analytics (Phase 8):

    fieldBaseline()    — trailing-window mean/σ per numeric field of a form;
                         powers the unusual-value confirmation at entry time
    benchmark()        — every KPI vs previous month, same month last year,
                         best-ever month and 3-month rolling average
    stoppageInsights() — Pareto of downtime causes + per-equipment
                         MTTR/MTBF/availability from the stoppage matrix
    searchMemory()     — full-text search across form entries, override
                         reasons and audit details ("what did we do last
                         time the cooler tripped?")
*/

const db     = require('../db');
const engine = require('./formulaEngine');

function num(v) {
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ── A. Field baseline (anomaly-at-entry) ──────────────────────
   Population mean/σ per numeric data field over the trailing window.
   `before` (exclusive) defaults to today — overridable for tests. */
async function fieldBaseline(formType, { days = 30, before } = {}) {
  const end   = before || localDateStr(new Date());
  const start = localDateStr(new Date(new Date(end + 'T00:00:00').getTime() - days * 86400000));

  const rows = await db.query(
    `SELECT data FROM daily_reports
     WHERE form_type = $1 AND record_date >= $2 AND record_date < $3`,
    [formType, start, end]
  );

  const acc = {};
  for (const r of rows.rows) {
    for (const [k, v] of Object.entries(r.data || {})) {
      if (k.startsWith('_')) continue;
      const n = num(v);
      if (n === null) continue;
      (acc[k] = acc[k] || []).push(n);
    }
  }

  const fields = {};
  for (const [k, vals] of Object.entries(acc)) {
    const n = vals.length;
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const variance = vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n;
    fields[k] = {
      n,
      mean: parseFloat(mean.toFixed(4)),
      sd:   parseFloat(Math.sqrt(variance).toFixed(4)),
    };
  }

  return { formType, days, from: start, before: end, fields };
}

/* ── B. Historical benchmarking ────────────────────────────────
   The longer the system runs, the more valuable this gets. */
function prevPeriod(year, month) {
  return month === 1 ? [year - 1, 12] : [year, month - 1];
}
const periodStr = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

async function benchmark(year, month) {
  // every month that has any data (cheap: one aggregate over indexed cols)
  const monthsRes = await db.query(
    `SELECT DISTINCT EXTRACT(YEAR FROM record_date)::int AS y,
                     EXTRACT(MONTH FROM record_date)::int AS m
     FROM daily_reports ORDER BY y, m`);
  const months = monthsRes.rows;

  const cache = new Map(); // 'y-m' → evalMonth result array
  async function evalCached(y, m) {
    const key = `${y}-${m}`;
    if (!cache.has(key)) cache.set(key, await engine.evalMonth(y, m));
    return cache.get(key);
  }
  async function valueOf(y, m, kpiKey) {
    const r = (await evalCached(y, m)).find(x => x.key === kpiKey);
    return r ? r.value : null;
  }

  const current = await evalCached(year, month);
  const [py, pm] = prevPeriod(year, month);

  const out = [];
  for (const k of current) {
    // best-ever direction: lower-is-better KPIs (signage '<' / '<=') take min
    const lowerBetter = k.signage === '<' || k.signage === '<=';

    let best = null;
    for (const { y, m } of months) {
      const v = await valueOf(y, m, k.key);
      if (v === null) continue;
      if (!best || (lowerBetter ? v < best.value : v > best.value)) {
        best = { period: periodStr(y, m), value: v };
      }
    }

    // 3-month rolling average ending at the requested month
    const rolling = [];
    let [ry, rm] = [year, month];
    for (let i = 0; i < 3; i++) {
      const v = await valueOf(ry, rm, k.key);
      if (v !== null) rolling.push(v);
      [ry, rm] = prevPeriod(ry, rm);
    }

    out.push({
      key: k.key, label: k.label, unit: k.unit, dp: k.dp,
      target: k.target, signage: k.signage,
      current: k.value, overridden: k.overridden,
      prevMonth: { period: periodStr(py, pm), value: await valueOf(py, pm, k.key) },
      lastYear:  { period: periodStr(year - 1, month), value: await valueOf(year - 1, month, k.key) },
      bestEver:  best,
      rolling3:  rolling.length ? parseFloat((rolling.reduce((a, b) => a + b, 0) / rolling.length).toFixed(k.dp ?? 2)) : null,
    });
  }
  return out;
}

/* ── C. Stoppage intelligence ──────────────────────────────────
   The stoppage form is an equipment × cause matrix of hours:
   fields named stop_<equipment>_<cause>. */
const STOP_EQUIPMENT = {
  crusher: 'Crusher', rm: 'Raw Mill', cm_coal: 'Coal Mill', kiln: 'Kiln',
  cm1: 'Cement Mill 1', cm2: 'Cement Mill 2', packing: 'Packing Plant',
};
const STOP_CAUSES = {
  mech: 'Mechanical', ei: 'Electrical & Instr.', prod: 'Process',
  planned: 'Planned Maintenance', power: 'Power', other: 'Other',
};
const STOP_RE = /^stop_(.+)_(mech|ei|prod|planned|power|other)$/;

async function stoppageInsights(from, to) {
  const rows = await db.query(
    `SELECT record_date, data FROM daily_reports
     WHERE form_type = 'stoppage' AND record_date BETWEEN $1 AND $2`,
    [from, to]
  );

  const byCause = {}, byEquip = {};
  let totalHours = 0;

  for (const r of rows.rows) {
    for (const [k, v] of Object.entries(r.data || {})) {
      const m = k.match(STOP_RE);
      const h = num(v);
      if (!m || h === null || h <= 0) continue;
      const [, equip, cause] = m;
      totalHours += h;
      byCause[cause] = byCause[cause] || { hours: 0, events: 0 };
      byCause[cause].hours += h;
      byCause[cause].events++;
      byEquip[equip] = byEquip[equip] || { hours: 0, events: 0 };
      byEquip[equip].hours += h;
      byEquip[equip].events++;
    }
  }

  const spanDays = Math.max(1, Math.round(
    (new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000) + 1);
  const calendarH = spanDays * 24;

  // Pareto: causes by hours, with cumulative share
  let cum = 0;
  const pareto = Object.entries(byCause)
    .map(([cause, s]) => ({ cause, label: STOP_CAUSES[cause] || cause, hours: parseFloat(s.hours.toFixed(2)), events: s.events }))
    .sort((a, b) => b.hours - a.hours)
    .map(c => {
      const pct = totalHours > 0 ? (c.hours / totalHours) * 100 : 0;
      cum += pct;
      return { ...c, pct: parseFloat(pct.toFixed(1)), cumPct: parseFloat(cum.toFixed(1)) };
    });

  const equipment = Object.entries(byEquip)
    .map(([key, s]) => ({
      key, label: STOP_EQUIPMENT[key] || key,
      hours: parseFloat(s.hours.toFixed(2)),
      events: s.events,
      mttrHours: parseFloat((s.hours / s.events).toFixed(2)),                 // mean time to repair
      mtbfHours: parseFloat(((calendarH - s.hours) / s.events).toFixed(1)),   // mean time between failures
      availabilityPct: parseFloat((100 * (1 - s.hours / calendarH)).toFixed(2)),
    }))
    .sort((a, b) => b.hours - a.hours);

  return { from, to, days: spanDays, totalHours: parseFloat(totalHours.toFixed(2)), pareto, equipment };
}

/* ── D. Institutional memory search ────────────────────────────
   ILIKE across form JSONB text, override reasons and audit details. */
async function searchMemory(q, limit = 30) {
  const like = '%' + q.replace(/[%_]/g, '\\$&') + '%';

  const [forms, overrides, audit] = await Promise.all([
    db.query(
      `SELECT form_type, record_date, shift, data
       FROM daily_reports WHERE data::text ILIKE $1
       ORDER BY record_date DESC LIMIT $2`, [like, limit]),
    db.query(
      `SELECT kpi_key, year, month, value_override, value_computed, reason,
              created_by_name, created_at, cleared_at
       FROM kpi_overrides WHERE reason ILIKE $1
       ORDER BY created_at DESC LIMIT $2`, [like, limit]),
    db.query(
      `SELECT action, form_type, details, username, created_at
       FROM audit_log WHERE details ILIKE $1
       ORDER BY created_at DESC LIMIT $2`, [like, limit]),
  ]);

  const needle = q.toLowerCase();
  const formHits = forms.rows.map(r => {
    const snippets = [];
    for (const [k, v] of Object.entries(r.data || {})) {
      if (k.startsWith('_')) continue;
      if (String(v).toLowerCase().includes(needle)) {
        snippets.push(`${k}: ${String(v).slice(0, 160)}`);
        if (snippets.length >= 3) break;
      }
    }
    return { formType: r.form_type, date: r.record_date, shift: r.shift, snippets };
  }).filter(h => h.snippets.length);

  return { q, forms: formHits, overrides: overrides.rows, audit: audit.rows };
}

module.exports = { fieldBaseline, benchmark, stoppageInsights, searchMemory };
