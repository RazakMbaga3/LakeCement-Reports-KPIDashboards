/*
  services/crusher.js — limestone crusher production, apron-feeder hours and
  TPH, read from the Production Report (daily_reports, form_type
  'production', REPORTED_STATUSES) for the Daily MIS summary and the Quarry
  page.

  Facts: `ls_crusher_prod_mt` (crusher output) and `ls_crusher_apron_hrs`
  (apron-feeder running hours — the contract fact config/odooProductionMap.js
  fills from Odoo's Crusher Production Entry, migration 040).

  ── TPH, and why it is never averaged ───────────────────────────────────
  TPH = production ÷ apron-feeder hours (Razak, 2026-10-15: the apron feeder
  is what puts limestone into the crusher; the Mines department's own KPI
  report tracks this basis to ~1 TPH). For a period it is Σproduction ÷
  Σapron-hours over the days that carry BOTH — a mean of daily TPHs would
  weight a two-hour day like a twenty-hour one, and a day with output but no
  hours would push tonnes into the numerator with nothing in the divisor.

  ── Missing is not zero ─────────────────────────────────────────────────
  A day without the fact contributes nothing and a period with none of it is
  null. Apron hours exist on Odoo entries from 2023-08-19 on, but only reach
  a report once the production feed has been re-pulled since migration 040;
  until then the hours — and so TPH — read as not available, never as 0.
*/

const db = require('../db');
const { REPORTED_STATUSES } = require('../config/forms');

const PROD = 'ls_crusher_prod_mt';
const APRON = 'ls_crusher_apron_hrs';

function val(data, key) {
  if (!data) return null;
  const v = data[key];
  if (v === undefined || v === null || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
function r2(v) { return v === null || v === undefined ? null : Math.round(v * 100) / 100; }

/* Pure. Production rows ({ record_date, data }) -> one row per day. A day
   with neither fact is dropped. TPH only when hours > 0 — hours of 0 beside
   real tonnage are not a reading (no such entry exists in Odoo). */
function crusherDays(rows) {
  /* One entry per date even if a date has more than one report row (a
     shift split): tonnes and hours both sum, and null stays null. */
  const byDate = new Map();
  for (const r of rows) {
    const date = String(r.record_date).slice(0, 10);
    const prod = val(r.data, PROD);
    const apron = val(r.data, APRON);
    if (prod === null && apron === null) continue;
    const d = byDate.get(date) || { date, prodMt: null, apronHrs: null };
    if (prod !== null) d.prodMt = (d.prodMt || 0) + prod;
    if (apron !== null) d.apronHrs = (d.apronHrs || 0) + apron;
    byDate.set(date, d);
  }
  return [...byDate.values()]
    .map(d => ({
      date: d.date, prodMt: r2(d.prodMt), apronHrs: r2(d.apronHrs),
      tph: d.prodMt !== null && d.apronHrs !== null && d.apronHrs > 0 ? r2(d.prodMt / d.apronHrs) : null,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/* Pure. Days (already limited to [fyFrom, date]) -> on-date / MTD / YTD for
   production, apron hours and TPH. */
function crusherPeriod(days, date, moFrom) {
  const acc = () => ({ prod: null, apron: null, pairProd: 0, pairApron: 0, pairs: 0 });
  const mtd = acc(), ytd = acc();
  let today = null;
  for (const d of days) {
    for (const a of (d.date >= moFrom ? [mtd, ytd] : [ytd])) {
      if (d.prodMt !== null) a.prod = (a.prod || 0) + d.prodMt;
      if (d.apronHrs !== null) a.apron = (a.apron || 0) + d.apronHrs;
      if (d.prodMt !== null && d.apronHrs !== null && d.apronHrs > 0) {
        a.pairProd += d.prodMt; a.pairApron += d.apronHrs; a.pairs++;
      }
    }
    if (d.date === date) today = d;
  }
  const tph = a => (a.pairs && a.pairApron > 0 ? r2(a.pairProd / a.pairApron) : null);
  return {
    prod:  { onDate: today ? r2(today.prodMt) : null,   mtd: r2(mtd.prod),  ytd: r2(ytd.prod) },
    apron: { onDate: today ? r2(today.apronHrs) : null, mtd: r2(mtd.apron), ytd: r2(ytd.apron) },
    tph:   { onDate: today ? today.tph : null,          mtd: tph(mtd),      ytd: tph(ytd) },
    tphDays: { mtd: mtd.pairs, ytd: ytd.pairs },
  };
}

/* For the Quarry page: per-day crusher rows for [from, to]. Reads only the
   two facts, not the whole Production Report blob. */
async function crusherRange(from, to) {
  const { rows } = await db.query(
    `SELECT record_date::text AS record_date,
            jsonb_build_object($4::text, data->$4, $5::text, data->$5) AS data
       FROM daily_reports
      WHERE form_type = 'production' AND record_date BETWEEN $1 AND $2
        AND status = ANY($3) AND (data ? $4 OR data ? $5)
      ORDER BY record_date`,
    [from, to, REPORTED_STATUSES, PROD, APRON]);
  return crusherDays(rows);
}

module.exports = { PROD, APRON, crusherDays, crusherPeriod, crusherRange };
