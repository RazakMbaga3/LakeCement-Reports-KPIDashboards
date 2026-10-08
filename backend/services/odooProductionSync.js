/*
  services/odooProductionSync.js — pulls Odoo's production_report into the
  odoo_production_entries mirror (migration 018) and reads it back as one
  day's daily-report facts.

  Phase 1 of the "Odoo Production Autofill" plan: this stores and maps. It does
  not write to daily_reports and is not on the nightly schedule yet (see
  odooSync.js) — nothing a user sees changes until the form prefill lands.

  ── Why this is not a plain upsert ──────────────────────────────────────
  The endpoint returns no approval status and no timestamps. Two things follow:

  1. An amended entry is only visible as different content under the same
     reference. Each row carries a content hash; a changed hash rewrites the
     row and counts a revision.
  2. An entry that is deleted, or sent back to draft, simply stops appearing.
     Nothing says so. After each window the sync marks live entries in that
     window that were not returned as withdrawn (kept, never deleted) and every
     reader ignores them, so the day's tonnage cannot keep a ghost entry.

  That sweep is the one dangerous step: a response that is wrong-but-HTTP-200
  (the sibling endpoints have truncated large ranges that way) would withdraw
  real entries. So it refuses to run — and says so — when Odoo returned nothing
  for a window that holds stored entries, or when it would withdraw more than
  a quarter of them (never fewer than 5 are blocked, so a small window still
  self-heals). Refused sweeps are reported, not retried silently.
*/

const db     = require('../db');
const logger = require('./logger');
const { fetchProductionReport } = require('./odooProductionClient');
const { flattenReport, splitRange, mapDay } = require('./odooProductionMapper');

const SWEEP_MAX_FRACTION   = 0.25;
const SWEEP_ALWAYS_ALLOWED = 5;
const INSERT_BATCH         = 200;

/* The header fields from 'coal_ncv' on arrived with the Odoo team's
   2026-10-08 deploy (migration 033). They are stored even though only some
   reach daily_reports today: the mirror's job is to hold what Odoo said, and
   config/odooProductionMap.js decides separately what becomes a fact. */
const COLS = ['entry_ref', 'production_date', 'picking_type', 'stage', 'product_code',
  'product_name', 'uom', 'produced_qty', 'total_input_qty', 'consumed_items', 'content_hash',
  'coal_ncv', 'running_hours', 'tph', 'kiln_feed_value', 'state', 'approval_status', 'mill_type'];

/* Writes one window's entries and sweeps that window, in one transaction: a
   half-applied window would leave a day's tonnage wrong, which is worse than
   not syncing it. `alsoPresent` lists references Odoo did send but we refused
   to store (malformed); they must not be swept as if Odoo had dropped them. */
