/*
  services/insights.js — the "moat" analytics (Phase 8):

    fieldBaseline()    — trailing-window mean/σ per numeric field of a form;
                         powers the unusual-value confirmation at entry time
    benchmark()        — every KPI vs previous month, same month last year,
                         best-ever month and 3-month rolling average
    stoppageInsights() — fleet-wide Pareto of downtime causes + per-equipment
                         MTTR/MTBF/availability from the stoppage matrix
    equipmentStoppageDetail() — same KPIs scoped to ONE equipment, plus
                         named-fault-level Pareto and an MTBF-by-month
                         trend, sourced from the granular stoppage_facts
                         table (scripts/import-stoppage-facts.js) with a
                         per-day fallback to the coarse matrix above for
                         any period that table doesn't cover yet
    searchMemory()     — full-text search across form entries, override
                         reasons and audit details ("what did we do last
                         time the cooler tripped?")
*/

const db     = require('../db');
const { REPORTED_STATUSES } = require('../config/forms');
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
     WHERE form_type = $1 AND record_date >= $2 AND record_date < $3
       AND status = ANY($4)`,
    [formType, start, end, REPORTED_STATUSES]
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
     FROM daily_reports WHERE status = ANY($1) ORDER BY y, m`, [REPORTED_STATUSES]);
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

/* ── RCFA trigger thresholds (Handbook §8.3.1) ──────────────────
   The stoppage matrix only persists day-granularity totals per
   equipment×cause (no per-incident start/end timestamp, no repair-cost
   field anywhere in the schema), so the Handbook's triggers are adapted
   to what's actually recorded:

     RCFA_RECUR_COUNT (=3)           — the Handbook's own number: the same
       equipment+cause combination logging nonzero hours on 3+ distinct
       days within the selected period is "chronic", not one-off bad luck,
       regardless of how few hours any single occurrence cost. This is
       exactly the failure mode the frequency Pareto below is for.

     RCFA_MAIN_ASSET_AVAIL_PCT (=90) — "a main asset down beyond an agreed
       hour threshold": rather than a fixed hour count (which can't scale
       sensibly across a 1-day vs. a 1-year selection), main-asset severity
       is judged against the Handbook's own NAI target (§4.7.1, ≥90%). A
       main asset (kiln/raw mill/either cement mill) whose period
       availability falls short of the plant's own target is inherently
       RCFA-worthy for that period, and the trigger stays meaningful at any
       range length by construction.

     RCFA_SEVERE_DAY_HOURS (=12)     — a single calendar day where a main
       asset logged ≥12h down (half the day) is a catastrophic single
       incident worth flagging immediately — it shouldn't have to wait for
       3 recurrences, or for a long period's average to slip below 90%,
       before someone sees it.

   The Handbook's fourth trigger ("repair cost above an agreed level") has
   no implementation here: no cost field exists anywhere in the stoppage
   form or schema to evaluate it against.
*/
const RCFA_RECUR_COUNT           = 3;
const RCFA_MAIN_ASSET_AVAIL_PCT  = 90;
const RCFA_SEVERE_DAY_HOURS      = 12;
const RCFA_MAIN_ASSETS = ['kiln', 'rm', 'cm1', 'cm2']; // Handbook: Kiln / Raw Mill / Finish (cement) Mill

