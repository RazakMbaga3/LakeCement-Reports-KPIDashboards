/*
  services/odooWasteSync.js — mirrors Odoo's Waste Material Entry
  (waste_material_entry: the overburden the quarry contractors haul to the
  dump areas) into odoo_waste_material_entries (migration 041), over the
  read-only database login (services/odooDb.js).

  ── Why overburden needed its own feed ──────────────────────────────────
  The Quarry page's "Overburden (waste to dump)" series and the MIS
  summary's "South/North Mine to Dump" rows were both keyed on weighbridge
  movement types ("… to Golani Waste dump") that not one of the 52,000+
  tickets has ever carried — overburden is not weighed. It is recorded in
  Odoo as a daily entry per contractor: trips, and a quantity Odoo derives
  from a fixed load per trip (20 t on 609 of 643 entries; LCL's own trucks
  at 25 t in 2025). Checked 2026-10-15: 2026-09-26 = WM/2026/0117 Remieli
  141 trips 2,820 t + WM/2026/0118 Kambas 50 trips 1,000 t; September 2026
  approved = 128,062 t / 6,404 trips; 1–12 October = 80,780 t / 4,039 trips.

  ── Why each run re-pulls a window, and how wide ────────────────────────
  An entry is created a day or two after its date and approved later still:
  over 2026, write_date − entry_date is 3 days at the median, 13 at p99 and
  17 at worst. So a day is not final when it ends. Each run re-reads every
  entry dated inside WASTE_LOOKBACK_DAYS (21 — the observed maximum plus
  headroom) AND any older entry whose write_date moved in the last few days
  (a late correction to an old entry), and upserts them all by Odoo id.
  waste_material_entry is ~650 rows (no index but the primary key), so this
  is a trivially cheap scan of the live ERP.

  ── States ──────────────────────────────────────────────────────────────
  Every entry is stored with its Odoo state. Totals count state='approved'
  only; anything else in flight is reported separately as awaiting approval,
  and 'cancel' is kept for the record and counted nowhere.

  An entry that vanishes from Odoo (deleted) inside the re-pulled window is
  marked withdrawn, never deleted — and, as in odooProductionSync.js, the
  sweep refuses to run when Odoo returned nothing for a window that holds
  stored entries, or when it would withdraw an implausible share of them.
*/

const db     = require('../db');
const logger = require('./logger');
const odooDb = require('./odooDb');

const WASTE_LOOKBACK_DAYS = 21;
/* An old entry edited in the last N days is re-read even though its date is
   outside the window. Wider than one live tick on purpose, so a few missed
   ticks (server down) still catch the edit. */
const WASTE_RECENT_EDIT_DAYS = 3;

const SWEEP_MAX_FRACTION   = 0.25;
const SWEEP_ALWAYS_ALLOWED = 3;

function isoDate(d) { return d.toISOString().slice(0, 10); }

/* Pure. One Odoo row -> the mirror's columns. Numbers are coerced; a row
   without a usable id or date is returned as null so the caller can count it
   rather than store garbage. */
function normaliseEntry(r) {
  if (!r) return null;
  const id = Number(r.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.d || ''))) return null;
  const trips = r.no_of_trips === null || r.no_of_trips === undefined ? null : Number(r.no_of_trips);
  const qty   = r.quantity === null || r.quantity === undefined ? null : Number(r.quantity);
  return {
    odoo_id: id,
    name: r.name || null,
    entry_date: r.d,
    contractor_id: r.trans_id === null || r.trans_id === undefined ? null : Number(r.trans_id),
    contractor: r.contractor || null,
    trips: Number.isFinite(trips) ? trips : null,
    quantity_mt: Number.isFinite(qty) ? Math.round(qty * 1000) / 1000 : null,
    remarks: r.remarks || null,
    state: r.state || null,
    approval_status: r.approval_status || null,
    odoo_write_date: r.write_date || null,
  };
}

/* Entries dated [from, to], plus any entry edited since `editedSince`
   (pass null to skip that half — the full-history backfill does). The
   contractor name is joined from res_partner (name only). */
async function fetchWasteEntries(from, to, { editedSince = null } = {}) {
  const params = [from, to];
  let where = 'w.entry_date BETWEEN $1 AND $2';
  if (editedSince) { params.push(editedSince); where = `(${where} OR w.write_date >= $3)`; }
  return odooDb.query(
    `SELECT w.id, w.name, w.entry_date::text AS d, w.trans_id, p.name AS contractor,
            w.no_of_trips, w.quantity, w.remarks, w.state, w.approval_status,
            /* As text: a naive Odoo timestamp must round-trip into our
               TIMESTAMP column unchanged, with no local-timezone parse. */
            w.write_date::text AS write_date
       FROM waste_material_entry w
       LEFT JOIN res_partner p ON p.id = w.trans_id
      WHERE ${where}
      ORDER BY w.entry_date, w.id`,
    params);
}

const COLS = ['odoo_id', 'name', 'entry_date', 'contractor_id', 'contractor', 'trips',
  'quantity_mt', 'remarks', 'state', 'approval_status', 'odoo_write_date'];
const INSERT_BATCH = 200;

/* Upsert `entries`, then sweep [from, to] — one transaction, so a half-
   applied window can never leave a day's tonnage wrong. */
