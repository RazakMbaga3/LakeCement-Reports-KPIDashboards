/*
  services/sales.js — Sales dashboard aggregation.

  Mirrors the standalone sales app's dashboard.py math (MTD/EOM run-rate
  forecast, MoM delta) but ported onto this app's conventions: Postgres
  for manual daily projections (daily_reports, form_type='sales-projection'),
  services/salesOdoo.js for everything Odoo-sourced. Every Odoo-sourced
  field degrades to an honest {ok:false, status, message} instead of a
  fabricated number when Odoo isn't configured/reachable/mapped yet.
*/
const db = require('../db');
const salesOdoo = require('./salesOdoo');
const { SALES_GRADES } = require('../config/salesGrades');

/* Every calendar day counts as a selling day (Lake Cement sells 7 days a
   week) — ported directly from the standalone app's working_days(). */
function _daysInclusive(start, end) {
  const ms = end.getTime() - start.getTime();
  return Math.max(Math.round(ms / 86400000) + 1, 0);
}

async function getTerritories() {
  const result = await db.query(
    `SELECT officer_code, sales_officer, zone, division, divisional_manager,
            odoo_zone_tag, odoo_division_tag, odoo_user_id, sort_order
     FROM sales_territories
     WHERE active
     ORDER BY division, sort_order, zone`
  );
  return result.rows;
}

/* Sum sp_<officerCode>_proj_total across a date range from the manual
   daily-entry rows — flat prefixed JSONB keys, same convention as every
   other daily form (dispatch_reg_425r-style), summed in JS rather than a
   pure-SQL pivot since the field keys are dynamic per officer roster. */
async function _sumProjections(from, to, territories) {
  const result = await db.query(
    `SELECT record_date, data FROM daily_reports
     WHERE form_type = 'sales-projection' AND record_date BETWEEN $1 AND $2`,
    [from, to]
  );

  let total = 0;
  const byOfficer = {};
  const byDate = {};
  const reportedOfficers = new Set();

  for (const row of result.rows) {
    const data = row.data || {};
    const dateKey = String(row.record_date).slice(0, 10);
    let dayTotal = 0;
    for (const t of territories) {
      const key = `sp_${t.officer_code}_proj_total`;
      const raw = data[key];
      /* form-persist.js syncs every data-field input on Save Draft, blank
         or not, so an untouched field arrives here as ''. Number('') is 0
         and Number.isFinite(0) is true, so without this check a blank
         field was indistinguishable from an explicit "0" entry — every
         officer looked "reported" the moment ANY officer saved a draft. */
      if (raw === '' || raw == null) continue;
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      dayTotal += v;
      total += v;
      byOfficer[t.officer_code] = (byOfficer[t.officer_code] || 0) + v;
      reportedOfficers.add(t.officer_code);
    }
    byDate[dateKey] = (byDate[dateKey] || 0) + dayTotal;
  }

  return { total, byOfficer, byDate, reportedOfficers };
}

