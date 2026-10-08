/*
  services/sales.js — Sales dashboard aggregation.

  Mirrors the standalone sales app's dashboard.py math (MTD/EOM run-rate
  forecast, MoM delta) on this app's conventions: Postgres for the manual
  daily projections (daily_reports, form_type='sales-projection') and, since
  2026-10-08, for every Odoo-sourced sales figure too — read from the Sale
  Register mirror (services/salesRegister.js over migrations 034/035, filled
  on the live schedule by odooSalesSync.js). Nothing here calls Odoo.

  Basis is INVOICE DATE, cement only — the Sales team's Register. Where a
  period has not been synced at all (droplet history before its backfill),
  tonnage falls back to Odoo dispatch notes (salesDelivered.js) and the
  payload says so in `tonnage_basis`; customer, money and territory figures
  have no dispatch equivalent and report `not_synced` instead of a number.
*/
const db = require('../db');
const salesRegister = require('./salesRegister');
const salesDelivered = require('./salesDelivered');
const odooDashboardClient = require('./odooDashboardClient');
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

  const pm  = month === 1 ? 12 : month - 1;
  const pmy = month === 1 ? year - 1 : year;
  const prevFirst = new Date(Date.UTC(pmy, pm - 1, 1));
  const prevLast  = new Date(Date.UTC(pmy, pm, 0));
  const prevDays  = prevLast.getUTCDate();

  const territories = await getTerritories();
  const [projRange, projToday, reg, prevReg, delivered, prevDelivered, targetsRes] = await Promise.all([
    _sumProjections(fmt(firstOfMonth), fmt(mtdEnd), territories),
    _sumProjections(fmt(today), fmt(today), territories),
    salesRegister.getRegisterPeriod(fmt(firstOfMonth), fmt(mtdEnd), { today: fmt(today) }),
    salesRegister.getRegisterPeriod(fmt(prevFirst), fmt(prevLast), { today: fmt(today) }),
    salesDelivered.getDeliveredTonnage(fmt(firstOfMonth), fmt(mtdEnd)),
    salesDelivered.getDeliveredTonnage(fmt(prevFirst), fmt(prevLast)),
    _getTargets(firstOfMonth),
  ]);

  /* ── Basis ────────────────────────────────────────────────────────────
     'invoiced'  — the Sale Register mirror has at least one synced day in
                   the period. Reconciled for September 2026 invoice by
                   invoice against the Sales team's Register.
     'delivered' — nothing synced for the period at all (droplet history
                   before its backfill) but the dispatch sync has days:
                   tonnage only, labelled; within ~0.05% of the Register in
                   September.
     null        — neither: every figure is null, never a fabricated 0.
     A partly synced period stays 'invoiced' and reports its coverage —
     mixing the two bases day by day would make the total neither. */
  const synced = new Set(reg.coverage.synced_days);
  const basis = synced.size ? 'invoiced' : (delivered.days_with_data ? 'delivered' : null);
  const invoiced = basis === 'invoiced';
  /* Mirrored rows are real data whether or not this server can reach Odoo
     right now, so they are shown either way; "not configured" only explains
     an EMPTY mirror. */
  const salesStatus = invoiced ? 'odoo:sale_register'
    : !odooDashboardClient.isConfigured() ? 'not_configured' : 'not_synced';
  const notSynced = {
    ok: false,
    status: salesStatus === 'not_configured' ? 'not_configured' : 'not_synced',
    message: salesStatus === 'not_configured'
      ? 'The Odoo sales feed is not configured on this server yet.'
      : 'The Odoo Sale Register has not been synced for this period yet.',
  };

  const mtdActual = invoiced ? reg.mt
    : basis === 'delivered' ? delivered.total_mt : null;

  /* A synced day with no invoices is a real 0; an unsynced day is null —
     the sync not having pulled a day is not evidence nothing was sold. */
  const dayActual = key => {
    if (invoiced) return synced.has(key) ? (reg.by_date[key] || 0) : null;
    if (basis === 'delivered') { const r = delivered.by_date[key]; return r ? r.mt : null; }
    return null;
  };
  const todayActual = dayActual(fmt(today));
  const monthlyTarget = targetsRes.companyTotal;

  /* Daily run rate — the Sales team's DRR: MTD over days elapsed. */
  const dailyRunRate   = mtdActual != null && daysElapsed ? Math.round((mtdActual / daysElapsed) * 10) / 10 : null;
  /* A closed month's "projection" is its actual — rebuilding it from the
     rounded run rate read 59,580 for September's 59,578.8. */
  const projectedEomMt = !isCurrentMonth ? mtdActual
    : dailyRunRate != null ? Math.round(dailyRunRate * daysInMonth * 10) / 10 : null;
  const requiredDaily  = (mtdActual != null && daysRemaining && monthlyTarget)
    ? Math.round(((monthlyTarget - mtdActual) / daysRemaining) * 10) / 10
    : null;

  /* MoM only against a previous month on the SAME basis and fully present:
     a half-synced previous month would make the delta measure the sync,
     not sales. */
  let prevActual = null, prevNote = null;
  if (invoiced) {
    if (prevReg.coverage.days_synced >= prevDays) prevActual = prevReg.mt;
    else prevNote = `previous month only ${prevReg.coverage.days_synced} of ${prevDays} days synced`;
  } else if (basis === 'delivered' && prevDelivered.days_with_data) {
    prevActual = prevDelivered.total_mt;
  }
  const momDeltaMt  = (mtdActual != null && prevActual != null) ? Math.round((mtdActual - prevActual) * 10) / 10 : null;
  const momDeltaPct = (momDeltaMt != null && prevActual) ? Math.round((momDeltaMt / prevActual) * 1000) / 10 : null;

  const grades = invoiced ? _buildRegisterGradeMix(reg)
    : basis === 'delivered' ? _buildDeliveredGradeMix(delivered)
    : SALES_GRADES.map(g => ({ ...g, mtd_actual_mt: null, share_pct: null }));
  const gradeTrend = invoiced ? _buildRegisterGradeTrend(reg)
    : basis === 'delivered' ? _buildDeliveredGradeTrend(delivered) : [];

  // See this function's doc comment: null on purpose, not stale data.
  const performance = _buildPerformance(territories, projRange, targetsRes.byOfficer, {});

  const dailyTrend = [];
  for (let d = new Date(firstOfMonth); d <= mtdEnd; d = new Date(d.getTime() + 86400000)) {
    const key = fmt(d);
    dailyTrend.push({ date: key, projected: Math.round((projRange.byDate[key] || 0) * 10) / 10, actual: dayActual(key) });
  }

  /* Best/worst day over the same series the chart draws, so they can never
     disagree; a synced zero-sales day is a legitimate "worst day". */
  let bestDay = null, worstDay = null;
  for (const t of dailyTrend) {
    if (t.actual == null) continue;
    if (!bestDay || t.actual > bestDay.mt) bestDay = { date: t.date, mt: t.actual };
    if (!worstDay || t.actual < worstDay.mt) worstDay = { date: t.date, mt: t.actual };
  }

  const drr = mt => (daysElapsed ? Math.round((mt / daysElapsed) * 10) / 10 : null);
  const expectedDays = isCurrentMonth ? daysElapsed : daysInMonth;

  return {
    period: {
      year, month, is_current_month: isCurrentMonth,
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
      prev_month_actual_mt: prevActual, prev_month_note: prevNote,
      mom_delta_mt: momDeltaMt, mom_delta_pct: momDeltaPct,
      invoice_count: invoiced ? reg.invoices : null,
      avg_invoice_size_mt: (invoiced && reg.invoices) ? Math.round((reg.mt / reg.invoices) * 10) / 10 : null,
      active_customers: invoiced ? reg.customers : null,
      net_sales_tzs: invoiced ? reg.net_tzs : null,
      price_per_mt_tzs: invoiced ? reg.price_per_mt_tzs : null,
      best_day: bestDay, worst_day: worstDay,
    },
    grades,
    grade_trend: gradeTrend,
    daily_trend: dailyTrend,
    top_customers: invoiced ? reg.top_customers : [],
    /* The Sales team's TOTAL DIV WISE view, without targets — Odoo's feed
       no longer carries per-customer targets. */
    territory: invoiced
      ? {
          ok: true,
          by_division: reg.by_division.map(d => ({ ...d, drr: drr(d.mt) })),
          by_zone: reg.by_zone.map(z => ({ ...z, drr: drr(z.mt) })),
        }
      : notSynced,
    performance,
    tonnage_basis: {
      basis,
      label: invoiced ? 'Invoiced (Sale Register)' : basis === 'delivered' ? 'Delivered (dispatch notes)' : null,
      note: invoiced
        ? 'Tonnage and value are by INVOICE date, cement only — the same basis as the Sales team\'s Sale Register. '
          + 'Credit notes are not in Odoo\'s feed yet, so a month with a return reads slightly above the Register.'
        : basis === 'delivered'
          ? 'The Sale Register has not been synced for this period, so tonnage is from Odoo dispatch notes '
            + '(within ~0.05% of the Register in September 2026). Customer, value and territory figures need the Register.'
          : null,
      coverage: {
        days_synced: synced.size, days_expected: expectedDays,
        complete: synced.size >= expectedDays, last_synced: reg.coverage.last_synced,
      },
      register_mt: invoiced ? reg.mt : null,
      /* Dispatch tonnage for the same period, kept as an independent
         cross-check: two Odoo feeds agreeing is evidence; one is a claim. */
      delivered_mt: delivered.days_with_data ? delivered.total_mt : null,
      by_channel: delivered.by_channel,
      unclassified_mt: invoiced ? reg.by_grade.other : delivered.other_mt,
      customer_figures_basis: invoiced ? 'invoiced' : null,
    },
    officer_achievement: {
      ok: false,
      status: 'pending_officer_list',
      message: 'Officer achievement is being rebuilt on Odoo\'s new sales feed, which no longer includes '
        + 'per-customer targets. It returns once the officer list and targets are confirmed with Sales.',
    },
    targets: {
      ok: targetsRes.companyTotal != null,
      source: targetsRes.source,
      as_of: fmt(firstOfMonth),
    },
    collections: invoiced
      ? {
          ok: true,
          ...reg.collections,
          /* outstanding / (invoiced per elapsed day). Not a true DSO: the
             feed has no due date, only invoice_date. */
          dso_lite_days: (reg.collections.invoiced_tzs && daysElapsed)
            ? Math.round((reg.collections.outstanding_tzs / (reg.collections.invoiced_tzs / daysElapsed)) * 10) / 10
            : null,
          dso_basis_note: 'Approximate — outstanding on this period\'s invoices divided by the average daily '
            + 'invoiced amount. Odoo sends no due date, so this is not a true Days Sales Outstanding.',
          basis_note: 'Collected ON this period\'s invoices (paid = invoiced − still outstanding). Not cash received '
            + 'in the period: receipts paying other months\' invoices are not in Odoo\'s sales feed.',
          as_of: reg.coverage.last_synced,
          source: 'odoo:sale_register',
        }
      : notSynced,
    financials: {
      received_uncollectable: { ok: false, status: 'not_mapped',
        message: 'Sales Receivable against Invoice is not included in the Odoo sales feed.' },
      payable: { ok: false, status: 'not_mapped',
        message: 'Sales Payable (Advances) is not available from the Odoo sales feed.' },
      agewise_outstanding: invoiced
        ? {
            ok: true,
            ...reg.ageing,
            total_tzs: reg.ageing.d0_30 + reg.ageing.d31_60 + reg.ageing.d61_90 + reg.ageing.d91_120 + reg.ageing.older,
            ageing_basis: 'invoice_date',
            basis_note: 'Aged by invoice date — Odoo sends no due date, so these are not days-overdue buckets.',
            as_of: reg.coverage.last_synced,
            source: 'odoo:sale_register',
          }
        : notSynced,
    },
    sources: {
      sales_volume: salesStatus,
      collections: invoiced ? 'odoo:sale_register' : notSynced.status,
    },
  };
}