async function storeEntries(entries, from, to) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const ids = entries.map(e => e.odoo_id);
    const existing = new Map();
    if (ids.length) {
      const found = await client.query(
        `SELECT odoo_id, odoo_write_date::text AS odoo_write_date, state, quantity_mt::float8 AS q, trips, withdrawn_at
           FROM odoo_waste_material_entries WHERE odoo_id = ANY($1::int[])`, [ids]);
      for (const r of found.rows) existing.set(r.odoo_id, r);
    }

    let added = 0, updated = 0, unchanged = 0, reinstated = 0;
    for (const e of entries) {
      const old = existing.get(e.odoo_id);
      if (!old) { added++; continue; }
      if (old.withdrawn_at) reinstated++;
      const same = old.state === e.state && Number(old.q) === Number(e.quantity_mt) && old.trips === e.trips
        && String(old.odoo_write_date || '') === String(e.odoo_write_date || '');
      if (!same) updated++; else if (!old.withdrawn_at) unchanged++;
    }

    for (let i = 0; i < entries.length; i += INSERT_BATCH) {
      const chunk = entries.slice(i, i + INSERT_BATCH);
      const values = [];
      const tuples = chunk.map((e, j) => {
        COLS.forEach(c => values.push(e[c]));
        const base = j * COLS.length;
        return '(' + COLS.map((_, k) => '$' + (base + k + 1)).join(',') + ')';
      });
      await client.query(`
        INSERT INTO odoo_waste_material_entries (${COLS.join(',')})
        VALUES ${tuples.join(',')}
        ON CONFLICT (odoo_id) DO UPDATE SET
          name            = EXCLUDED.name,
          entry_date      = EXCLUDED.entry_date,
          contractor_id   = EXCLUDED.contractor_id,
          contractor      = EXCLUDED.contractor,
          trips           = EXCLUDED.trips,
          quantity_mt     = EXCLUDED.quantity_mt,
          remarks         = EXCLUDED.remarks,
          state           = EXCLUDED.state,
          approval_status = EXCLUDED.approval_status,
          updated_at = CASE WHEN odoo_waste_material_entries.odoo_write_date IS DISTINCT FROM EXCLUDED.odoo_write_date
                              OR odoo_waste_material_entries.state IS DISTINCT FROM EXCLUDED.state
                            THEN NOW() ELSE odoo_waste_material_entries.updated_at END,
          odoo_write_date = EXCLUDED.odoo_write_date,
          last_seen_at    = NOW(),
          withdrawn_at    = NULL
      `, values);
    }

    /* Sweep only the entry_date window — an entry pulled in through the
       write_date half may be dated anywhere, but the window is the only
       range for which "not returned" means "gone". */
    const live = await client.query(
      `SELECT odoo_id FROM odoo_waste_material_entries
        WHERE entry_date BETWEEN $1 AND $2 AND withdrawn_at IS NULL`, [from, to]);
    const sent = new Set(entries.filter(e => e.entry_date >= from && e.entry_date <= to).map(e => e.odoo_id));
    const missing = live.rows.map(r => r.odoo_id).filter(id => !sent.has(id));

    let withdrawn = 0;
    let sweepSkipped = null;
    if (missing.length) {
      const limit = Math.max(SWEEP_ALWAYS_ALLOWED, Math.floor(live.rows.length * SWEEP_MAX_FRACTION));
      if (sent.size === 0) {
        sweepSkipped = `Odoo returned no waste entries for ${from}..${to} but ${missing.length} are stored — withdrew nothing`;
      } else if (missing.length > limit) {
        sweepSkipped = `would withdraw ${missing.length} of ${live.rows.length} stored waste entries for ${from}..${to} (limit ${limit}) — withdrew nothing`;
      } else {
        const res = await client.query(
          'UPDATE odoo_waste_material_entries SET withdrawn_at = NOW() WHERE odoo_id = ANY($1::int[])', [missing]);
        withdrawn = res.rowCount;
        logger.info({ from, to, ids: missing }, 'odoo waste sync: entries no longer in Odoo were withdrawn');
      }
    }

    await client.query('COMMIT');
    return { added, updated, unchanged, reinstated, withdrawn, sweepSkipped };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* the original error is what matters */ });
    throw err;
  } finally {
    client.release();
  }
}

/* Pull [from, to] (+ recent edits) and mirror it. Skips cleanly — returns
   { skipped } and touches nothing — when the Odoo database login is not
   configured, which is the production droplet's state today. */
async function pullWasteEntries(from, to, { editedSince = null } = {}) {
  if (!odooDb.isConfigured()) return { skipped: 'odoo db not configured', from, to };
  const rows = await fetchWasteEntries(from, to, { editedSince });
  const entries = [];
  const rejectSample = [];
  for (const r of rows) {
    const e = normaliseEntry(r);
    if (e) entries.push(e);
    else if (rejectSample.length < 5) rejectSample.push({ id: r.id, name: r.name, d: r.d });
  }
  const result = await storeEntries(entries, from, to);
  const rejected = rows.length - entries.length;
  if (rejected) logger.warn({ rejected, sample: rejectSample }, 'odoo waste sync: entries without a usable id/date were not stored');
  if (result.sweepSkipped) logger.warn({ sweep: result.sweepSkipped }, 'odoo waste sync: withdrawal sweep refused as implausible');
  return {
    from, to, editedSince, received: rows.length, ...result,
    /* Flat aliases for odooSync.js's dropped-rows alert. */
    rowsRejected: rejected, rowsUnmapped: 0,
  };
}

/* The live job's call: the trailing window plus recent edits. */
function pullWasteEntriesLive(now = new Date()) {
  const to = new Date(now);
  const from = new Date(now); from.setDate(from.getDate() - (WASTE_LOOKBACK_DAYS - 1));
  const since = new Date(now); since.setDate(since.getDate() - WASTE_RECENT_EDIT_DAYS);
  return pullWasteEntries(isoDate(from), isoDate(to), { editedSince: since.toISOString() });
}

module.exports = {
  WASTE_LOOKBACK_DAYS, normaliseEntry, fetchWasteEntries, storeEntries,
  pullWasteEntries, pullWasteEntriesLive,
};