async function getDashboard(year, month) {
  /* Truncated to UTC midnight — used as mtdEnd for the current month below,
     and _daysInclusive()/day-count math needs both endpoints to be exact
     midnights or the result silently shifts by a day depending on what
     time of day the request happens to land (found in pre-deployment
     review: a raw `new Date()` here made daily_run_rate/projected_eom_mt
     swing ~14% between an 08:00 and a 15:00 UTC load of the same day). */
  const _now = new Date();
  const today = new Date(Date.UTC(_now.getUTCFullYear(), _now.getUTCMonth(), _now.getUTCDate()));
  year  = year  || today.getUTCFullYear();
  month = month || (today.getUTCMonth() + 1);

  const firstOfMonth   = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth    = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastOfMonth    = new Date(Date.UTC(year, month - 1, daysInMonth));
  const isCurrentMonth = year === today.getUTCFullYear() && month === today.getUTCMonth() + 1;
  const mtdEnd         = isCurrentMonth ? today : lastOfMonth;

  const fmt = d => d.toISOString().slice(0, 10);
  const daysElapsed   = _daysInclusive(firstOfMonth, mtdEnd);
  const daysRemaining = mtdEnd < lastOfMonth
    ? _daysInclusive(new Date(mtdEnd.getTime() + 86400000), lastOfMonth)
    : 0;

  const territories = await getTerritories();

  const [projRange, projToday, mtdSales, collections, uncollectable, payable, advance, agewise, targetsRes, officerAchievement] =
    await Promise.all([
      _sumProjections(fmt(firstOfMonth), fmt(mtdEnd), territories),
      _sumProjections(fmt(today), fmt(today), territories),
      salesOdoo.fetchMtdSales(fmt(firstOfMonth), fmt(mtdEnd)),
      salesOdoo.fetchCollections(fmt(firstOfMonth), fmt(mtdEnd), daysElapsed),
      salesOdoo.fetchReceivedUncollectable(),
      salesOdoo.fetchPayable(),
      salesOdoo.fetchAdvance(fmt(firstOfMonth), fmt(mtdEnd)),
      salesOdoo.fetchAgewiseOutstanding(fmt(firstOfMonth), fmt(mtdEnd)),
      _getTargets(firstOfMonth),
      salesOdoo.fetchOfficerAchievement(fmt(firstOfMonth), fmt(mtdEnd)),
    ]);

  const mtdActual = mtdSales.ok ? mtdSales.value.qty_mt : null;
  const todayActual = mtdSales.ok ? _todayActualFromOrders(mtdSales.value, fmt(today)) : null;
  const monthlyTarget = targetsRes.companyTotal;

  const dailyRunRate   = mtdActual != null && daysElapsed ? Math.round((mtdActual / daysElapsed) * 10) / 10 : null;
  const projectedEomMt = dailyRunRate != null ? Math.round(dailyRunRate * daysInMonth * 10) / 10 : null;
  const requiredDaily  = (mtdActual != null && daysRemaining && monthlyTarget)
    ? Math.round(((monthlyTarget - mtdActual) / daysRemaining) * 10) / 10
    : null;

  /* MoM: previous month's Odoo actual, same live-pull-on-request pattern. */
  const pm  = month === 1 ? 12 : month - 1;
  const pmy = month === 1 ? year - 1 : year;
  const prevFirst = new Date(Date.UTC(pmy, pm - 1, 1));
  const prevLast  = new Date(Date.UTC(pmy, pm, 0));
  const prevMtdSales = await salesOdoo.fetchMtdSales(fmt(prevFirst), fmt(prevLast));
  const prevActual = prevMtdSales.ok ? prevMtdSales.value.qty_mt : null;
  const momDeltaMt  = (mtdActual != null && prevActual != null) ? Math.round((mtdActual - prevActual) * 10) / 10 : null;
  const momDeltaPct = (momDeltaMt != null && prevActual) ? Math.round((momDeltaMt / prevActual) * 1000) / 10 : null;

  const grades = _buildGradeMix(mtdSales);
  const gradeTrend = _buildGradeMixByDay(mtdSales);

  // See this function's doc comment: null on purpose, not stale data.
  const performance = _buildPerformance(territories, projRange, targetsRes.byOfficer, {});

  const dailyTrend = [];
  for (let d = new Date(firstOfMonth); d <= mtdEnd; d = new Date(d.getTime() + 86400000)) {
    const key = fmt(d);
    /* A day with no orders is a real 0 when Odoo answered; null only when
       Odoo itself could not be reached, so the chart never draws a fake zero. */
    const actual = mtdSales.ok ? Math.round((mtdSales.value.mt_by_date[key] || 0) * 10) / 10 : null;
    dailyTrend.push({ date: key, projected: Math.round((projRange.byDate[key] || 0) * 10) / 10, actual });
  }

  /* Best/worst day this month — derived from the same mt_by_date that feeds
     dailyTrend, so it can never disagree with the chart. Only days that have
     actually elapsed are eligible (mt_by_date only contains days Odoo has
     orders for, but an elapsed day with zero orders is a real zero that
     should still be eligible as a "worst day" candidate, not silently
     skipped — so this walks the same elapsed-day range as dailyTrend rather
     than just Object.keys(mt_by_date)). Null (not a fabricated day) when
     Odoo is unreachable or no day has elapsed yet. */
  let bestDay = null, worstDay = null;
  if (mtdSales.ok) {
    for (const t of dailyTrend) {
      if (t.actual == null) continue;
      if (!bestDay || t.actual > bestDay.mt) bestDay = { date: t.date, mt: t.actual };
      if (!worstDay || t.actual < worstDay.mt) worstDay = { date: t.date, mt: t.actual };
    }
  }

  /* Avg order size — trivial division, degrades to null the same way every
     other mtdSales-derived figure does when Odoo didn't answer, and to null
     (not 0) specifically when order_count is 0 so a monthless order average
     is never reported as a real zero-size order. */
  const avgOrderSizeMt = (mtdSales.ok && mtdSales.value.order_count)
    ? Math.round((mtdSales.value.qty_mt / mtdSales.value.order_count) * 10) / 10
    : null;

  const activeCustomers = mtdSales.ok ? mtdSales.value.active_customers : null;
  const topCustomers = _buildTopCustomers(mtdSales);

  return {
    period: {
      year, month,
      label: firstOfMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      prev_label: prevFirst.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    },
    today: {
      date: fmt(today),
      projected_mt: Math.round(projToday.total * 10) / 10,
      actual_mt: todayActual,
      officers_reported: projToday.reportedOfficers.size,
      officers_total: territories.length,
      missing_reporters: territories.filter(t => !projToday.reportedOfficers.has(t.officer_code)).map(t => t.sales_officer),
    },
    mtd: {
      actual_mt: mtdActual,
      projected_mt: Math.round(projRange.total * 10) / 10,
      target_mt: monthlyTarget,
      vs_target_pct: (mtdActual != null && monthlyTarget) ? Math.round((mtdActual / monthlyTarget) * 1000) / 10 : null,
      days_elapsed: daysElapsed, days_remaining: daysRemaining, days_in_month: daysInMonth,
      daily_run_rate: dailyRunRate, projected_eom_mt: projectedEomMt, required_daily_mt: requiredDaily,
      prev_month_actual_mt: prevActual, mom_delta_mt: momDeltaMt, mom_delta_pct: momDeltaPct,
      avg_order_size_mt: avgOrderSizeMt, active_customers: activeCustomers,
      best_day: bestDay, worst_day: worstDay,
    },
    grades,
    grade_trend: gradeTrend,
    daily_trend: dailyTrend,
    top_customers: topCustomers,
    performance,
    /* Real officer actual-vs-target, sourced entirely from Odoo — see
       salesOdoo.fetchOfficerAchievement() for the customer-target join
       that makes this correct without needing sale_orders.salesperson
       fixed. This is the authoritative achievement view; `performance`
       above is the separate local-projection habit tracker. */
    officer_achievement: officerAchievement.ok
      ? { ok: true, ...officerAchievement.value, as_of: officerAchievement.as_of, source: officerAchievement.source }
      : { ok: false, status: officerAchievement.status, message: officerAchievement.message },
    targets: {
      ok: targetsRes.companyTotal != null,
      source: targetsRes.source,
      as_of: fmt(firstOfMonth),
    },
    collections: _publicOdooResult(collections, ['invoice_count', 'total_collected_tzs', 'outstanding_tzs', 'collection_rate_pct', 'dso_lite_days', 'dso_basis_note']),
    financials: {
      received_uncollectable: _publicOdooResult(uncollectable),
      payable: _publicOdooResult(payable),
      advance: _publicOdooResult(advance),
      agewise_outstanding: _publicOdooResult(agewise),
    },
    sources: {
      /* Propagate the real status (not_configured vs unreachable), not a
         hardcoded literal — sales.html's ternary on this value only
         makes sense if it can actually see both cases. */
      sales_volume: mtdSales.ok ? 'odoo:sale.order' : mtdSales.status,
      collections: collections.ok ? 'odoo:account.move' : collections.status,
    },
  };
}

