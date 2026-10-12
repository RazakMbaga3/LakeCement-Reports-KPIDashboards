/*
  services/complianceData.js — loading compliance obligations with
  everything their status depends on, and the read-side aggregates.

  The API, the reminder job and the KPI suggestion all go through here, so
  "how many are overdue" has exactly one answer: rows are loaded, then
  services/complianceStatus.js decides each one's bucket, then the summary
  counts the buckets. Nothing counts statuses in SQL.
*/
const S = require('./complianceStatus');
const { roleLabel } = require('../config/complianceDepartments');

const DEFAULT_SETTINGS = {
  reminders_enabled: false,
  default_leads: {},
  condition_review_months: 3,
  first_review_grace_days: 30,
  overdue_cadence_days: 7,
  renewal_cadence_days: 14,
  hod_fallback: true,
};

async function loadSettings(q) {
  const { rows } = await q.query('SELECT key, value FROM compliance_settings');
  const s = Object.assign({}, DEFAULT_SETTINGS);
  for (const r of rows) s[r.key] = r.value;
  return s;
}

/* Items in scope, with responsibles, open periods and group. `scope` is
   null (every department) or one owner role. Archived rows are left out
   unless asked for. */
async function loadItems(q, { scope = null, ids = null, includeArchived = false } = {}) {
  const where = [];
  const params = [];
  if (scope) { params.push(scope); where.push(`i.owner_role = $${params.length}`); }
  if (ids) { params.push(ids); where.push(`i.id = ANY($${params.length})`); }
  if (!includeArchived) where.push(`i.lifecycle <> 'archived'`);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { rows: items } = await q.query(
    `SELECT i.*, g.code AS group_code, g.title AS group_title, g.kind AS group_kind
       FROM compliance_items i LEFT JOIN compliance_groups g ON g.id = i.group_id
       ${w} ORDER BY i.id`, params);
  if (!items.length) return [];
  const itemIds = items.map(i => i.id);
  const [resp, periods, docs] = await Promise.all([
    q.query(
      `SELECT r.item_id, r.tier, r.position, c.id AS contact_id, c.name, c.active,
              COALESCE(NULLIF(u.email, ''), c.email) AS email, c.user_id
         FROM compliance_item_responsibles r
         JOIN compliance_contacts c ON c.id = r.contact_id
         LEFT JOIN users u ON u.id = c.user_id AND u.active
        WHERE r.item_id = ANY($1) ORDER BY r.item_id, r.tier, r.position`, [itemIds]),
    q.query(
      `SELECT id, item_id, period_key, due_on, status FROM compliance_periods
        WHERE item_id = ANY($1) ORDER BY due_on`, [itemIds]),
    q.query(
      `SELECT item_id, COUNT(*)::int AS n, MAX(uploaded_at) AS last_at
         FROM compliance_documents WHERE item_id = ANY($1) AND retracted_at IS NULL GROUP BY item_id`, [itemIds])
      .catch(() => ({ rows: [] })),
  ]);
  const byItem = new Map(items.map(i => [i.id, Object.assign(i, { direct: [], second: [], openPeriods: [], periodKeys: new Set(), docCount: 0 })]));
  for (const r of resp.rows) {
    const it = byItem.get(r.item_id);
    (r.tier === 1 ? it.direct : it.second).push({ contactId: r.contact_id, name: r.name, email: r.email || null, userId: r.user_id, active: r.active });
  }
  for (const p of periods.rows) {
    const it = byItem.get(p.item_id);
    it.periodKeys.add(p.period_key);
    if (p.status === 'open') it.openPeriods.push(p);
  }
  for (const d of docs.rows) { const it = byItem.get(d.item_id); it.docCount = d.n; it.lastDocAt = d.last_at; }
  return items;
}

function decorate(items, today, settings) {
  for (const it of items) {
    it.computed = S.computeStatus(it, {
      today, settings, openPeriods: it.openPeriods, hasDirect: it.direct.length > 0,
    });
    it.departmentLabel = roleLabel(it.owner_role);
  }
  return items;
}