async function storeEntries(rows, from, to, { alsoPresent = [] } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const refs = rows.map(r => r.entry_ref);
    const existing = new Map();
    if (refs.length) {
      const found = await client.query(
        'SELECT entry_ref, content_hash, withdrawn_at FROM odoo_production_entries WHERE entry_ref = ANY($1::varchar[])',
        [refs]);
      for (const r of found.rows) existing.set(r.entry_ref, r);
    }

    let added = 0, updated = 0, unchanged = 0, reinstated = 0;
    for (const r of rows) {
      const old = existing.get(r.entry_ref);
      if (!old) { added++; continue; }
      if (old.withdrawn_at) reinstated++;
      if (old.content_hash !== r.content_hash) updated++;
      else if (!old.withdrawn_at) unchanged++;
    }

    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const chunk = rows.slice(i, i + INSERT_BATCH);
      const values = [];
      const tuples = chunk.map((r, j) => {
        values.push(r.entry_ref, r.production_date, r.picking_type, r.stage, r.product_code,
          r.product_name, r.uom, r.produced_qty, r.total_input_qty, JSON.stringify(r.consumed_items), r.content_hash,
          r.coal_ncv ?? null, r.running_hours ?? null, r.tph ?? null, r.kiln_feed_value ?? null,
          r.state ?? null, r.approval_status ?? null, r.mill_type ?? null);
        const base = j * COLS.length;
        return '(' + COLS.map((c, k) => '$' + (base + k + 1) + (c === 'consumed_items' ? '::jsonb' : '')).join(',') + ')';
      });
      await client.query(`
        INSERT INTO odoo_production_entries (${COLS.join(',')})
        VALUES ${tuples.join(',')}
        ON CONFLICT (entry_ref) DO UPDATE SET
          production_date = EXCLUDED.production_date,
          picking_type    = EXCLUDED.picking_type,
          stage           = EXCLUDED.stage,
          product_code    = EXCLUDED.product_code,
          product_name    = EXCLUDED.product_name,
          uom             = EXCLUDED.uom,
          produced_qty    = EXCLUDED.produced_qty,
          total_input_qty = EXCLUDED.total_input_qty,
          consumed_items  = EXCLUDED.consumed_items,
          coal_ncv        = EXCLUDED.coal_ncv,
          running_hours   = EXCLUDED.running_hours,
          tph             = EXCLUDED.tph,
          kiln_feed_value = EXCLUDED.kiln_feed_value,
          state           = EXCLUDED.state,
          approval_status = EXCLUDED.approval_status,
          mill_type       = EXCLUDED.mill_type,
          revision   = CASE WHEN odoo_production_entries.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                            THEN odoo_production_entries.revision + 1 ELSE odoo_production_entries.revision END,
          updated_at = CASE WHEN odoo_production_entries.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                            THEN NOW() ELSE odoo_production_entries.updated_at END,
          content_hash = EXCLUDED.content_hash,
          last_seen_at = NOW(),
          withdrawn_at = NULL
      `, values);
    }

    const live = await client.query(
      'SELECT entry_ref FROM odoo_production_entries WHERE production_date BETWEEN $1 AND $2 AND withdrawn_at IS NULL',
      [from, to]);
    const sent = new Set([...refs, ...alsoPresent]);
    const missing = live.rows.map(r => r.entry_ref).filter(ref => !sent.has(ref));

    let withdrawn = 0;
    let sweepSkipped = null;
    if (missing.length) {
      const limit = Math.max(SWEEP_ALWAYS_ALLOWED, Math.floor(live.rows.length * SWEEP_MAX_FRACTION));
      if (sent.size === 0) {
        sweepSkipped = `Odoo returned no entries for ${from}..${to} but ${missing.length} are stored — withdrew nothing`;
      } else if (missing.length > limit) {
        sweepSkipped = `would withdraw ${missing.length} of ${live.rows.length} stored entries for ${from}..${to} (limit ${limit}) — withdrew nothing`;
      } else {
        const res = await client.query(
          'UPDATE odoo_production_entries SET withdrawn_at = NOW() WHERE entry_ref = ANY($1::varchar[])',
          [missing]);
        withdrawn = res.rowCount;
        logger.info({ from, to, refs: missing }, 'odoo production sync: entries no longer in Odoo were withdrawn');
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

/* Pull [from, to] inclusive ('YYYY-MM-DD') a month at a time and mirror it.
   `fetchReport` is injectable so the acceptance script can run the whole path
   without a network. Returns a summary in which every count is something an
   operator might have to explain. */
async function pullProductionEntries(from, to, { fetchReport = fetchProductionReport } = {}) {
  const windows = splitRange(from, to);
  const summary = {
    from, to, windows: windows.length,
    received: 0, added: 0, updated: 0, unchanged: 0, reinstated: 0, withdrawn: 0,
    rejected: 0, rejectSample: [], duplicateRefs: 0,
    unmappedPickingTypes: {}, sweepsSkipped: [],
  };

  for (const w of windows) {
    const data = await fetchReport(w.from, w.to);
    const { rows, rejects, duplicateRefs } = flattenReport(data);

    for (const r of rows) {
      if (!r.stage) summary.unmappedPickingTypes[r.picking_type] = (summary.unmappedPickingTypes[r.picking_type] || 0) + 1;
    }
    const result = await storeEntries(rows, w.from, w.to, { alsoPresent: rejects.map(r => r.ref).filter(Boolean) });

    summary.received      += rows.length + rejects.length;
    summary.rejected      += rejects.length;
    summary.duplicateRefs += duplicateRefs;
    if (summary.rejectSample.length < 5) summary.rejectSample.push(...rejects.slice(0, 5 - summary.rejectSample.length));
    for (const k of ['added', 'updated', 'unchanged', 'reinstated', 'withdrawn']) summary[k] += result[k];
    if (result.sweepSkipped) summary.sweepsSkipped.push(result.sweepSkipped);
  }

  if (summary.rejected) {
    logger.warn({ count: summary.rejected, sample: summary.rejectSample },
      'odoo production sync: entries rejected as unusable — not stored, check the mapper');
  }
  if (Object.keys(summary.unmappedPickingTypes).length) {
    logger.warn({ pickingTypes: summary.unmappedPickingTypes },
      'odoo production sync: entries stored with a picking type that has no stage mapping — '
      + 'they feed no report field until STAGE_BY_PICKING_TYPE in config/odooProductionMap.js is updated');
  }
  if (summary.sweepsSkipped.length) {
    logger.warn({ sweeps: summary.sweepsSkipped },
      'odoo production sync: a withdrawal sweep was refused as implausible — check Odoo before trusting these days');
  }
  return summary;
}

/* Stored entries for [from, to] -> { 'YYYY-MM-DD': mapDay(...) }. Only days
   with at least one live entry appear; what a missing day means is the
   caller's decision (see mapDay). */
async function loadRangeFacts(from, to) {
  const { rows } = await db.query(`
    SELECT entry_ref, production_date::text AS day, stage, product_code,
           produced_qty::float8 AS produced_qty, consumed_items,
           coal_ncv::float8        AS coal_ncv,
           running_hours::float8   AS running_hours,
           tph::float8             AS tph,
           kiln_feed_value::float8 AS kiln_feed_value
    FROM odoo_production_entries
    WHERE production_date BETWEEN $1 AND $2 AND withdrawn_at IS NULL
    ORDER BY production_date, entry_ref
  `, [from, to]);

  const byDay = {};
  for (const r of rows) {
    (byDay[r.day] ||= []).push({
      ref: r.entry_ref, stage: r.stage, product_code: r.product_code,
      produced_qty: r.produced_qty, consumed_items: r.consumed_items,
      coal_ncv: r.coal_ncv, running_hours: r.running_hours,
      tph: r.tph, kiln_feed_value: r.kiln_feed_value,
    });
  }
  const out = {};
  for (const [day, entries] of Object.entries(byDay)) out[day] = mapDay(entries);
  return out;
}

async function loadDayFacts(date) {
  const one = await loadRangeFacts(date, date);
  return one[date] || null;
}

module.exports = {
  pullProductionEntries, storeEntries, loadRangeFacts, loadDayFacts,
  SWEEP_MAX_FRACTION, SWEEP_ALWAYS_ALLOWED,
};