/* Only expose what the frontend needs from an salesOdoo.js result — never
   leak raw Odoo rows (mtdSales.value.orders/lines) into the API response. */
function _publicOdooResult(result, valueKeys) {
  if (!result.ok) return { ok: false, status: result.status, message: result.message };
  const value = valueKeys ? Object.fromEntries(valueKeys.map(k => [k, result.value[k]])) : result.value;
  return { ok: true, ...value, as_of: result.as_of, source: result.source };
}

/* Tonnes for one order line, unwrapping the [id, name] UoM pair this
   service's line shapes carry and delegating the actual bag->tonne rule to
   salesOdoo._lineMt(). Every MT figure in this file goes through here, so
   grade shares, top-customer totals and the on-date split can never drift
   from the qty_mt that salesOdoo computes with the same rule. */
function _mtOfLine(line) {
  const uom = line.product_uom;
  const uomName = (Array.isArray(uom) ? uom[1] : uom) || '';
  return salesOdoo._lineMt(uomName, line.product_uom_qty || 0);
}

/* Today's actual is a subset of the already-fetched MTD orders/lines — no
   second Odoo round trip, matching the standalone app's same optimization
   (dashboard.py: today_orders = [o for o in live_orders if date matches]). */
function _todayActualFromOrders(mtdValue, todayStr) {
  const todayOrderIds = new Set(
    mtdValue.orders.filter(o => String(o.date_order || '').slice(0, 10) === todayStr).map(o => o.id)
  );
  if (!todayOrderIds.size) return 0;
  const todayLines = mtdValue.lines.filter(l => {
    const orderId = Array.isArray(l.order_id) ? l.order_id[0] : l.order_id;
    return todayOrderIds.has(orderId);
  });
  let total = 0;
  for (const line of todayLines) {
    total += _mtOfLine(line);
  }
  return Math.round(total * 10) / 10;
}