/* Insert the period rows recurring items should have by now (see
   complianceStatus.periodsToCreate). Returns how many were added. */
/* Reads never write. If today's job has not rolled a recurring item's
   periods forward yet, the instances it WOULD create are added in memory —
   checked against every key the item has, done ones included, so a filing
   already marked done is never re-opened by the simulation. */
function simulatePeriods(items, today, settings) {
  for (const it of items) {
    if (it.kind !== 'recurring' || it.lifecycle !== 'active') continue;
    for (const p of S.periodsToCreate(it, today, it.periodKeys, settings)) {
      it.periodKeys.add(p.period_key);
      it.openPeriods.push(Object.assign({ id: null, simulated: true }, p));
    }
    it.openPeriods.sort((a, b) => String(a.due_on).localeCompare(String(b.due_on)));
  }
  return items;
}

async function ensurePeriods(client, items, today, settings) {
  let added = 0;
  for (const it of items) {
    if (it.kind !== 'recurring' || it.lifecycle !== 'active') continue;
    const missing = S.periodsToCreate(it, today, it.periodKeys, settings);
    for (const p of missing) {
      const r = await client.query(
        `INSERT INTO compliance_periods (item_id, period_key, due_on, source) VALUES ($1,$2,$3,'auto')
         ON CONFLICT (item_id, period_key) DO NOTHING RETURNING id, item_id, period_key, due_on, status`,
        [it.id, p.period_key, p.due_on]);
      it.periodKeys.add(p.period_key);
      if (r.rows.length) { added++; it.openPeriods.push(r.rows[0]); }
    }
    it.openPeriods.sort((a, b) => String(a.due_on).localeCompare(String(b.due_on)));
  }
  return added;
}

async function refreshNextDue(client, items) {
  for (const it of items) {
    const d = it.computed ? it.computed.deadline : null;
    if ((it.next_due_on || null) !== (d || null)) {
      await client.query('UPDATE compliance_items SET next_due_on = $2 WHERE id = $1', [it.id, d]);
      it.next_due_on = d;
    }
  }
}

/* The read model for one item — what the register and the record view get. */
function present(it) {
  const c = it.computed || {};
  return {
    id: it.id, kind: it.kind, owner_role: it.owner_role, department: it.departmentLabel || roleLabel(it.owner_role),
    section_label: it.section_label, entity: it.entity, title: it.title, description: it.description, agency: it.agency,
    reference_no: it.reference_no, custodian: it.custodian, criticality: it.criticality, frequency_label: it.frequency_label,
    group: it.group_id ? { id: it.group_id, code: it.group_code, title: it.group_title, kind: it.group_kind } : null,
    valid_from: it.valid_from, valid_to: it.valid_to, no_expiry: it.no_expiry,
    rec_unit: it.rec_unit, rec_interval: it.rec_interval, rec_due_day: it.rec_due_day, rec_due_month: it.rec_due_month,
    rec_anchor_date: it.rec_anchor_date, track_from: it.track_from,
    review_interval_months: it.review_interval_months, next_review_on: it.next_review_on,
    condition_result: it.condition_result, condition_assessed_on: it.condition_assessed_on,
    lead_days: [it.lead_days_1, it.lead_days_2, it.lead_days_3], effective_leads: c.leads,
    reminders_enabled: it.reminders_enabled, lifecycle: it.lifecycle, inactive_reason: it.inactive_reason,
    renewal_in_progress: it.renewal_in_progress, renewal_note: it.renewal_note, renewal_started_on: it.renewal_started_on,
    verified_at: it.verified_at, verified_by_name: it.verified_by_name, source: it.source,
    fee_amount: it.fee_amount, fee_currency: it.fee_currency, remarks: it.remarks,
    updated_at: it.updated_at, updated_by_name: it.updated_by_name, created_at: it.created_at,
    direct: it.direct, second: it.second, open_periods: it.openPeriods.map(p => ({ id: p.id, period_key: p.period_key, due_on: p.due_on })),
    doc_count: it.docCount || 0, last_doc_at: it.lastDocAt || null,
    status: c.status, deadline: c.deadline, days_left: c.daysLeft, stage: c.stage, reason: c.reason, flags: c.flags,
  };
}

