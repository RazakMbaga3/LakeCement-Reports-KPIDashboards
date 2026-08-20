/*
  routes/formula.js — the KPI formula layer API

  GET    /api/formula/registry              → facts + formula metadata (no functions)
  GET    /api/formula/eval/:year/:month     → every KPI evaluated for the month,
                                              with active overrides applied
  GET    /api/formula/daily?from=&to=       → daily series per KPI (trend charts)
  POST   /api/formula/override              → set a manual override (reason REQUIRED;
                                              supersedes any active one; audited)
  DELETE /api/formula/override/:id          → clear an override (row kept; audited)
  GET    /api/formula/overrides/:year/:month → full override history for the period

  Dashboards render EXCLUSIVELY from this layer — no formula math in page JS.
*/

const express = require('express');
const db      = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, z } = require('../middleware/validate');
const engine  = require('../services/formulaEngine');

const router = express.Router();

const OVERRIDE_ROLES = ['admin', 'md'];

const zYear  = z.coerce.number().int().min(1990).max(2100);
const zMonth = z.coerce.number().int().min(1).max(12);
const zDate  = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date');
const yearMonthParams = z.object({ year: zYear, month: zMonth });

// ── GET /api/formula/registry ────────────────────────────────
router.get('/registry', requireAuth, (req, res) => {
  res.json(engine.registryMeta());
});

// ── GET /api/formula/eval/:year/:month ───────────────────────
router.get('/eval/:year/:month',
  requireAuth, validate(yearMonthParams, 'params'),
  async (req, res, next) => {
    try {
      const { year, month } = req.validated.params;
      res.json(await engine.evalMonth(year, month));
    } catch (err) { next(err); }
  });

// ── GET /api/formula/daily?from=&to= ─────────────────────────
router.get('/daily',
  requireAuth, validate(z.object({ from: zDate, to: zDate }), 'query'),
  async (req, res, next) => {
    try {
      const { from, to } = req.validated.query;
      res.json(await engine.evalDaily(from, to));
    } catch (err) { next(err); }
  });

// ── POST /api/formula/override ───────────────────────────────
const overrideBody = z.object({
  kpi_key: z.enum(Object.keys(engine.FORMULAS)),
  year:    zYear,
  month:   zMonth,
  value:   z.number().finite(),
  reason:  z.string().trim().min(5, 'a meaningful reason (min 5 characters) is required').max(500),
});

router.post('/override',
  requireAuth, requireRole(...OVERRIDE_ROLES), validate(overrideBody, 'body'),
  async (req, res, next) => {
    try {
      const { kpi_key, year, month, value, reason } = req.validated.body;

      // Preserve what the formula computes right now, alongside the override
      const results  = await engine.evalMonth(year, month);
      const computed = results.find(r => r.key === kpi_key)?.computed ?? null;

      // Supersede-then-insert-then-audit as one transaction — a crash
      // between steps must never leave the KPI/period with zero active
      // overrides when the client was told the override succeeded.
      const override = await db.withTransaction(async (client) => {
        await client.query(
          `UPDATE kpi_overrides SET cleared_at = NOW(), cleared_by = $4
           WHERE kpi_key = $1 AND year = $2 AND month = $3 AND cleared_at IS NULL`,
          [kpi_key, year, month, req.user.id]
        );
        const inserted = await client.query(
          `INSERT INTO kpi_overrides
             (kpi_key, year, month, value_override, value_computed, reason, created_by, created_by_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [kpi_key, year, month, value, computed, reason, req.user.id, req.user.name]
        );

        await client.query(
          'INSERT INTO audit_log (user_id, username, action, form_type, details, ip_address) VALUES ($1,$2,$3,$4,$5,$6)',
          [req.user.id, req.user.username, 'KPI_OVERRIDE_SET', `${kpi_key} ${year}-${month}`,
           `computed ${computed ?? '—'} → override ${value} — ${reason}`, req.ip]
        );

        return inserted.rows[0];
      });

      res.json({ success: true, override });
    } catch (err) { next(err); }
  });

// ── DELETE /api/formula/override/:id ─────────────────────────
router.delete('/override/:id',
  requireAuth, requireRole(...OVERRIDE_ROLES),
  validate(z.object({ id: z.coerce.number().int().positive() }), 'params'),
  async (req, res, next) => {
    try {
      const { id } = req.validated.params;
      const ov = await db.withTransaction(async (client) => {
        const result = await client.query(
          `UPDATE kpi_overrides SET cleared_at = NOW(), cleared_by = $2
           WHERE id = $1 AND cleared_at IS NULL
           RETURNING kpi_key, year, month, value_override`,
          [id, req.user.id]
        );
        if (!result.rows[0]) return null;

        const row = result.rows[0];
        await client.query(
          'INSERT INTO audit_log (user_id, username, action, form_type, details, ip_address) VALUES ($1,$2,$3,$4,$5,$6)',
          [req.user.id, req.user.username, 'KPI_OVERRIDE_CLEARED', `${row.kpi_key} ${row.year}-${row.month}`,
           `override ${row.value_override} cleared — formula value back in effect`, req.ip]
        );
        return row;
      });
      if (!ov) return res.status(404).json({ error: 'No active override with that id.' });

      res.json({ success: true });
    } catch (err) { next(err); }
  });

// ── GET /api/formula/overrides/:year/:month ──────────────────
// Full trail for the period — active and historical rows
router.get('/overrides/:year/:month',
  requireAuth, validate(yearMonthParams, 'params'),
  async (req, res, next) => {
    try {
      const { year, month } = req.validated.params;
      const result = await db.query(
        `SELECT o.*, cu.full_name AS cleared_by_name
         FROM kpi_overrides o
         LEFT JOIN users cu ON o.cleared_by = cu.id
         WHERE o.year = $1 AND o.month = $2
         ORDER BY o.created_at DESC`,
        [year, month]
      );
      res.json(result.rows);
    } catch (err) { next(err); }
  });

module.exports = router;