/* Grade mix on the INVOICED basis (Sale Register mirror). Shares are of
   the cement total, so the four tiles plus any "other cement" sum to the
   headline. Grades are keyed on Odoo product code (config/salesGrades.js
   PRODUCT_CODE_GRADE), resolved once at sync time. Cement with no Sales
   product line (FG003, plain 42.5 N) gets its own bucket, never folded
   into a neighbouring grade. */
function _buildRegisterGradeMix(reg) {
  const total = reg.mt || 0;
  const share = v => (total ? Math.round((v / total) * 1000) / 10 : 0);
  const graded = SALES_GRADES.map(g => ({
    ...g, mtd_actual_mt: reg.by_grade[g.key] ?? 0, share_pct: share(reg.by_grade[g.key] || 0),
  }));
  if (reg.by_grade.other > 0.5) {
    graded.push({ key: 'unmatched', label: 'Other cement', grade: '', color: '#9CA3AF',
      mtd_actual_mt: reg.by_grade.other, share_pct: share(reg.by_grade.other) });
  }
  return graded;
}

/* {date, <gradeKey>: mt} rows for the Grade Mix Trend chart. */
function _buildRegisterGradeTrend(reg) {
  return Object.keys(reg.by_date_grade).sort().map(date => {
    const row = reg.by_date_grade[date];
    const out = { date };
    for (const g of SALES_GRADES) out[g.key] = row[g.key] || 0;
    if (row.other) out.unmatched = row.other;
    return out;
  });
}