/* ── Summary ─────────────────────────────────────────────────────────────
   Timeframe filters on the DEADLINE ("what falls due in this period"), and
   by default still includes everything already overdue from earlier — an
   item that lapsed in 2025 is not compliant in 2026 just because its date
   is outside the window. Undated and inactive items have no deadline and
   are always included, so the pivot still accounts for every record. */
function timeframeRange(tf, today, from, to) {
  const y = today.slice(0, 4), m = +today.slice(5, 7);
  switch (tf) {
    case 'month':   return [`${y}-${String(m).padStart(2, '0')}-01`, S.addDays(S.addMonths(`${y}-${String(m).padStart(2, '0')}-01`, 1, 1), -1)];
    case 'quarter': { const qm = Math.floor((m - 1) / 3) * 3 + 1; const s = `${y}-${String(qm).padStart(2, '0')}-01`; return [s, S.addDays(S.addMonths(s, 3, 1), -1)]; }
    case 'year':    return [`${y}-01-01`, `${y}-12-31`];
    case 'next30':  return [today, S.addDays(today, 30)];
    case 'next90':  return [today, S.addDays(today, 90)];
    case 'custom':  return [S.isDate(from) ? from : null, S.isDate(to) ? to : null];
    default:        return [null, null];
  }
}

function filterItems(items, f, today) {
  const [from, to] = timeframeRange(f.timeframe, today, f.from, f.to);
  const carry = f.carryOverdue !== false;
  const q = (f.q || '').toLowerCase();
  return items.filter(it => {
    const c = it.computed;
    if (f.dept && it.owner_role !== f.dept) return false;
    if (f.kind && it.kind !== f.kind) return false;
    if (f.entity && it.entity !== f.entity) return false;
    if (f.agency && (it.agency || '') !== f.agency) return false;
    if (f.group && String(it.group_id) !== String(f.group)) return false;
    if (f.status && c.status !== f.status) return false;
    if (f.section && it.section_label !== f.section) return false;
    if (f.verified === 'yes' && !it.verified_at) return false;
    if (f.verified === 'no' && it.verified_at) return false;
    if (f.flag === 'renewal' && !it.renewal_in_progress) return false;
    if (f.flag === 'nodoc' && it.docCount) return false;
    if (f.flag === 'noperson' && it.direct.length) return false;
    if (f.mine && !it.direct.concat(it.second).some(p => p.userId === f.mine)) return false;
    if (q && !`${it.title} ${it.agency || ''} ${it.reference_no || ''} ${it.description || ''} ${it.section_label || ''}`.toLowerCase().includes(q)) return false;
    if (from || to) {
      if (!c.deadline) return true;
      if (carry && c.status === 'overdue' && from && c.deadline < from) return true;
      if (from && c.deadline < from) return false;
      if (to && c.deadline > to) return false;
    }
    return true;
  });
}

const BUCKETS = ['active', 'due', 'overdue', 'undated', 'inactive'];

