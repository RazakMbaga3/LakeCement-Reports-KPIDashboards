/*
  services/stores.js — Stores / Inventory section of the Purchase dashboard.

  Source split, and why it matters:

    • Plant materials (raw material, coal, packing bags, grinding aid,
      diesel) come from the MIS's own `materials` daily report — real,
      already-entered Lake Cement data, no Odoo dependency. Everything in
      this file that returns ok:true is that.

    • Engineering & Spare stock, stock ageing, and gate-pass/requisition
      activity (RGP/NRGP/MRQ) live only in Odoo and are NOT wired yet —
      they return the same {ok:false, status:'not_mapped'|'not_configured'}
      shape used by salesOdoo.js/purchasesOdoo.js so the page renders each
      tile's real state instead of one integration blanking the section.

  Closing-stock arithmetic is a deliberate mirror of the entry form's
  recompute() (forms/materials-form.html) — including the two special
  cases (`tank`, `pair`) — so the dashboard can never disagree with the
  form the numbers were typed into. See config/storeMaterials.js.
*/
const db = require('../db');
const { CATEGORIES, SECTIONS, ROWS } = require('../config/storeMaterials');
const { RATES, RATE_SOURCE, hasRates } = require('../config/materialRates');

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function _num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function _notMapped(message) {
  return { ok: false, status: 'not_mapped', message };
}

/* Closing stock for one row — mirrors recompute() in materials-form.html.
   `tankDraw` is the whole diesel section's on-date consumption, which the
   Plant main tank absorbs; pass 0 for non-diesel sections. */
function _closing(data, row, tankDraw) {
  const g = (f, suffix) => _num(data[f + '_' + suffix]);
  if (row.consOnly) return null;             // stock lives in the kiln pile
  if (row.tank) return g(row.f, 'open') + g(row.f, 'rcvd') - tankDraw;
  if (row.section === 'dsl') return g(row.f, 'open') + g(row.f, 'rcvd');
  let close = g(row.f, 'open') + g(row.f, 'rcvd') - g(row.f, 'cons');
  if (row.pair) close -= g(row.pair, 'cons');
  return close;
}

/* Per-row closing/min/max for one day's `materials` record. */
function _snapshotRows(data) {
  const tankDrawBySection = {};
  for (const sec of SECTIONS) {
    tankDrawBySection[sec.id] = sec.rows.reduce((s, r) => s + _num(data[r.f + '_cons']), 0);
  }
  return ROWS.map(row => {
    const closing = _closing(data, row, tankDrawBySection[row.section]);
    const min = data[row.f + '_min'] === '' || data[row.f + '_min'] == null ? null : _num(data[row.f + '_min']);
    const max = data[row.f + '_max'] === '' || data[row.f + '_max'] == null ? null : _num(data[row.f + '_max']);
    return {
      field: row.f, label: row.label, category: row.category, section: row.section,
      section_label: row.sectionLabel, dept: row.dept || null,
      closing, min, max,
      received: _num(data[row.f + '_rcvd']),
      consumed: _num(data[row.f + '_cons']),
      pending_grn: _num(data[row.f + '_grn']),
    };
  });
}

/* Category rollup of a day's snapshot — closing totals per reporting
   category, each with its own unit (they are NOT all MT, so there is
   deliberately no grand total across categories). */
function _categoryTotals(rows) {
  return Object.keys(CATEGORIES)
    .map(key => {
      const catRows = rows.filter(r => r.category === key);
      const stockRows = catRows.filter(r => r.closing != null);
      return {
        key,
        label: CATEGORIES[key].label,
        unit: CATEGORIES[key].unit,
        order: CATEGORIES[key].order,
        closing: Math.round(stockRows.reduce((s, r) => s + r.closing, 0) * 100) / 100,
        received: Math.round(catRows.reduce((s, r) => s + r.received, 0) * 100) / 100,
        consumed: Math.round(catRows.reduce((s, r) => s + r.consumed, 0) * 100) / 100,
        pending_grn: Math.round(catRows.reduce((s, r) => s + r.pending_grn, 0) * 100) / 100,
        line_count: stockRows.length,
      };
    })
    .sort((a, b) => a.order - b.order);
}

/* Reorder-level status from the min/max the Stores team already maintains
   on the entry form. This is our honest analogue of the reference
   dashboard's "Critical Spare Status" donut: same question (what needs
   attention right now), asked of the materials we actually hold data for
   rather than of Odoo spares we haven't mapped yet. */
