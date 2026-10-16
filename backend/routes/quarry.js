/*
  routes/quarry.js — Weighbridge Ticket Log (Quarry / mines-report.html)

  Odoo's weighbridge export is a flat ticket list, many rows per day,
  deduped by ticket_no. That shape doesn't fit the generic one-blob-per-day
  `daily_reports` table, so it gets its own table + endpoints — see
  db/schema.sql "WEIGHBRIDGE TICKETS" and db/migrations/005.

  POST /api/quarry/tickets/import  → bulk upsert parsed Excel rows
  GET  /api/quarry/tickets         → all tickets, or ?from=&to= a date range
  GET  /api/quarry/tickets/summary → per (date, movement, product, vendor)
                                      sums — see that route's comment
  GET  /api/quarry/overburden?from=&to= → Odoo Waste Material Entry
                                      (overburden): entries, per-day and
                                      per-contractor totals — see below
  GET  /api/quarry/crusher?from=&to=    → crusher production, apron-feeder
                                      hours and TPH per day

  I-19 / I-32 (RAID_LOG.md, 2026-09-15 → 2026-10-07): mines-report.html
  used to call GET /tickets with no range on every load — fine at 3,909
  test-host tickets, a real outage at 52,285 (20 MB raw, 868 KB gzip,
  2026-10-07 — the Managing Director opened the report to "No weighbridge
  data"). The summary route exists so the page can load the whole fiscal
  year as 1,388 pre-summed rows (216 KB raw, 14 KB gzip — a 98% cut) and
  fetch one real day's raw tickets on demand only when the Ticket Audit
  inspector is opened for it.
*/

const express = require('express');
const db      = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, z, zDate } = require('../middleware/validate');
const { MINES_VIEW_ROLES } = require('../../forms/access-registry.js');
const overburden = require('../services/overburden');
const crusher    = require('../services/crusher');

const router = express.Router();

const ticketRow = z.object({
  ticketNo:      z.string().trim().min(1),
  vendor:        z.string().trim().default(''),
  vehicle:       z.string().trim().default(''),
  transferType:  z.string().trim().default(''),
  movementType:  z.string().trim().min(1),
  product:       z.string().trim().min(1),
  date:          zDate,
  netQty:        z.coerce.number().finite(),
  grossDatetime: z.string().trim().default(''),
});
const importBody = z.object({
  rows: z.array(ticketRow).min(1).max(20000),
});