/* Grade mix on the DELIVERED basis — the fallback for a period the Sale
   Register has not been synced for. Shares SALES_GRADES (label, colour,
   grade tag) with _buildRegisterGradeMix() so the tiles look identical;
   only the source changes. Shares are of the cement total, so
   they always sum to 100% across the four lines.

   There is no "Unmatched product" bucket here: odooDispatchSync.js resolves every row to a known field or
   skips it as non-cement at write time, so nothing unmatched can reach
   daily_reports. `other_mt` (the plain 42.5 N field, which has no Sales
   product line) is reported separately on the payload instead. */
function _buildDeliveredGradeMix(delivered) {
  const base = SALES_GRADES.map(g => ({ ...g, mtd_actual_mt: null, share_pct: null }));
  if (!delivered.days_with_data) return base;

  const total = delivered.total_mt || 0;
  return base.map(g => ({
    ...g,
    mtd_actual_mt: delivered.by_grade[g.key] ?? 0,
    share_pct: total ? Math.round((delivered.by_grade[g.key] / total) * 1000) / 10 : 0,
  }));
}

/* Per-day-per-grade rows for the Grade Mix Trend chart, delivered basis.
   Same shape as _buildRegisterGradeTrend() ({date, <gradeKey>: mt}) so
   sales.html renders either. */
function _buildDeliveredGradeTrend(delivered) {
  if (!delivered.days_with_data) return [];
  return Object.keys(delivered.by_date).sort().map(date => {
    const row = delivered.by_date[date];
    const out = { date };
    for (const g of SALES_GRADES) out[g.key] = row[g.key] ?? 0;
    return out;
  });
}

/* Division -> Zone/Officer rollup for the LOCAL manual-projection system
   (sales_territories + daily "sales-projection" reports + the interim
   local sales_targets table) — a separate, still-useful thing from the
   Odoo-sourced `officer_achievement`. actual_mt here stays null: this
   table's officer roster is placeholder data (sales_territories was
   never backfilled with the real names/codes), and matching it against
   Odoo's own officer names would be a fragile guess. This table is for
   the daily projection habit, not actual-vs-target. */
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
  // Exported for test/sales-aggregation.test.js (pure functions).
  _buildRegisterGradeMix, _buildRegisterGradeTrend,
};