function _stockStatus(rows) {
  const tracked = rows.filter(r => r.closing != null && r.min != null && r.min > 0);
  const below = [], within = [], above = [];
  for (const r of tracked) {
    const entry = {
      label: r.label, category: r.category, closing: Math.round(r.closing * 100) / 100,
      min: r.min, max: r.max,
      shortfall: r.closing < r.min ? Math.round((r.min - r.closing) * 100) / 100 : 0,
    };
    if (r.closing < r.min) below.push(entry);
    else if (r.max != null && r.max > 0 && r.closing > r.max) above.push(entry);
    else within.push(entry);
  }
  below.sort((a, b) => b.shortfall - a.shortfall);
  return {
    ok: true,
    tracked_count: tracked.length,
    untracked_count: rows.filter(r => r.closing != null).length - tracked.length,
    below_min: below,
    above_max: above,
    within_count: within.length,
    healthy_pct: tracked.length ? Math.round((within.length / tracked.length) * 1000) / 10 : null,
  };
}

/* Month-by-month received vs consumed for the requested year, per
   category — the reference dashboard's "Receipt vs Issue Trend". Summed
   from the daily rows rather than the form's own _mtd fields so a missing
   day degrades the month slightly instead of resetting the running total. */
function _receiptIssueTrend(records, year) {
  const byCategory = {};
  for (const key of Object.keys(CATEGORIES)) {
    byCategory[key] = MONTH_ABBR.map(label => ({ label, received: 0, issued: 0, days: 0 }));
  }
  /* Parallel TZS accumulation, only for materials that actually have a
     rate. `unrated` tracks the rest so the value view can state what it
     could not value instead of quietly under-reporting the total. */
  const valueByCategory = {};
  for (const key of Object.keys(CATEGORIES)) {
    valueByCategory[key] = MONTH_ABBR.map(label => ({ label, received: 0, issued: 0, days: 0 }));
  }
  const rated = new Set(), unrated = new Set();

  for (const rec of records) {
    const d = new Date(rec.record_date);
    if (d.getUTCFullYear() !== year) continue;
    const mi = d.getUTCMonth();
    const rows = _snapshotRows(rec.data);
    const seen = {};
    for (const r of rows) {
      byCategory[r.category][mi].received += r.received;
      byCategory[r.category][mi].issued += r.consumed;
      seen[r.category] = true;

      const rate = RATES[r.field];
      if (typeof rate === 'number' && Number.isFinite(rate)) {
        rated.add(r.field);
        valueByCategory[r.category][mi].received += r.received * rate;
        valueByCategory[r.category][mi].issued += r.consumed * rate;
      } else if (r.received || r.consumed) {
        unrated.add(r.field);
      }
    }
    for (const key of Object.keys(seen)) {
      byCategory[key][mi].days += 1;
      valueByCategory[key][mi].days += 1;
    }
  }
  for (const key of Object.keys(byCategory)) {
    byCategory[key] = byCategory[key].map(m => ({
      ...m,
      received: Math.round(m.received * 100) / 100,
      issued: Math.round(m.issued * 100) / 100,
    }));
    valueByCategory[key] = valueByCategory[key].map(m => ({
      ...m, received: Math.round(m.received), issued: Math.round(m.issued),
    }));
  }
  return { byCategory, valueByCategory, rated, unrated };
}

/* The TZS view of the trend. Returns not_mapped — not zeroes — while no
   rates are configured, because the MIS materials report carries
   quantities only. See config/materialRates.js for the two ways to
   supply rates. */
function _trendValue(valueByCategory, rated, unrated) {
  if (!hasRates()) {
    /* Business-facing wording — the technical fill instructions live in
       config/materialRates.js, not in a message the plant HOD reads. */
    return _notMapped(
      'Receipts and issues are recorded in quantities only — the daily materials report holds no ' +
      'price or cost. Valuing this trend in TZS needs a purchase rate per material, either from ' +
      'Odoo or as a standard-cost list from Finance.');
  }
  return {
    ok: true,
    unit: 'TZS',
    by_category: valueByCategory,
    rated_count: rated.size,
    unrated_count: unrated.size,
    unrated_fields: Array.from(unrated).sort(),
    rate_source: RATE_SOURCE,
    /* Partial coverage is reported, never hidden — a TZS total that
       silently omits unrated materials would read as complete. */
    partial: unrated.size > 0,
    source: 'mis:materials × config/materialRates',
  };
}

/* Diesel issued per consuming department for the month. The diesel
   section is the only place the MIS already splits stock movement by
   department; the broader department-wise stock question is still open
   with the Stores HOD, so this is scoped to what the data really says. */
