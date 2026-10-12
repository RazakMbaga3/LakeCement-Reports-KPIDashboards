/*
  services/complianceStatus.js — the one place a compliance obligation's
  status is decided. Pure: no I/O, no clock unless one is passed in.

  WHY STATUS IS COMPUTED, NEVER STORED. The workbook this module replaces
  kept a hand-typed Status column, and on 2026-10-12 66 rows said "Active"
  while their own "To" date had passed. Here the dates are the truth and the
  status is derived from them on every read, so it cannot drift.

  Every item lands in exactly ONE bucket, so a pivot of department × status
  always adds up to the register:
    active    in force / nothing due inside the lead window
    due       the deadline is inside the first reminder window (lead day 1)
    overdue   the deadline has passed (from the day AFTER it), or a condition
              was assessed "not complied"
    undated   no deadline can be computed — a data gap, shown as
              "No date set", never guessed into one of the verdicts above
    inactive  switched off on purpose (no longer applicable) — excluded
    archived  hidden everywhere except the Archived filter

  Secondary FLAGS never change the bucket (one dimension, one channel):
  unverified, renewalInProgress, noExpiry, missingDirect. An expired licence
  whose renewal is pending is still legally expired — it reads
  "Overdue · Renewal in progress", not something softer.

  Dates are 'YYYY-MM-DD' strings throughout (db/index.js already returns
  DATE columns that way) and arithmetic is done on UTC midnights, so there
  is no timezone in any of it except todayIn(), which says which calendar
  day it is in Dar es Salaam (UTC+3, no DST).
*/

const DAY_MS = 86400000;
const TZ = 'Africa/Dar_es_Salaam';

