/*
  routes/quarry.js — Weighbridge Ticket Log (Quarry / mines-report.html)

  Odoo's weighbridge export is a flat ticket list, many rows per day,
  deduped by ticket_no. That shape doesn't fit the generic one-blob-per-day
  `daily_reports` table, so it gets its own table + endpoints — see
  db/schema.sql "WEIGHBRIDGE TICKETS" and db/migrations/005.

  POST /api/quarry/tickets/import  → bulk upsert parsed Excel rows
  GET  /api/quarry/tickets         → all tickets, or ?from=&to= a date range
*/

const express = require('express');
const db      = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, z, zDate } = require('../middleware/validate');

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
// Bulk upsert by ticket_no. One multi-row statement — atomic by nature,
// no explicit transaction needed. `xmax = 0` is the standard Postgres
// tell for "this row was just inserted" vs "hit the ON CONFLICT branch".
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

      const result = await db.query(`
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
        RETURNING (xmax = 0) AS inserted
      `, values);

      const added   = result.rows.filter(r => r.inserted).length;
      const updated = result.rows.length - added;
      const dates   = rows.map(r => r.date).sort();

      res.json({
        added, updated,
        dmin: dates[0], dmax: dates[dates.length - 1],
        total: result.rows.length,
      });
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

module.exports = router;