function summarize(items, opts = {}) {
  const groupBy = opts.groupBy === 'section' ? 'section_label' : 'owner_role';
  const tiles = { total: 0, active: 0, due: 0, overdue: 0, undated: 0, inactive: 0, overdueWithRenewal: 0, verified: 0, tracked: 0 };
  const rowsMap = new Map();
  for (const it of items) {
    const st = it.computed.status;
    if (st === 'archived') continue;
    tiles.total++;
    tiles[st]++;
    if (st !== 'inactive') tiles.tracked++;
    if (st === 'overdue' && it.renewal_in_progress) tiles.overdueWithRenewal++;
    if (it.verified_at) tiles.verified++;
    const key = it[groupBy] || '—';
    if (!rowsMap.has(key)) {
      rowsMap.set(key, { key, label: groupBy === 'owner_role' ? roleLabel(key) : key, active: 0, due: 0, overdue: 0, undated: 0, inactive: 0, total: 0, verified: 0 });
    }
    const r = rowsMap.get(key);
    r[st]++; r.total++; if (it.verified_at) r.verified++;
  }
  const rows = [...rowsMap.values()].sort((a, b) => b.overdue - a.overdue || b.due - a.due || a.label.localeCompare(b.label));
  const totals = rows.reduce((t, r) => { for (const b of BUCKETS) t[b] += r[b]; t.total += r.total; t.verified += r.verified; return t; },
    { active: 0, due: 0, overdue: 0, undated: 0, inactive: 0, total: 0, verified: 0 });
  const live = items.filter(i => !['inactive', 'archived'].includes(i.computed.status));
  const decided = live.filter(i => i.computed.status !== 'undated');
  tiles.compliantPct = decided.length ? Math.round(1000 * decided.filter(i => ['active', 'due'].includes(i.computed.status)).length / decided.length) / 10 : null;
  tiles.verifiedPct = tiles.total ? Math.round(1000 * tiles.verified / tiles.total) / 10 : null;
  tiles.overdueNoAction = tiles.overdue - tiles.overdueWithRenewal;
  const brief = it => ({ id: it.id, title: it.title, department: roleLabel(it.owner_role), owner_role: it.owner_role,
    agency: it.agency, kind: it.kind, deadline: it.computed.deadline, days_left: it.computed.daysLeft, status: it.computed.status,
    reason: it.computed.reason, renewal_in_progress: it.renewal_in_progress, verified: !!it.verified_at });
  const upcoming = items.filter(i => i.computed.status === 'due' || (i.computed.status === 'active' && i.computed.daysLeft != null && i.computed.daysLeft <= 30))
    .sort((a, b) => a.computed.daysLeft - b.computed.daysLeft).slice(0, 25).map(brief);
  const overdue = items.filter(i => i.computed.status === 'overdue')
    .sort((a, b) => (a.computed.daysLeft ?? 0) - (b.computed.daysLeft ?? 0)).slice(0, 25).map(brief);
  const gaps = {
    undated: items.filter(i => i.computed.status === 'undated').length,
    noResponsible: live.filter(i => !i.direct.length).length,
    contactsWithoutEmail: new Set(live.flatMap(i => i.direct.concat(i.second)).filter(p => !p.email).map(p => p.contactId)).size,
    unverified: items.filter(i => !i.verified_at && i.computed.status !== 'archived').length,
    noDocument: live.filter(i => i.kind === 'validity' && !i.docCount).length,
  };
  return { tiles, pivot: { groupBy: groupBy === 'section_label' ? 'section' : 'department', rows, totals }, upcoming, overdue, gaps };
}

async function writeSnapshot(client, items, today) {
  const by = new Map();
  for (const it of items) {
    const st = it.computed.status;
    if (st === 'archived') continue;
    const r = by.get(it.owner_role) || { active: 0, due: 0, overdue: 0, undated: 0, inactive: 0, verified: 0, total: 0 };
    r[st]++; r.total++; if (it.verified_at) r.verified++;
    by.set(it.owner_role, r);
  }
  for (const [role, r] of by) {
    await client.query(
      `INSERT INTO compliance_snapshots (as_of, owner_role, active, due, overdue, undated, inactive, verified, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (as_of, owner_role) DO UPDATE SET active=$3, due=$4, overdue=$5, undated=$6, inactive=$7, verified=$8, total=$9`,
      [today, role, r.active, r.due, r.overdue, r.undated, r.inactive, r.verified, r.total]);
  }
  return by.size;
}

module.exports = {
  DEFAULT_SETTINGS, loadSettings, loadItems, decorate, simulatePeriods, ensurePeriods, refreshNextDue, present,
  filterItems, summarize, timeframeRange, writeSnapshot,
};
