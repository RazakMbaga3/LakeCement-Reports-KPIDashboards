/*
  services/odooMiningSync.js — pulls Odoo's mining_report weighbridge rows
  into weighbridge_tickets, the table the Quarry dashboard
  (mines-report.html + routes/quarry.js) already reads.

  This replaces a manual step, not a missing one: until now the same data
  reached the app only by a human downloading Odoo's "Uploaded_Data" Excel
  export and uploading it through POST /api/quarry/tickets/import. The
  field mapping below is deliberately identical to what that import
  produces, so a synced row and an uploaded row are indistinguishable to
  every consumer downstream.

      mining_report          weighbridge_tickets
      ─────────────          ───────────────────
      vendor              →  vendor
      vehicle_no          →  vehicle
      transfer_type       →  transfer_type
      movement_type       →  movement_type
      input_product       →  product (TRANSLATED — see PRODUCT_LABEL below)
      gross_date          →  ticket_date (date part) + gross_datetime (raw)
      net_qt              →  net_qty
      uom, reader         →  dropped: constant 'MT'/'RFID' in every row
                             observed, no column for them, no consumer

  ── product code translation, and the bug it fixes ───────────────────────
  input_product arrives as an Odoo product code ('QRM001', 'QRM007', …).
  mines-report.html's TMH_COLS classifies every ticket by an EXACT string
  match on movement_type + product — e.g. movement 'North Mine to Stock
  Yard' + product 'HG' — and its own GRADES table is the only place the
  code↔label correspondence is recorded (HG=QRM001, LG1=QRM003,
  HGHMGO=QRM005, OB=QRM007, LIMESTONE SPG=RM000005, GYPSUM=RM000003).

  The first version of this file wrote the raw Odoo code straight into
  `product` (a plain passthrough, like every other field above). That
  matched no TMH_COLS entry — 'HG' never equals 'QRM001' — so EVERY synced
  ticket silently failed classification: mines-report.html's rebuildIndex()
  skips a row it can't classify exactly like it skips one from Excel with a
  typo'd grade, so the Quarry report showed real ticket counts in the data
  chip alongside a chart and hero cards frozen at 0.00 for every date —
  found 2026-09-09, right after the first production backfill, from the
  live report showing zero material moved despite "14,684 tickets" loaded.
  PRODUCT_LABEL below is copied from mines-report.html's own GRADES object
  (ground truth already trusted elsewhere in that file, not a fresh guess)
  so a synced ticket classifies exactly the same way an Excel-uploaded one
  with the label spelled out would.

  A code with no entry in PRODUCT_LABEL — QRM008 has shown up in every
  production pull so far — is left as its raw Odoo code rather than
  guessed at. The ticket is still stored (a truck really was weighed), it
  is simply excluded from every TMH/MIS total until someone confirms what
  the code is — "ignored like Excel" is mines-report.html's own phrase for
  this, already applied to any grade/movement combo it doesn't recognize.
  Each pull's result reports rowsUnknownProduct + the distinct codes seen
  so this is visible, not a silent gap.

  ── The synthetic ticket number, and its one real weakness ──────────────
  mining_report does not return a ticket number, and weighbridge_tickets
  dedupes on a UNIQUE ticket_no. So each row gets a deterministic surrogate:

      ODOO-<16 hex of sha256(vendor|vehicle|gross_date|movement|product|qty)>

  Deterministic means re-pulling the same range is a no-op rather than a
  duplicate, which is what makes the rolling lookback window safe. The
  'ODOO-' prefix keeps these keys in a namespace no real Odoo ticket number
  can collide with. 64 bits of hash over ~60k rows/year puts a collision at
  the 1-in-10^10 level — not a practical concern.

  The weakness is amendments. If someone corrects a ticket's weight in
  Odoo, the hash changes, so the corrected row looks like a NEW ticket and
  the stale one would linger — inflating that day's tonnage. Content
  hashing cannot detect an edit; only a stable ticket_no can. That is why
  syncDate() below does not merely upsert: for each date it pulls, it
  DELETES the source='odoo' rows that were not in the pull, making the
  synced set for that date an exact mirror of what Odoo currently holds.
  Amendments and deletions both self-heal on the next run within the
  lookback window. Asking the Odoo team for ticket_no would let this drop
  back to a plain upsert — it is an open request, not a solved problem.

  ── Why Excel-sourced dates are skipped by default ──────────────────────
  The Quarry dashboard sums every ticket in a date range. A day holding
  both an Excel upload and an API pull of the same weighings would report
  double the real tonnage, with nothing on screen to show it. Since the two
  sources carry different ticket-number namespaces they cannot dedupe
  against each other, so a date that already has source='excel' rows is
  left alone and reported back as skipped. Passing overwriteExcelDates
  makes the sync replace that date's Excel rows with the API's — an
  explicit operator decision, never a default.
*/