function _dieselByDept(records) {
  const dieselRows = ROWS.filter(r => r.section === 'dsl' && !r.tank);
  const byDept = new Map();
  for (const rec of records) {
    for (const row of dieselRows) {
      const qty = _num(rec.data[row.f + '_cons']);
      if (!byDept.has(row.label)) byDept.set(row.label, { label: row.label, dept: row.dept, issued: 0 });
      byDept.get(row.label).issued += qty;
    }
  }
  const rows = Array.from(byDept.values())
    .map(r => ({ ...r, issued: Math.round(r.issued * 100) / 100 }))
    .sort((a, b) => b.issued - a.issued);
  const total = Math.round(rows.reduce((s, r) => s + r.issued, 0) * 100) / 100;
  return { ok: true, unit: 'Ltr', rows, total_issued: total };
}

async function getStoresDashboard(year, month) {
  const _now = new Date();
  year = year || _now.getUTCFullYear();
  month = month || (_now.getUTCMonth() + 1);

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

  /* Whole requested year (for the trend) plus anything earlier in case the
     chosen month has no entries and the latest snapshot predates it. */
  const { rows: records } = await db.query(
    `SELECT record_date, data
       FROM daily_reports
      WHERE form_type = 'materials'
        AND record_date <= $1
      ORDER BY record_date ASC`,
    [monthEnd]);

  if (!records.length) {
    const msg = 'No materials daily reports have been submitted yet.';
    return {
      period: { year, month, label: `${MONTH_ABBR[month - 1]} ${year}` },
      inventory: { ok: false, status: 'no_data', message: msg },
      stock_status: { ok: false, status: 'no_data', message: msg },
      receipt_issue_trend: { ok: false, status: 'no_data', message: msg },
      store_activity: { ok: false, status: 'no_data', message: msg },
      diesel_by_dept: { ok: false, status: 'no_data', message: msg },
      ...(_odooPending()),
    };
  }

  const latest = records[records.length - 1];
  const asOf = latest.record_date instanceof Date
    ? latest.record_date.toISOString().slice(0, 10)
    : String(latest.record_date).slice(0, 10);
  const stale = asOf < monthStart;

  const snapshotRows = _snapshotRows(latest.data);
  const monthRecords = records.filter(r => {
    const d = (r.record_date instanceof Date ? r.record_date.toISOString().slice(0, 10) : String(r.record_date).slice(0, 10));
    return d >= monthStart && d <= monthEnd;
  });

  const categories = _categoryTotals(snapshotRows);
  const trend = _receiptIssueTrend(records, year);
  const activity = _categoryTotals(snapshotRows).reduce((acc, c) => {
    acc.received.push({ label: c.label, unit: c.unit, value: c.received });
    acc.issued.push({ label: c.label, unit: c.unit, value: c.consumed });
    acc.pending_grn.push({ label: c.label, unit: c.unit, value: c.pending_grn });
    return acc;
  }, { received: [], issued: [], pending_grn: [] });

  return {
    period: { year, month, label: `${MONTH_ABBR[month - 1]} ${year}` },
    as_of: asOf,
    stale, // latest entry predates the selected month — page warns rather than implying it's current
    days_reported: monthRecords.length,
    days_in_month: daysInMonth,
    inventory: {
      ok: true,
      categories,
      rows: snapshotRows.filter(r => r.closing != null),
      source: 'mis:materials',
    },
    stock_status: _stockStatus(snapshotRows),
    receipt_issue_trend: {
      ok: true,
      by_category: trend.byCategory,
      units: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.unit])),
      source: 'mis:materials',
      /* Same months valued in TZS — ok:false until rates are configured. */
      value: _trendValue(trend.valueByCategory, trend.rated, trend.unrated),
    },
    store_activity: {
      ok: true, date: asOf, ...activity, source: 'mis:materials',
    },
    diesel_by_dept: _dieselByDept(monthRecords),
    ...(_odooPending()),
  };
}

/* The three reference-dashboard sections that genuinely have no MIS
   source — kept as explicit, separately-messaged tiles rather than
   quietly omitted, so the page shows what is still to come and why. */
function _odooPending() {
  return {
    engineering_spare: _notMapped(
      'Engineering & Spare stock lives in Odoo (stock.quant), not the MIS materials report. ' +
      'Pending the Odoo API credentials.'),
    stock_ageing: _notMapped(
      'Stock ageing needs per-lot receipt dates from Odoo (stock.picking / stock.quant). ' +
      'The MIS materials report holds daily balances only, with no lot ages.'),
    open_rgp: _notMapped(
      'Gate-pass and requisition tracking (RGP / NRGP / MRQ) has not been located in Lake Cement’s ' +
      'Odoo yet — confirmation requested from the Stores HOD.'),
  };
}

module.exports = { getStoresDashboard, _closing, _snapshotRows };