async function stoppageInsights(from, to) {
  const rows = await db.query(
    `SELECT record_date, data FROM daily_reports
     WHERE form_type = 'stoppage' AND record_date BETWEEN $1 AND $2
       AND status = ANY($3)`,
    [from, to, REPORTED_STATUSES]
  );

  const byCause = {}, byEquip = {}, byEquipCause = {}, byEquipDate = {};
  let totalHours = 0, totalEvents = 0;

  for (const r of rows.rows) {
    const date = String(r.record_date).slice(0, 10);
    for (const [k, v] of Object.entries(r.data || {})) {
      const m = k.match(STOP_RE);
      const mins = num(v);
      if (!m || mins === null || mins <= 0) continue;
      const [, equip, cause] = m;

      // The stop_<equip>_<cause> fields are logged in MINUTES (see
      // forms/stoppage-form.html's own "Minutes / On Date" labels, and
      // insights.html's "Stoppage Minutes" series over the same fields) —
      // e.g. a full calendar day of planned downtime is stored as 1440.
      // Convert to hours once, here, so every downstream figure (totals,
      // Pareto, MTTR/MTBF/availability) is actually in the hours its field
      // names and the Handbook's own formulas assume.
      const h = mins / 60;

      totalHours += h;
      totalEvents++;

      byCause[cause] = byCause[cause] || { hours: 0, events: 0 };
      byCause[cause].hours += h;
      byCause[cause].events++;

      byEquip[equip] = byEquip[equip] || { hours: 0, events: 0 };
      byEquip[equip].hours += h;
      byEquip[equip].events++;

      // Finest resolution the schema offers: one equipment+cause pair on
      // one calendar date — the unit the RCFA "recurred ≥3×" trigger below
      // counts against.
      const ecKey = equip + '|' + cause;
      byEquipCause[ecKey] = byEquipCause[ecKey] ||
        { equip, cause, hours: 0, events: 0, dates: new Set() };
      byEquipCause[ecKey].hours += h;
      byEquipCause[ecKey].events++;
      byEquipCause[ecKey].dates.add(date);

      // Same equipment, all UNPLANNED causes combined, on one calendar
      // date — feeds the "single severe day" RCFA trigger (a bad day can
      // mix causes). 'planned' is deliberately excluded: RCFA is Root
      // Cause FAILURE Analysis — a scheduled 24h shutdown for planned
      // maintenance is not a failure, and counting it here would flag
      // routine, deliberate downtime as if it were a catastrophic incident.
      if (cause !== 'planned') {
        const edKey = equip + '|' + date;
        byEquipDate[edKey] = (byEquipDate[edKey] || 0) + h;
      }
    }
  }

  const spanDays = Math.max(1, Math.round(
    (new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000) + 1);
  const calendarH = spanDays * 24;

  // Pareto A — causes ranked by hours lost, with cumulative % (Handbook
  // §8.2 severity view: "which causes cost us the most downtime", ties to NAI).
  let cum = 0;
  const pareto = Object.entries(byCause)
    .map(([cause, s]) => ({ cause, label: STOP_CAUSES[cause] || cause, hours: parseFloat(s.hours.toFixed(2)), events: s.events }))
    .sort((a, b) => b.hours - a.hours)
    .map(c => {
      const pct = totalHours > 0 ? (c.hours / totalHours) * 100 : 0;
      cum += pct;
      return { ...c, pct: parseFloat(pct.toFixed(1)), cumPct: parseFloat(cum.toFixed(1)) };
    });

  // Pareto B — the SAME cause buckets, ranked by event frequency instead
  // (Handbook §8.2 chronicity view: "which causes keep recurring", ties to
  // MTBF). Always shown paired with Pareto A — a cause can be low-hours but
  // high-frequency (a nagging fault) and hide behind the hours ranking above.
  let cumF = 0;
  const paretoByFreq = Object.entries(byCause)
    .map(([cause, s]) => ({ cause, label: STOP_CAUSES[cause] || cause, hours: parseFloat(s.hours.toFixed(2)), events: s.events }))
    .sort((a, b) => b.events - a.events || b.hours - a.hours)
    .map(c => {
      const pct = totalEvents > 0 ? (c.events / totalEvents) * 100 : 0;
      cumF += pct;
      return { ...c, pct: parseFloat(pct.toFixed(1)), cumPct: parseFloat(cumF.toFixed(1)) };
    });

  /* Equipment that logged NO downtime at all in the period is absent from
     byEquip — so it used to be left out of the fleet availability average
     entirely. Excluding a machine that ran 100% of the period drags the
     fleet figure DOWN, which is exactly backwards: a perfect month for the
     kiln made plant availability look worse, not better. Seed every known
     section at zero so the average is over the whole fleet. */
  for (const key of Object.keys(STOP_EQUIPMENT)) {
    if (!byEquip[key]) byEquip[key] = { hours: 0, events: 0 };
  }

  const equipment = Object.entries(byEquip)
    .map(([key, s]) => ({
      key, label: STOP_EQUIPMENT[key] || key,
      hours: parseFloat(s.hours.toFixed(2)),
      events: s.events,
      // MTTR/MTBF divide by the event count, so they are undefined — not
      // zero, not infinite — for equipment that never failed. null renders as
      // "—" rather than a fabricated figure; availability is still 100%.
      mttrHours: s.events ? parseFloat((s.hours / s.events).toFixed(2)) : null,
      mtbfHours: s.events ? parseFloat(((calendarH - s.hours) / s.events).toFixed(1)) : null,
      availabilityPct: parseFloat((100 * (1 - s.hours / calendarH)).toFixed(2)),
    }))
    .sort((a, b) => b.hours - a.hours);

  // Plant-wide headline figures (§4.7.1/4.7.2). Every section here shares the
  // same calendarH, so averaging the per-equipment availabilityPct values is
  // equivalent to 100 * (1 - totalHours / (calendarH * n)) — one fleet-wide
  // NAI rather than inventing a second formula. n is now always the full
  // fleet (see the seeding above), so a section with a clean period raises
  // the fleet figure instead of vanishing from it.
  const overallAvailabilityPct = equipment.length
    ? parseFloat((equipment.reduce((s, e) => s + e.availabilityPct, 0) / equipment.length).toFixed(2))
    : null;
  const totalOperatingHours = equipment.reduce((s, e) => s + (calendarH - e.hours), 0);
  const overallMtbfHours = totalEvents > 0
    ? parseFloat((totalOperatingHours / totalEvents).toFixed(1))
    : null;

  // ── RCFA-worthy flags (Handbook §8.3.1) — see constants above for the
  // reasoning behind each threshold.
  const rcfaFlags = [];

  // 1) recurring equipment+cause combo — chronic fault. 'planned' is
  // excluded here too — recurring SCHEDULED maintenance isn't a chronic
  // fault, it's the maintenance plan working as intended.
  Object.values(byEquipCause)
    .filter(ec => ec.cause !== 'planned' && ec.dates.size >= RCFA_RECUR_COUNT)
    .sort((a, b) => b.dates.size - a.dates.size)
    .forEach(ec => {
      const equipLabel = STOP_EQUIPMENT[ec.equip] || ec.equip;
      const causeLabel = STOP_CAUSES[ec.cause] || ec.cause;
      rcfaFlags.push({
        type: 'recurring',
        equip: ec.equip, equipLabel, cause: ec.cause, causeLabel,
        occurrences: ec.dates.size, hours: parseFloat(ec.hours.toFixed(2)),
        message: `${equipLabel} — ${causeLabel} recurred on ${ec.dates.size} separate days ` +
          `(${ec.hours.toFixed(1)}h total) this period — chronic fault, RCFA recommended.`,
      });
    });

  // 2) main asset (kiln/raw mill/either cement mill) below the NAI target
  //    for the whole selected period
  equipment
    .filter(e => RCFA_MAIN_ASSETS.includes(e.key) && e.availabilityPct < RCFA_MAIN_ASSET_AVAIL_PCT)
    .forEach(e => {
      rcfaFlags.push({
        type: 'main-asset-down',
        equip: e.key, equipLabel: e.label,
        hours: e.hours, availabilityPct: e.availabilityPct,
        message: `${e.label} availability ${e.availabilityPct}% this period — below the ` +
          `${RCFA_MAIN_ASSET_AVAIL_PCT}% NAI target (${e.hours.toFixed(1)}h down) — RCFA recommended.`,
      });
    });

  // 3) main asset — single calendar day of severe downtime
  Object.entries(byEquipDate).forEach(([key, hrs]) => {
    const sep = key.lastIndexOf('|');
    const equip = key.slice(0, sep), date = key.slice(sep + 1);
    if (!RCFA_MAIN_ASSETS.includes(equip) || hrs < RCFA_SEVERE_DAY_HOURS) return;
    const equipLabel = STOP_EQUIPMENT[equip] || equip;
    rcfaFlags.push({
      type: 'severe-incident',
      equip, equipLabel, date, hours: parseFloat(hrs.toFixed(2)),
      message: `${equipLabel} down ${hrs.toFixed(1)}h on ${date} — single-day severe incident ` +
        `(≥${RCFA_SEVERE_DAY_HOURS}h) — RCFA recommended.`,
    });
  });

  return {
    from, to, days: spanDays,
    totalHours: parseFloat(totalHours.toFixed(2)), totalEvents,
    overallAvailabilityPct, overallMtbfHours,
    pareto, paretoByFreq, equipment, rcfaFlags,
  };
}

/* ── C2. Single-equipment reliability detail ────────────────────
   Everything the fleet-wide stoppageInsights() above shows, scoped to one
   equipment, PLUS what only the granular `stoppage_facts` table (the
   monthly workbook import, migrations/011 + scripts/import-stoppage-facts.js)
   can give: named-fault-level Pareto and a real MTBF-by-month trend.

   TWO SOURCES, ONE EQUIPMENT, PER-DAY PRECEDENCE — not a whole-range branch:
   for each calendar day in [from, to], if `stoppage_facts` has ANY row for
   this equipment on that day, its hours are authoritative for that day
   (and that day contributes nothing from the coarse source, so nothing is
   ever double-counted). Any day this equipment has NO granular row falls
   back to the coarse stop_<equip>_<cause> MINUTES fields on daily_reports
   (same fields, same /60 conversion, as stoppageInsights() above). This
   means a range straddling June/July (coarse-only) and August (granular)
   quietly gets the best available number for every single day, and NAI/
   MTBF/hours+frequency-per-cause are correct for ANY range — old, new, or
   mixed. Only the fault-NAME-level Pareto is granular-only by nature (the
   coarse source was never asked to record fault names) — see faultPareto
   below, which says so honestly instead of going quietly blank. */
async function equipmentStoppageDetail(equip, from, to) {
  const label = STOP_EQUIPMENT[equip];
  if (!label) throw new Error(`Unknown equipment "${equip}"`);

  const spanDays = Math.max(1, Math.round(
    (new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000) + 1);
  const calendarH = spanDays * 24;

  const factRows = (await db.query(
    `SELECT record_date, cause, fault_description, hours FROM stoppage_facts
     WHERE equipment = $1 AND record_date BETWEEN $2 AND $3`,
    [equip, from, to]
  )).rows;
  const granularDates = new Set(factRows.map(r => String(r.record_date).slice(0, 10)));

  // date|cause -> hours, the unit both sources are reconciled onto.
  const unifiedDC = {};
  for (const r of factRows) {
    const key = String(r.record_date).slice(0, 10) + '|' + r.cause;
    unifiedDC[key] = (unifiedDC[key] || 0) + Number(r.hours);
  }

  // Fault-name aggregation — granular source only, by construction.
  const faultAgg = {};
  for (const r of factRows) {
    const h = Number(r.hours);
    if (h <= 0) continue;
    const f = faultAgg[r.fault_description] = faultAgg[r.fault_description] || { hours: 0, dates: new Set() };
    f.hours += h;
    f.dates.add(String(r.record_date).slice(0, 10));
  }

  // Coarse fallback — only for days this equipment has no granular row.
  const coarseRows = (await db.query(
    `SELECT record_date, data FROM daily_reports
     WHERE form_type = 'stoppage' AND record_date BETWEEN $1 AND $2 AND status = ANY($3)`,
    [from, to, REPORTED_STATUSES]
  )).rows;
  let usedCoarse = false;
  for (const r of coarseRows) {
    const date = String(r.record_date).slice(0, 10);
    if (granularDates.has(date)) continue; // granular already covers this day for this equipment
    for (const [k, v] of Object.entries(r.data || {})) {
      const m = k.match(STOP_RE);
      if (!m || m[1] !== equip) continue;
      const mins = num(v);
      if (mins === null || mins <= 0) continue;
      const key = date + '|' + m[2];
      unifiedDC[key] = (unifiedDC[key] || 0) + mins / 60;
      usedCoarse = true;
    }
  }

  // ── Totals + cause-level Pareto pair (Handbook §8.2), reconciled ──
  let totalHours = 0, totalEvents = 0;
  const causeAgg = {};
  for (const [key, h] of Object.entries(unifiedDC)) {
    if (h <= 0) continue;
    const cause = key.slice(key.indexOf('|') + 1);
    totalHours += h;
    totalEvents++;
    causeAgg[cause] = causeAgg[cause] || { hours: 0, events: 0 };
    causeAgg[cause].hours += h;
    causeAgg[cause].events++;
  }

  function buildCausePareto(byFreq) {
    let cum = 0;
    return Object.entries(causeAgg)
      .map(([cause, s]) => ({ cause, label: STOP_CAUSES[cause] || cause, hours: parseFloat(s.hours.toFixed(2)), events: s.events }))
      .sort((a, b) => byFreq ? (b.events - a.events || b.hours - a.hours) : (b.hours - a.hours))
      .map(c => {
        const base = byFreq ? totalEvents : totalHours;
        const val = byFreq ? c.events : c.hours;
        const pct = base > 0 ? (val / base) * 100 : 0;
        cum += pct;
        return { ...c, pct: parseFloat(pct.toFixed(1)), cumPct: parseFloat(cum.toFixed(1)) };
      });
  }
  const pareto = buildCausePareto(false);
  const paretoByFreq = buildCausePareto(true);

  const mttrHours = totalEvents ? parseFloat((totalHours / totalEvents).toFixed(2)) : null;
  const mtbfHours = totalEvents ? parseFloat(((calendarH - totalHours) / totalEvents).toFixed(1)) : null;
  const availabilityPct = parseFloat((100 * (1 - totalHours / calendarH)).toFixed(2));

  // ── Fault-name Pareto — granular only; honest empty-state otherwise ──
  let faultPareto;
  if (!Object.keys(faultAgg).length) {
    const earliest = (await db.query(`SELECT MIN(record_date) AS d FROM stoppage_facts`)).rows[0].d;
    const earliestIso = earliest ? String(earliest).slice(0, 10) : null;
    faultPareto = {
      available: false,
      earliestAvailable: earliestIso,
      message: earliestIso
        ? `Fault-level detail is available from ${earliestIso} onward (the earliest month imported via scripts/import-stoppage-facts.js) — no import covers ${from}..${to} yet.`
        : `Fault-level detail requires importing a monthly Stoppage report workbook (scripts/import-stoppage-facts.js) — none has been imported yet.`,
    };
  } else {
    const totalFaultHours = Object.values(faultAgg).reduce((s, f) => s + f.hours, 0);
    let cum = 0;
    const rows = Object.entries(faultAgg)
      .map(([fault, f]) => ({ fault, hours: parseFloat(f.hours.toFixed(2)), events: f.dates.size }))
      .sort((a, b) => b.hours - a.hours)
      .map(f => {
        const pct = totalFaultHours > 0 ? (f.hours / totalFaultHours) * 100 : 0;
        cum += pct;
        return { ...f, pct: parseFloat(pct.toFixed(1)), cumPct: parseFloat(cum.toFixed(1)) };
      });
    const covered = [...granularDates].sort();
    faultPareto = { available: true, from: covered[0], to: covered[covered.length - 1], rows };
  }

  // ── MTBF-by-month — granular source, full history, NOT scoped to the
  // page's from/to picker (this chart's whole point is a calendar-time
  // trend that grows on its own as more monthly workbooks get imported —
  // scoping it to a query range would make it look "stuck" at 1 bar for a
  // 1-month range even after 12 months of imports exist). */
  const allFactRows = (await db.query(
    `SELECT record_date, cause, hours FROM stoppage_facts WHERE equipment = $1`,
    [equip]
  )).rows;
  const monthBuckets = {};
  for (const r of allFactRows) {
    const date = String(r.record_date).slice(0, 10);
    const ym = date.slice(0, 7);
    const b = monthBuckets[ym] = monthBuckets[ym] || {};
    const key = date + '|' + r.cause;
    b[key] = (b[key] || 0) + Number(r.hours);
  }
  const mtbfByMonth = Object.keys(monthBuckets).sort().map(ym => {
    const [y, m] = ym.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const calH = daysInMonth * 24;
    let hours = 0, events = 0;
    for (const h of Object.values(monthBuckets[ym])) { if (h > 0) { hours += h; events++; } }
    return {
      period: ym,
      hours: parseFloat(hours.toFixed(2)), events,
      mtbfHours: events ? parseFloat(((calH - hours) / events).toFixed(1)) : null,
      availabilityPct: parseFloat((100 * (1 - hours / calH)).toFixed(2)),
    };
  });

  return {
    equip, label, from, to, days: spanDays, calendarH,
    hours: parseFloat(totalHours.toFixed(2)), events: totalEvents,
    mttrHours, mtbfHours, availabilityPct,
    pareto, paretoByFreq, faultPareto, mtbfByMonth,
    source: factRows.length && usedCoarse ? 'mixed' : (factRows.length ? 'granular' : (usedCoarse ? 'coarse' : 'none')),
  };
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

module.exports = {
  fieldBaseline, benchmark, stoppageInsights, equipmentStoppageDetail, searchMemory,
  STOP_EQUIPMENT,
};