/* Product-name -> grade matching, checked against the real Odoo catalogue
   2026-08-24 (Products list: 5 Finished Goods — FG001 CEMENT 42.5 R,
   FG002 CEMENT 32.5, FG003 CEMENT 42.5 N, FG004 CEMENT OPC 42.5 N,
   FG005 CEMENT B-M 42.5 N). Confirmed by opening FG001/FG002: their
   Sales Description ("CEM II A – L 42.5 R" / "CEM II B – L 32.5 N")
   matches SUPER 42 / MAX 32 exactly.

   The generic "contains 42.5" rule this used to fall back to was a real
   bug against this catalogue: FG003 and FG005 both contain "42.5" too,
   so their volumes were silently folding into the SUPER 42 bucket
   alongside FG001, overcounting it. Pinning SUPER 42 to the one
   confirmed code (FG001) instead — FG003 correctly falls through to the
   "Unmatched product" bucket until its own identity is confirmed.
   FG005's identity WAS confirmed 2026-09-09: it's the Duramax 42 marketing
   name, which (as already suspected here) appears nowhere in FG005's
   actual Odoo name "CEMENT B-M 42.5 N" — a plain "DURAMAX" substring
   check could never have found it, so FG005 is pinned by product code
   below, the same way FG001 is. "OPC"/"PREMIUM" checks are kept as
   literal, unambiguous substrings of the real names where they apply
   (only FG004 contains "OPC" — no false-positive risk like the 42.5 case). */
function _matchGrade(productName) {
  const n = (productName || '').toUpperCase();
  if (n.includes('[FG005]')) return 'duramax42'; // CEMENT B-M 42.5 N — confirmed 2026-09-09
  if (n.includes('OPC') || n.includes('PREMIUM')) return 'premiumopc';
  if (n.includes('32.5')) return 'max32';
  if (n.includes('[FG001]')) return 'super42';
  return null;
}

