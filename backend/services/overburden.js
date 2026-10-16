/*
  services/overburden.js — reads the overburden mirror
  (odoo_waste_material_entries, filled by services/odooWasteSync.js) for the
  Daily MIS summary and the Quarry page. Nothing here talks to Odoo.

  Three rules every reader below keeps, because each one is a way this
  figure could quietly lie:

  1. Only state='approved' entries are counted. Anything still moving
     through Odoo's approval is returned separately as `pending`, labelled,
     and never added in; 'cancel' is ignored; withdrawn entries (deleted in
     Odoo) are excluded.
  2. A date with no entry is NOT a zero. Contractors' entries arrive one to
     thirteen days after the date (services/odooWasteSync.js), so "nothing
     recorded yet" is the common case for the most recent days. The on-date
     figure is null when there is no approved entry; MTD/YTD are sums over
     the entries that exist and null when there are none at all.
  3. The tonnage is Odoo's own `quantity`, which Odoo derives from trips ×
     a fixed load per trip (20 t on 609 of 643 entries) — it is not weighed,
     and LOAD_FACTOR_NOTE says so wherever it is shown.
*/

const db = require('../db');

const LOAD_FACTOR_NOTE =
  'Overburden tonnage is Odoo\'s Waste Material Entry figure — trips × a fixed load per trip (20 t), not weighed.';

const PULL_NAME = 'waste-material-entries';

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function r2(v) { return v === null || v === undefined ? null : Math.round(v * 100) / 100; }

/* Pure. Entry rows (any state) -> per-day totals, approved and pending
   kept apart. Exported for the tests. */
function summariseByDay(entries) {
  const byDay = new Map();
  for (const e of entries) {
    if (e.state === 'cancel') continue;
    const d = e.entry_date;
    if (!byDay.has(d)) byDay.set(d, { date: d, mt: null, trips: null, entries: 0, pendingMt: 0, pendingTrips: 0, pendingEntries: 0 });
    const day = byDay.get(d);
    if (e.state === 'approved') {
      day.mt = r2((day.mt || 0) + n(e.quantity_mt));
      day.trips = (day.trips || 0) + n(e.trips);
      day.entries++;
    } else {
      day.pendingMt = r2(day.pendingMt + n(e.quantity_mt));
      day.pendingTrips += n(e.trips);
      day.pendingEntries++;
    }
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/* Pure. Day totals -> { onDate, mtd, ytd } for MT and trips, plus pending.
   `days` must already be limited to [fyFrom, date]. */
function periodTotals(days, date, moFrom) {
  const out = {
    mt:    { onDate: null, mtd: null, ytd: null },
    trips: { onDate: null, mtd: null, ytd: null },
    pending: { entries: 0, mt: 0, trips: 0 },
    daysWithEntries: 0,
  };
  for (const d of days) {
    out.pending.entries += d.pendingEntries;
    out.pending.mt = r2(out.pending.mt + d.pendingMt);
    out.pending.trips += d.pendingTrips;
    if (d.mt === null) continue;
    out.daysWithEntries++;
    out.mt.ytd = r2((out.mt.ytd || 0) + d.mt);
    out.trips.ytd = (out.trips.ytd || 0) + d.trips;
    if (d.date >= moFrom) {
      out.mt.mtd = r2((out.mt.mtd || 0) + d.mt);
      out.trips.mtd = (out.trips.mtd || 0) + d.trips;
    }
    if (d.date === date) { out.mt.onDate = d.mt; out.trips.onDate = d.trips; }
  }
  return out;
}

async function loadEntries(from, to) {
  const { rows } = await db.query(
    `SELECT odoo_id, name, entry_date::text AS entry_date, contractor, trips,
            quantity_mt::float8 AS quantity_mt, remarks, state, approval_status
       FROM odoo_waste_material_entries
      WHERE entry_date BETWEEN $1 AND $2 AND withdrawn_at IS NULL
      ORDER BY entry_date, odoo_id`,
    [from, to]);
  return rows;
}

/* When the pull last succeeded, and whether the mirror holds anything at
   all — so a reader can tell "no overburden yet" from "never synced". */
async function feedStatus() {
  const [state, count] = await Promise.all([
    db.query('SELECT last_success_at, last_error_at FROM odoo_sync_state WHERE pull_name = $1', [PULL_NAME])
      .catch(() => ({ rows: [] })),
    db.query('SELECT COUNT(*)::int AS n, MAX(entry_date)::text AS last_date FROM odoo_waste_material_entries WHERE withdrawn_at IS NULL'),
  ]);
  const s = state.rows[0] || {};
  return {
    entriesStored: count.rows[0].n,
    lastEntryDate: count.rows[0].last_date,
    lastSyncAt: s.last_success_at || null,
  };
}

/* For the MIS daily summary: on-date / MTD / YTD from the fiscal year. */
async function overburdenTotals(date, moFrom, fyFrom) {
  const [entries, status] = await Promise.all([loadEntries(fyFrom, date), feedStatus()]);
  return { ...periodTotals(summariseByDay(entries), date, moFrom), status };
}

/* For the Quarry page: entries, per-day totals and per-contractor totals for
   [from, to]. The entry list carries every non-cancelled state so the page
   can show what is awaiting approval — clearly marked — beside what counts. */
async function overburdenRange(from, to) {
  const [entries, status] = await Promise.all([loadEntries(from, to), feedStatus()]);
  const live = entries.filter(e => e.state !== 'cancel');
  const byContractor = new Map();
  for (const e of live) {
    if (e.state !== 'approved') continue;
    const k = e.contractor || 'Unknown contractor';
    const c = byContractor.get(k) || { contractor: k, mt: 0, trips: 0, entries: 0 };
    c.mt = r2(c.mt + n(e.quantity_mt)); c.trips += n(e.trips); c.entries++;
    byContractor.set(k, c);
  }
  return {
    from, to,
    basis: LOAD_FACTOR_NOTE,
    status,
    days: summariseByDay(live),
    contractors: [...byContractor.values()].sort((a, b) => b.mt - a.mt),
    entries: live.map(e => ({
      id: e.odoo_id, name: e.name, date: e.entry_date, contractor: e.contractor,
      trips: e.trips, mt: e.quantity_mt, remarks: e.remarks,
      state: e.state, counted: e.state === 'approved',
    })),
  };
}

module.exports = {
  LOAD_FACTOR_NOTE, PULL_NAME, summariseByDay, periodTotals,
  overburdenTotals, overburdenRange, feedStatus,
};