// ── POST /api/quarry/tickets/import ──────────────────────────
// Bulk upsert by ticket_no. `xmax = 0` is the standard Postgres tell for
// "this row was just inserted" vs "hit the ON CONFLICT branch".
//
// The upsert is one multi-row statement and so atomic on its own, but it
// now shares a transaction with its audit_log row — same reason
// routes/reports.js wraps a form submission: an import the uploader sees
// as accepted must not be able to land with no entry in the trail.
router.post('/tickets/import',
  requireAuth, requireRole('mining', 'admin'),
  validate(importBody, 'body'),
  async (req, res, next) => {
    try {
      const { rows } = req.validated.body;

      const cols = ['ticket_no', 'vendor', 'vehicle', 'transfer_type', 'movement_type',
        'product', 'ticket_date', 'net_qty', 'gross_datetime', 'imported_by'];
      const values = [];
      const tuples = rows.map((r, i) => {
        const base = i * cols.length;
        values.push(r.ticketNo, r.vendor, r.vehicle, r.transferType, r.movementType,
          r.product, r.date, r.netQty, r.grossDatetime, req.user.id);
        return '(' + cols.map((_, j) => '$' + (base + j + 1)).join(',') + ')';
      });

      const dates = rows.map(r => r.date).sort();
      const dmin  = dates[0];
      const dmax  = dates[dates.length - 1];

      const outcome = await db.withTransaction(async (client) => {
        /* What the overwritten tickets weighed BEFORE this import. The
           tickets whose ticket_no already exists are exactly the ones this
           statement is about to destroy the previous values of, and
           weighbridge_tickets keeps no history of them. One aggregate, not
           one row per ticket — the question a reviewer asks is "did the
           tonnage move", not "what did row 14,203 say". */
        const { rows: [before] } = await client.query(
          `SELECT COALESCE(SUM(net_qty), 0) AS net FROM weighbridge_tickets WHERE ticket_no = ANY($1)`,
          [rows.map(r => r.ticketNo)]
        );

        const result = await client.query(`
          INSERT INTO weighbridge_tickets (${cols.join(',')})
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
            updated_at     = NOW()
          RETURNING ticket_no, (xmax = 0) AS inserted
        `, values);

        const overwritten = result.rows.filter(r => !r.inserted).map(r => r.ticket_no);
        const added       = result.rows.length - overwritten.length;

        /* ONE audit row for the whole import, not one per ticket: a single
           upload is one human act, and 20,000 rows of "ticket imported"
           would bury the login and approval entries this log exists to
           surface. So the row has to carry everything the act destroyed —
           who, the dates covered, how many rows were new vs overwritten,
           what the overwritten tickets summed to before and after, and which
           tickets they were. That is what someone asking "who changed the
           quarry numbers for June" needs; anything less sends them to a
           table that no longer holds the answer.

           The ticket list is capped because details is sliced at 4,000 chars
           downstream of here — the count stays exact even when the names
           don't all fit. record_date is deliberately left NULL: an import
           spans a date range and that column holds one date, so the range
           goes in details rather than being misrepresented by its first day. */
        const SHOWN  = 25;
        const sample = overwritten.slice(0, SHOWN).join(', ') +
          (overwritten.length > SHOWN ? `, +${overwritten.length - SHOWN} more` : '');
        // Set, not Array.includes: rows and overwritten are both up to 20,000
        // long, and a linear scan per row makes this quadratic.
        const hit    = new Set(overwritten);
        const newNet = rows.reduce((sum, r) => sum + (hit.has(r.ticketNo) ? r.netQty : 0), 0);

        const details =
          `${result.rows.length} ticket(s) for ${dmin}..${dmax}: ${added} new, ${overwritten.length} overwritten` +
          (overwritten.length
            ? `; net_qty on those ${Number(before.net).toFixed(3)} → ${newNet.toFixed(3)} (${sample})`
            : '');

        await client.query(
          `INSERT INTO audit_log (user_id, username, action, form_type, details, ip_address)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.user.id, req.user.username, 'QUARRY_TICKET_IMPORT', 'weighbridge_tickets',
           details.slice(0, 4000), req.ip]
        );

        return { added, updated: overwritten.length, total: result.rows.length };
      });

      res.json({ ...outcome, dmin, dmax });
    } catch (err) { next(err); }
  });

// ── GET /api/quarry/tickets?from=&to= ────────────────────────
// Read-open to any logged-in role (matches reports.js's ranged GET).
// Omit from/to to fetch the whole log — the client keeps it in memory
// for the session, same as the old localStorage engine did.
router.get('/tickets',
  requireAuth,
  validate(z.object({ from: zDate.optional(), to: zDate.optional() }), 'query'),
  async (req, res, next) => {
    try {
      const { from, to } = req.validated.query;
      let query  = 'SELECT ticket_no, vendor, vehicle, transfer_type, movement_type, product, ticket_date, net_qty, gross_datetime FROM weighbridge_tickets';
      const params = [];
      if (from && to) {
        query += ' WHERE ticket_date BETWEEN $1 AND $2';
        params.push(from, to);
      }
      query += ' ORDER BY ticket_date ASC, ticket_no ASC';

      const result = await db.query(query, params);
      res.json(result.rows);
    } catch (err) { next(err); }
  });

/* GET /api/quarry/tickets/summary?from=&to= — same rows as GET /tickets,
   collapsed to one row per (ticket_date, movement_type, product, vendor)
   with SUM(net_qty) and a ticket count. Every figure mines-report.html
   renders from the bulk load is itself a SUM over some grouping of these
   four columns (TMH_COLS/MIS_GROUPS group by date+movement+product; the
   contractor breakdown groups by date+vendor) — summing this aggregate
   is mathematically identical to summing the raw rows, so nothing the
   page currently computes from the bulk load loses accuracy. What it
   cannot serve is a specific ticket (number, vehicle, weighing time) —
   the page fetches those from GET /tickets for one day at a time, only
   when a cell's drill-down is actually opened. */
router.get('/tickets/summary',
  requireAuth,
  validate(z.object({ from: zDate.optional(), to: zDate.optional() }), 'query'),
  async (req, res, next) => {
    try {
      const { from, to } = req.validated.query;
      let query  = `SELECT ticket_date, movement_type, product, vendor, SUM(net_qty)::numeric AS net_qty, COUNT(*)::int AS n
                     FROM weighbridge_tickets`;
      const params = [];
      if (from && to) {
        query += ' WHERE ticket_date BETWEEN $1 AND $2';
        params.push(from, to);
      }
      query += ' GROUP BY ticket_date, movement_type, product, vendor ORDER BY ticket_date ASC';

      const result = await db.query(query, params);
      res.json(result.rows);
    } catch (err) { next(err); }
  });

/* Both feeds below are ranged reads of small server-side aggregates, gated
   on MINES_VIEW_ROLES — the same audience the Daily MIS summary's Mining
   section uses (services/misReport.js), so the Quarry page cannot show a
   figure the summary withholds or the other way round. A range is required
   and capped at ~3 years: unranged reads are how RAID I-19 happened. */
const MAX_RANGE_DAYS = 1100;
const rangeQuery = z.object({ from: zDate, to: zDate })
  .refine(q => q.from <= q.to, { message: 'from must not be after to', path: ['from'] })
  .refine(q => (Date.parse(q.to) - Date.parse(q.from)) / 86400000 <= MAX_RANGE_DAYS,
    { message: `range must be at most ${MAX_RANGE_DAYS} days`, path: ['to'] });

/* GET /api/quarry/overburden?from=&to= — Odoo's Waste Material Entry,
   mirrored by services/odooWasteSync.js. Overburden is not weighed: Odoo
   records trips and a tonnage of trips × a fixed load per trip, and the
   payload's `basis` sentence says so for the page to show. Approved entries
   are the totals; an entry still awaiting approval in Odoo is in `entries`
   with counted:false and in the day's pending figures, never in the totals. */
router.get('/overburden',
  requireAuth, requireRole(...MINES_VIEW_ROLES),
  validate(rangeQuery, 'query'),
  async (req, res, next) => {
    try {
      const { from, to } = req.validated.query;
      res.json(await overburden.overburdenRange(from, to));
    } catch (err) { next(err); }
  });

/* GET /api/quarry/crusher?from=&to= — per day: crusher production (MT),
   apron-feeder hours and TPH, from the Production Report's two facts only
   (services/crusher.js). A day without apron hours has tph null, never 0. */
router.get('/crusher',
  requireAuth, requireRole(...MINES_VIEW_ROLES),
  validate(rangeQuery, 'query'),
  async (req, res, next) => {
    try {
      const { from, to } = req.validated.query;
      res.json({ from, to, days: await crusher.crusherRange(from, to) });
    } catch (err) { next(err); }
  });

module.exports = router;