function _buildGradeMix(mtdSales) {
  const base = SALES_GRADES.map(g => ({ ...g, mtd_actual_mt: null, share_pct: null }));
  if (!mtdSales.ok) return base;

  const byGrade = Object.fromEntries(SALES_GRADES.map(g => [g.key, 0]));
  let unmatched = 0;
  for (const line of mtdSales.value.lines) {
    const mt = _mtOfLine(line);
    const productName = Array.isArray(line.product_id) ? line.product_id[1] : '';
    const key = _matchGrade(productName);
    if (key) byGrade[key] += mt;
    else unmatched += mt;
  }
  const total = mtdSales.value.qty_mt || 0;
  const graded = base.map(g => ({
    ...g,
    mtd_actual_mt: Math.round(byGrade[g.key] * 10) / 10,
    share_pct: total ? Math.round((byGrade[g.key] / total) * 1000) / 10 : 0,
  }));
  if (unmatched > 0.5) {
    graded.push({ key: 'unmatched', label: 'Unmatched product', grade: '', color: '#9CA3AF',
      mtd_actual_mt: Math.round(unmatched * 10) / 10,
      share_pct: total ? Math.round((unmatched / total) * 1000) / 10 : 0 });
  }
  return graded;
}

/* Per-day-per-grade breakdown for the Grade Mix Trend chart — same join
   (line -> order_id -> order.date_order) fetchMtdSales() already does for
   mt_by_date, and the same _matchGrade() + MT conversion _buildGradeMix()
   uses, just bucketed by day instead of collapsed to one MTD total. Lines
   that don't resolve to a known grade are folded into "Unmatched product"
   per day, same honest-signal convention as the MTD snapshot — never
   silently dropped. Returns [] (not null) when Odoo didn't answer, so the
   chart can render its own "no data" state without a separate ok flag;
   sales.js keeps that flag on the sibling `grades` field already. */
function _buildGradeMixByDay(mtdSales) {
  if (!mtdSales.ok) return [];

  const dateOfOrder = new Map(
    mtdSales.value.orders.map(o => [o.id, String(o.date_order || '').slice(0, 10)]));

  const byDate = new Map(); // date -> { gradeKey -> mt }
  for (const line of mtdSales.value.lines) {
    const orderId = Array.isArray(line.order_id) ? line.order_id[0] : line.order_id;
    const date = dateOfOrder.get(orderId);
    if (!date) continue;

    const mt = _mtOfLine(line);
    const productName = Array.isArray(line.product_id) ? line.product_id[1] : '';
    const key = _matchGrade(productName) || 'unmatched';

    if (!byDate.has(date)) byDate.set(date, {});
    const dayBucket = byDate.get(date);
    dayBucket[key] = (dayBucket[key] || 0) + mt;
  }

  return Array.from(byDate.keys()).sort().map(date => {
    const dayBucket = byDate.get(date);
    const row = { date };
    for (const g of SALES_GRADES) row[g.key] = Math.round((dayBucket[g.key] || 0) * 10) / 10;
    if (dayBucket.unmatched) row.unmatched = Math.round(dayBucket.unmatched * 10) / 10;
    return row;
  });
}

/* Top customers by MT this month — group lines by their order's customer
   (same order_id -> orders join as _todayActualFromOrders), sum MT per
   customer with the same conversion _buildGradeMix() uses, sort desc, cap
   at 10. Real Odoo customer names — sales.html must escape them the same
   way it already escapes territory fields. Returns [] when Odoo didn't
   answer; the frontend's own `grades`/mtdSales ok-flag already carries the
   pending/unreachable state for this section. */
function _buildTopCustomers(mtdSales) {
  if (!mtdSales.ok) return [];

  const customerOfOrder = new Map(
    mtdSales.value.orders.map(o => [o.id, Array.isArray(o.partner_id) ? o.partner_id : [null, null]]));

  const byCustomer = new Map(); // partner_id -> { name, mt }
  for (const line of mtdSales.value.lines) {
    const orderId = Array.isArray(line.order_id) ? line.order_id[0] : line.order_id;
    const [partnerId, partnerName] = customerOfOrder.get(orderId) || [null, null];
    if (partnerId == null) continue;

    const mt = _mtOfLine(line);

    if (!byCustomer.has(partnerId)) byCustomer.set(partnerId, { name: partnerName || 'Unknown customer', mt: 0 });
    byCustomer.get(partnerId).mt += mt;
  }

  return Array.from(byCustomer.values())
    .map(c => ({ name: c.name, mt: Math.round(c.mt * 10) / 10 }))
    .sort((a, b) => b.mt - a.mt)
    .slice(0, 10);
}