/* ── Date primitives ─────────────────────────────────────────────────── */
function todayIn(tz = TZ, now = Date.now()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(now));
}
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
function parts(s) { return { y: +s.slice(0, 4), m: +s.slice(5, 7), d: +s.slice(8, 10) }; }
function ms(s) { const p = parts(s); return Date.UTC(p.y, p.m - 1, p.d); }
function fromMs(t) { return new Date(t).toISOString().slice(0, 10); }
function ymd(y, m, d) { return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
/* "The 30th" in February is the 28th (29th in a leap year); "the 31st" in
   April is the 30th. A due day never rolls into the next month. */
function clampDay(y, m, d) { return ymd(y, m, Math.min(d, daysInMonth(y, m))); }
function daysBetween(a, b) { return Math.round((ms(b) - ms(a)) / DAY_MS); }   // b − a
function addDays(s, n) { return fromMs(ms(s) + n * DAY_MS); }
function addMonths(s, n, keepDay) {
  const p = parts(s);
  const idx = p.y * 12 + (p.m - 1) + n;
  return clampDay(Math.floor(idx / 12), (idx % 12) + 1, keepDay || p.d);
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDate(s) {
  if (!isDate(s)) return '';
  const p = parts(s);
  return `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

/* ── Lead days ───────────────────────────────────────────────────────────
   Three reminder windows: the responsible person from lead 1, plus the
   supervisor from lead 2, plus the central Head list from lead 3. The
   workbook's own values win; these defaults fill its blanks and new items. */
const DEFAULT_LEADS = {
  validity_short: [45, 30, 20],   // term under 2 years
  validity_long:  [90, 60, 45],   // term of 2 years or more (trademarks, EWURA)
  month:          [7, 5, 2],
  quarter:        [20, 10, 5],
  half:           [20, 10, 5],
  year:           [45, 30, 20],
  years:          [45, 30, 20],
  on_demand:      [7, 3, 1],
  condition:      [14, 7, 3],
};

function defaultLeadKey(item) {
  if (item.kind === 'condition') return 'condition';
  if (item.kind === 'recurring') return item.rec_unit || 'month';
  if (isDate(item.valid_from) && isDate(item.valid_to) && daysBetween(item.valid_from, item.valid_to) >= 730) {
    return 'validity_long';
  }
  return 'validity_short';
}

function effectiveLeads(item, settings) {
  const defs = Object.assign({}, DEFAULT_LEADS, (settings && settings.default_leads) || {});
  const d = defs[defaultLeadKey(item)] || DEFAULT_LEADS.validity_short;
  const l1 = item.lead_days_1 != null ? +item.lead_days_1 : d[0];
  const l2 = item.lead_days_2 != null ? +item.lead_days_2 : Math.min(d[1], l1);
  const l3 = item.lead_days_3 != null ? +item.lead_days_3 : Math.min(d[2], l2);
  return [l1, l2, l3];
}

/* ── Recurrence ─────────────────────────────────────────────────────────
   rec_unit + rec_due_day (+ rec_due_month) describe when an instance falls
   due. Keys identify the instance and are what makes "the September VAT"
   one row however many times the job runs:
     month    'YYYY-MM'   of the due date
     quarter  'YYYY-Qn'   rec_due_month anchors the cycle (1 → Jan/Apr/Jul/Oct)
     half     'YYYY-Hn'   likewise, every 6 months
     year     'YYYY'      due rec_due_day of rec_due_month
     years    'YYYY'      every rec_interval years from rec_anchor_date
     on_demand            never generated — added by hand when it arises */
function ruleComplete(item) {
  switch (item.rec_unit) {
    case 'month': case 'quarter': case 'half': return item.rec_due_day != null;
    case 'year':  return item.rec_due_day != null && item.rec_due_month != null;
    case 'years': return isDate(item.rec_anchor_date);
    case 'on_demand': return true;
    default: return false;
  }
}

function periodKey(item, due) {
  const { y, m } = parts(due);
  switch (item.rec_unit) {
    case 'month':   return `${y}-${String(m).padStart(2, '0')}`;
    case 'quarter': return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
    case 'half':    return `${y}-H${m <= 6 ? 1 : 2}`;
    default:        return String(y);
  }
}

function periodLabel(item, key) {
  if (/^\d{4}-\d{2}$/.test(key)) { const [y, m] = key.split('-'); return `${MONTHS[+m - 1]} ${y}`; }
  if (/^\d{4}-Q\d$/.test(key)) { const [y, q] = key.split('-'); return `${q} ${y}`; }
  if (/^\d{4}-H\d$/.test(key)) { const [y, h] = key.split('-'); return `${h} ${y}`; }
  return key;
}

/* Due dates of a complete rule, ascending, starting at or after `from`,
   until `untilFn(due)` says stop (inclusive of the date that triggered it).
   Hard-capped so a malformed rule can never spin. */
function dueDatesFrom(item, from, untilFn) {
  const out = [];
  if (!ruleComplete(item) || item.rec_unit === 'on_demand' || !isDate(from)) return out;
  const f = parts(from);
  const day = +item.rec_due_day;
  let cursor;
  const push = due => { if (due >= from) { out.push(due); if (untilFn(due)) return true; } return out.length >= 400; };
  switch (item.rec_unit) {
    case 'month': case 'quarter': case 'half': {
      const step = item.rec_unit === 'month' ? 1 : item.rec_unit === 'quarter' ? 3 : 6;
      const anchor = item.rec_due_month != null ? +item.rec_due_month : 1;
      for (let idx = f.y * 12 + (f.m - 1) - 1; ; idx++) {
        const y = Math.floor(idx / 12), m = (idx % 12) + 1;
        if (step > 1 && ((m - anchor) % step + step) % step !== 0) continue;
        if (push(clampDay(y, m, day))) break;
      }
      break;
    }
    case 'year': {
      for (let y = f.y - 1; ; y++) if (push(clampDay(y, +item.rec_due_month, day))) break;
      break;
    }
    case 'years': {
      const n = Math.max(1, +item.rec_interval || 1);
      const a = parts(item.rec_anchor_date);
      for (let k = 0; ; k++) {
        cursor = clampDay(a.y + k * n, a.m, a.d);
        if (push(cursor)) break;
      }
      break;
    }
  }
  return out;
}

/* Which period rows should exist for a recurring item as of `today`: every
   instance from track_from up to and including the first one beyond the
   reminder horizon, so the next deadline always exists even if the daily
   job skips a day. Returns only the ones not already in `existingKeys`. */
function periodsToCreate(item, today, existingKeys, settings) {
  if (item.kind !== 'recurring' || !ruleComplete(item) || item.rec_unit === 'on_demand') return [];
  const from = isDate(item.track_from) ? item.track_from : today;
  const [l1] = effectiveLeads(item, settings);
  const horizon = addDays(today, Math.max(l1, 31));
  const keys = existingKeys instanceof Set ? existingKeys : new Set(existingKeys || []);
  return dueDatesFrom(item, from, due => due > horizon)
    .map(due => ({ period_key: periodKey(item, due), due_on: due }))
    .filter(p => !keys.has(p.period_key));
}

/* ── Status ─────────────────────────────────────────────────────────────
   ctx: { today, settings, openPeriods: [{due_on, period_key}], hasDirect } */
function computeStatus(item, ctx) {
  const today = ctx.today;
  const leads = effectiveLeads(item, ctx.settings);
  const flags = {
    unverified:        !item.verified_at,
    renewalInProgress: !!item.renewal_in_progress,
    noExpiry:          !!item.no_expiry,
    missingDirect:     ctx.hasDirect === false,
  };
  const out = (status, deadline, reason, extra) => {
    const daysLeft = isDate(deadline) ? daysBetween(today, deadline) : null;
    return Object.assign({ status, deadline: deadline || null, daysLeft, leads, flags, reason }, extra || {});
  };

  if (item.lifecycle === 'archived') return out('archived', null, 'Archived');
  if (item.lifecycle === 'inactive') return out('inactive', null, item.inactive_reason ? `Inactive — ${item.inactive_reason}` : 'Inactive');

  let deadline, label;
  if (item.kind === 'validity') {
    if (item.no_expiry) return out('active', null, 'No expiry');
    if (!isDate(item.valid_to)) return out('undated', null, 'No expiry date set');
    deadline = item.valid_to; label = 'Expires';
  } else if (item.kind === 'recurring') {
    const open = (ctx.openPeriods || []).filter(p => isDate(p.due_on)).sort((a, b) => a.due_on.localeCompare(b.due_on));
    if (open.length) {
      deadline = open[0].due_on;
      label = `${periodLabel(item, open[0].period_key)} due`;
    } else if (item.rec_unit === 'on_demand') {
      return out('active', null, 'As and when required — nothing open');
    } else if (!ruleComplete(item)) {
      return out('undated', null, 'Due day not set');
    } else {
      return out('active', null, 'Up to date');
    }
  } else {
    // condition
    if (item.condition_result === 'not_applicable') return out('inactive', null, 'Not applicable');
    if (item.condition_result === 'not_complied') {
      const d = isDate(item.condition_assessed_on) ? item.condition_assessed_on : today;
      const r = out('overdue', d, `Not complied (assessed ${fmtDate(d)})`);
      r.daysLeft = Math.min(-1, r.daysLeft);
      return withStage(r, item, ctx);
    }
    if (!isDate(item.next_review_on)) {
      if (item.condition_result === 'partial') {
        return withStage(out('due', item.condition_assessed_on || null, 'Partially complied'), item, ctx);
      }
      return out('undated', null, 'No review date set');
    }
    deadline = item.next_review_on; label = 'Review due';
  }

  const daysLeft = daysBetween(today, deadline);
  let status, reason;
  if (daysLeft < 0) {
    status = 'overdue';
    reason = item.kind === 'validity' ? `Expired ${fmtDate(deadline)}` : `${label} ${fmtDate(deadline)} — overdue`;
  } else if (daysLeft <= leads[0]) {
    status = 'due';
    reason = `${label} ${fmtDate(deadline)} (${daysLeft === 0 ? 'today' : `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`})`;
  } else {
    status = 'active';
    reason = `${label} ${fmtDate(deadline)}`;
  }
  if (item.kind === 'condition' && item.condition_result === 'partial' && status === 'active') {
    status = 'due'; reason = `Partially complied — ${reason}`;
  }
  return withStage(out(status, deadline, reason), item, ctx);
}

/* Reminder stage for a computed status. Cumulative audiences:
     D   lead 1 reached   → responsible person
     S   lead 2 reached   → + supervisor
     H   lead 3 reached   → + central Head list
     ODn overdue          → all three; OD0 the day after the deadline, then
                            every `overdue_cadence_days` (7), or every
                            `renewal_cadence_days` (14) once a renewal is
                            in progress.
   A renewal in progress suppresses the pre-deadline stages: the work the
   reminder asks for has already started. */
function withStage(r, item, ctx) {
  const s = (ctx && ctx.settings) || {};
  if (r.status === 'overdue') {
    const cadence = item.renewal_in_progress ? (+s.renewal_cadence_days || 14) : (+s.overdue_cadence_days || 7);
    const over = Math.max(1, -(r.daysLeft == null ? -1 : r.daysLeft));
    r.stage = 'OD' + Math.floor((over - 1) / cadence);
  } else if (r.status === 'due' && !item.renewal_in_progress) {
    if (r.daysLeft == null) r.stage = 'D';
    else r.stage = r.daysLeft <= r.leads[2] ? 'H' : r.daysLeft <= r.leads[1] ? 'S' : 'D';
  } else {
    r.stage = null;
  }
  return r;
}

const AUDIENCES = { D: ['direct'], S: ['direct', 'second'], H: ['direct', 'second', 'head'] };
function audiencesFor(stage) {
  if (!stage) return [];
  if (stage.startsWith('OD')) return ['direct', 'second', 'head'];
  return AUDIENCES[stage] || [];
}

const STATUS_ORDER = ['overdue', 'due', 'undated', 'active', 'inactive', 'archived'];
const STATUS_LABEL = {
  active: 'Active', due: 'Due', overdue: 'Overdue', undated: 'No date set', inactive: 'Inactive', archived: 'Archived',
};

module.exports = {
  TZ, DEFAULT_LEADS, STATUS_ORDER, STATUS_LABEL,
  todayIn, isDate, daysBetween, addDays, addMonths, clampDay, fmtDate,
  effectiveLeads, ruleComplete, periodKey, periodLabel, dueDatesFrom, periodsToCreate,
  computeStatus, audiencesFor,
};