const crypto = require('crypto');
const db     = require('../db');
const logger = require('./logger');
const { fetchMiningReport } = require('./odooMiningClient');

/* 'YYYY-MM-DD HH:MM:SS' → 'YYYY-MM-DD'. Odoo sends a space-separated
   timestamp; anything unparseable is rejected rather than coerced, so a
   format change upstream surfaces as a skipped row with a log line instead
   of a ticket silently filed under the wrong day. */
function dateOf(grossDate) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(grossDate || '').trim());
  return m ? m[1] : null;
}

/* Copied verbatim from mines-report.html's GRADES object — the app's own
   already-confirmed code↔label correspondence, not a guess made here.
   pr labels match TMH_COLS exactly, including 'OB/CLAY' rather than the
   shorter 'OB' key GRADES itself uses internally for other lookups. */
const PRODUCT_LABEL = {
  QRM001:   'HG',
  QRM003:   'LG1',
  QRM005:   'HGHMGO',
  QRM007:   'OB/CLAY',
  RM000005: 'LIMESTONE SPG',
  RM000003: 'GYPSUM',
};

function surrogateTicketNo(row) {
  const parts = [
    row.vendor, row.vehicle_no, row.gross_date,
    row.movement_type, row.input_product, row.net_qt,
  ].map(v => String(v ?? '').trim()).join('|');
  return 'ODOO-' + crypto.createHash('sha256').update(parts).digest('hex').slice(0, 16);
}

/* Raw Odoo row → the column set routes/quarry.js writes, or null if the row
   can't be trusted. A ticket with no usable date or no movement type has
   nowhere valid to land; net_qt must be a real number because it is summed
   straight into plant tonnage. */
function mapRow(row) {
  const ticketDate = dateOf(row.gross_date);
  const netQty     = Number(row.net_qt);

  if (!ticketDate) return { reject: 'no usable gross_date' };
  if (!row.movement_type) return { reject: 'no movement_type' };
  if (!row.input_product) return { reject: 'no input_product' };
  if (!Number.isFinite(netQty)) return { reject: 'net_qt is not a number' };

  const label = PRODUCT_LABEL[row.input_product];

  return {
    unknownProductCode: label ? null : row.input_product,
    ticket: {
      ticket_no:      surrogateTicketNo(row),
      vendor:         row.vendor || '',
      vehicle:        row.vehicle_no || '',
      transfer_type:  row.transfer_type || '',
      movement_type:  row.movement_type,
      product:        label || row.input_product, // untranslated code if unrecognized — see header note
      ticket_date:    ticketDate,
      net_qty:        netQty,
      gross_datetime: String(row.gross_date || ''),
    },
  };
}

/* Groups mapped tickets by date, keeping rejects so nothing vanishes
   silently. Within a date, a repeated surrogate key means two rows were
   byte-identical across every hashed field — the same weighing delivered
   twice by the endpoint, not two events — so the later one is dropped. */
function groupByDate(rows) {
  const byDate = new Map();
  const rejects = [];
  const unknownProductCodes = new Map(); // code -> row count, for reporting only
  let duplicatesCollapsed = 0;

  for (const row of rows) {
    const { ticket, reject, unknownProductCode } = mapRow(row);
    if (reject) { rejects.push({ reason: reject, row }); continue; }
    if (unknownProductCode) {
      unknownProductCodes.set(unknownProductCode, (unknownProductCodes.get(unknownProductCode) || 0) + 1);
    }

    if (!byDate.has(ticket.ticket_date)) byDate.set(ticket.ticket_date, new Map());
    const day = byDate.get(ticket.ticket_date);
    if (day.has(ticket.ticket_no)) { duplicatesCollapsed++; continue; }
    day.set(ticket.ticket_no, ticket);
  }

  return { byDate, rejects, duplicatesCollapsed, unknownProductCodes };
}

const COLS = ['ticket_no', 'vendor', 'vehicle', 'transfer_type', 'movement_type',
  'product', 'ticket_date', 'net_qty', 'gross_datetime', 'source'];

/* Writes one date's tickets so the stored source='odoo' set for that date
   ends up exactly matching what Odoo returned — insert/update what's in the
   pull, delete the source='odoo' rows that aren't. Runs in a transaction:
   a half-applied date would leave the day's tonnage wrong, which is worse
   than not syncing it at all.

   Excel-sourced rows for the date are never touched unless the caller
   explicitly asked for that (see the header). */