/* Division -> Zone/Officer rollup for the LOCAL manual-projection system
   (sales_territories + daily "sales-projection" reports + the interim
   local sales_targets table) — a separate, still-useful thing from the
   real Odoo achievement view below. actual_mt here stays null: this
   table's officer roster is placeholder data (sales_territories was
   never backfilled with the real names/codes), and matching it against
   Odoo's own officer names would be a fragile guess, not the confirmed
   join salesOdoo.fetchOfficerAchievement() does via customer_id. Use
   `officer_achievement` (Odoo-sourced, real officer names, real targets)
   for actual-vs-target; this table is for the daily projection habit. */
function _buildPerformance(territories, projRange, targetByOfficer, actualByOfficer) {
  const byDivision = new Map();
  for (const t of territories) {
    if (!byDivision.has(t.division)) {
      byDivision.set(t.division, { division: t.division, divisional_manager: t.divisional_manager, zones: [] });
    }
    const projected = Math.round((projRange.byOfficer[t.officer_code] || 0) * 10) / 10;
    const target = targetByOfficer[t.officer_code] || null;
    const actual = actualByOfficer[t.officer_code] != null ? actualByOfficer[t.officer_code] : null;
    const achievementBasis = actual != null ? actual : projected;
    byDivision.get(t.division).zones.push({
      zone: t.zone, sales_officer: t.sales_officer, officer_code: t.officer_code,
      actual_mt: actual, projected_mt: projected, target_mt: target,
      achievement_pct: (target && achievementBasis) ? Math.round((achievementBasis / target) * 1000) / 10 : null,
      days_reported: projRange.reportedOfficers.has(t.officer_code) ? 1 : 0,
    });
  }
  const divisions = Array.from(byDivision.values()).map(d => {
    const projected_mt = Math.round(d.zones.reduce((s, z) => s + z.projected_mt, 0) * 10) / 10;
    const target_mt = d.zones.reduce((s, z) => s + (z.target_mt || 0), 0) || null;
    const hasActual = d.zones.some(z => z.actual_mt != null);
    const actual_mt = hasActual ? Math.round(d.zones.reduce((s, z) => s + (z.actual_mt || 0), 0) * 10) / 10 : null;
    const achievementBasis = actual_mt != null ? actual_mt : projected_mt;
    return {
      ...d, actual_mt, projected_mt, target_mt,
      achievement_pct: (target_mt && achievementBasis) ? Math.round((achievementBasis / target_mt) * 1000) / 10 : null,
    };
  }).sort((a, b) => b.projected_mt - a.projected_mt);
  return { divisions };
}

/* Targets: local sales_targets table, source column distinguishes manual
   interim entries from (later) real Odoo-sourced ones. Prefers per-officer
   rows; falls back to the company-wide sentinel row only when no
   per-officer rows exist for the month, so the two are never summed. */
async function _getTargets(firstOfMonth) {
  const monthStr = firstOfMonth.toISOString().slice(0, 10);
  const result = await db.query(
    `SELECT officer_code, target_mt, source FROM sales_targets
     WHERE target_month = $1 AND grade_key = '_all'`,
    [monthStr]
  );
  const rows = result.rows;
  const officerRows = rows.filter(r => r.officer_code !== '_company');
  const companyRow = rows.find(r => r.officer_code === '_company');

  const byOfficer = {};
  officerRows.forEach(r => { byOfficer[r.officer_code] = Number(r.target_mt); });

  const companyTotal = officerRows.length
    ? officerRows.reduce((s, r) => s + Number(r.target_mt), 0)
    : (companyRow ? Number(companyRow.target_mt) : null);

  const source = officerRows.length ? (officerRows[0].source || 'manual')
    : (companyRow ? companyRow.source : 'manual');

  return { companyTotal, byOfficer, source };
}

module.exports = {
  getDashboard, getTerritories,
  // Exported for test/sales-aggregation.test.js (pure functions, no DB/Odoo) —
  // same pattern as services/odooProductionMapper.js's mapDay/flattenReport.
  _buildGradeMix, _buildGradeMixByDay, _buildTopCustomers, _matchGrade,
};