async function syncDate(date, tickets, { overwriteExcelDates = false } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (overwriteExcelDates) {
      await client.query(
        "DELETE FROM weighbridge_tickets WHERE ticket_date = $1 AND source = 'excel'", [date]);
    }

    const values = [];
    const tuples = tickets.map((t, i) => {
      const base = i * COLS.length;
      values.push(t.ticket_no, t.vendor, t.vehicle, t.transfer_type, t.movement_type,
        t.product, t.ticket_date, t.net_qty, t.gross_datetime, 'odoo');
      return '(' + COLS.map((_, j) => '$' + (base + j + 1)).join(',') + ')';
    });

    let added = 0;
    let updated = 0;
    if (tuples.length) {
      const result = await client.query(`
        INSERT INTO weighbridge_tickets (${COLS.join(',')})
        VALUES ${tuples.join(',')}
        ON CONFLICT (ticket_no) DO UPDATE SET
          vendor         = EXCLUDED.vendor,
          vehicle        = EXCLUDED.vehicle,
          transfer_type  = EXCLUDED.transfer_type,
          movement_type  = EXCLUDED.movement_type,
          product        = EXCLUDED.product,
          ticket_date    = EXCLUDED.ticket_date,
          net_qty        = EXCLUDED.net_qty,
          gross_datetime = EXCLUDED.gross_datetime,
          source         = EXCLUDED.source,
          updated_at     = NOW()
        RETURNING (xmax = 0) AS inserted
      `, values);
      added   = result.rows.filter(r => r.inserted).length;
      updated = result.rows.length - added;
    }

    /* The amendment/deletion sweep described in the header. */
    const stale = await client.query(`
      DELETE FROM weighbridge_tickets
      WHERE ticket_date = $1 AND source = 'odoo' AND NOT (ticket_no = ANY($2::varchar[]))
    `, [date, tickets.map(t => t.ticket_no)]);

    await client.query('COMMIT');
    return { added, updated, removedStale: stale.rowCount };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* the original error is what matters */ });
    throw err;
  } finally {
    client.release();
  }
}

/* Which of these dates already hold manually uploaded tickets. */
async function excelDates(dates) {
  if (!dates.length) return new Set();
  const { rows } = await db.query(`
    SELECT DISTINCT ticket_date::text AS d
    FROM weighbridge_tickets
    WHERE source = 'excel' AND ticket_date = ANY($1::date[])
  `, [dates]);
  return new Set(rows.map(r => r.d));
}

/* Pull [from, to] inclusive ('YYYY-MM-DD') and mirror it into
   weighbridge_tickets. Returns a summary for the scheduler and the manual
   script — every count it reports is something an operator might have to
   explain, so nothing is rounded away. */
async function pullMiningTickets(from, to, { overwriteExcelDates = false } = {}) {
  const rows = await fetchMiningReport(from, to);
  const { byDate, rejects, duplicatesCollapsed, unknownProductCodes } = groupByDate(rows);

  const dates   = [...byDate.keys()].sort();
  const blocked = overwriteExcelDates ? new Set() : await excelDates(dates);

  let added = 0;
  let updated = 0;
  let removedStale = 0;
  const datesSynced = [];

  for (const date of dates) {
    if (blocked.has(date)) continue;
    const tickets = [...byDate.get(date).values()];
    const r = await syncDate(date, tickets, { overwriteExcelDates });
    added += r.added;
    updated += r.updated;
    removedStale += r.removedStale;
    datesSynced.push(date);
  }

  if (rejects.length) {
    logger.warn({ count: rejects.length, sample: rejects.slice(0, 5) },
      'odoo mining sync: rows rejected as unusable — not written anywhere, check the mapping');
  }
  if (blocked.size) {
    logger.warn({ dates: [...blocked].sort() },
      'odoo mining sync: dates skipped because they already hold manually uploaded (Excel) tickets — '
      + 'syncing them would double-count. Re-run with overwriteExcelDates to replace them.');
  }
  if (unknownProductCodes.size) {
    logger.warn({ codes: Object.fromEntries(unknownProductCodes) },
      'odoo mining sync: tickets stored with an Odoo product code that has no known grade mapping — '
      + 'excluded from every TMH/MIS total until PRODUCT_LABEL in odooMiningSync.js is updated for it.');
  }

  return {
    from, to,
    rowsReceived:        rows.length,
    ticketsMapped:       dates.reduce((n, d) => n + byDate.get(d).size, 0),
    rowsRejected:        rejects.length,
    duplicatesCollapsed,
    datesSynced:         datesSynced.length,
    datesSkippedExcel:   [...blocked].sort(),
    // Stored but excluded from Quarry totals until the code is mapped — see PRODUCT_LABEL.
    rowsUnknownProduct:  [...unknownProductCodes.values()].reduce((a, b) => a + b, 0),
    unknownProductCodes: Object.fromEntries(unknownProductCodes),
    added, updated, removedStale,
  };
}

module.exports = {
  pullMiningTickets,
  // exported for tests / diagnostics
  mapRow, groupByDate, surrogateTicketNo, dateOf, PRODUCT_LABEL,
};
