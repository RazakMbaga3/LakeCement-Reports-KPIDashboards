/*
  routes/power.js — fixed Specific Power targets for the Power Consumption
  Report (Section 1's "Target (kWh/MT)" column).

  Why this exists: those targets used to be a plain <input value="X.XX">
  baked into forms/power-form.html — editable in the browser but never
  saved, so every officer who opened the page could silently change what
  is really a fixed, roughly-yearly engineering figure. `power_targets`
  (migration 022) is the one authoritative value per section; every day's
  report reads it read-only instead of typing it fresh.

  GET /api/power/targets       → the current 8 values, for painting the
                                  Target column and driving Variance/live
                                  math client-side.
  PUT /api/power/targets/:sec  → change one section's target deliberately.

  Deliberately NOT here: the day's kWh/Production entries. Those ride the
  existing daily_reports blob through routes/reports.js like every other
  field on every other form — this route only owns the target constant.
*/

const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const { validate, z } = require('../middleware/validate');
const { ROLE_FORM_ACCESS } = require('../config/formAccess');

const router = express.Router();

/* Section 1's 8 rows, post-2026-09-22 restructure (Raw Mill/Packing/
   Utilities each combine what used to be 2-3 separate rows — see
   forms/power-form.html's own comment). Kept in one place so an invalid
   section name 400s instead of silently creating an orphan row nothing
   on the form would ever read. */
const SECTIONS = ['crusher', 'rawmill', 'coalmill', 'kiln', 'cm1', 'cm2', 'packing', 'utilities'];

/* Who may change a target: the same roles who may submit a Power
   Consumption report — read from the shared access registry so this
   can't drift from the form's own submit gate, same doctrine
   routes/stoppage.js uses for its reason catalogue. */
function requirePowerCons(req, res, next) {
  const allowed = ROLE_FORM_ACCESS[req.user.role] || [];
  if (!allowed.includes('power-cons')) {
    return res.status(403).json({
      error: `Role '${req.user.role}' may not change Power Consumption targets.`,
    });
  }
  next();
}

// ── GET /api/power/targets ───────────────────────────────────
router.get('/targets', requireAuth, async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT section, target_kwh_mt FROM power_targets ORDER BY section`
    );
    const targets = {};
    rows.forEach(r => { targets[r.section] = Number(r.target_kwh_mt); });
    res.json({ targets });
  } catch (err) { next(err); }
});

const targetBody = z.object({
  target_kwh_mt: z.number().positive().max(9999.99),
});

// ── PUT /api/power/targets/:section ──────────────────────────
router.put('/targets/:section',
  requireAuth, requirePowerCons, validate(targetBody, 'body'),
  async (req, res, next) => {
    try {
      const { section } = req.params;
      if (!SECTIONS.includes(section)) {
        return res.status(400).json({ error: `Unknown section '${section}'.` });
      }
      const { target_kwh_mt } = req.validated.body;

      const row = await db.withTransaction(async (client) => {
        const upd = await client.query(
          `INSERT INTO power_targets (section, target_kwh_mt, updated_by, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (section) DO UPDATE
             SET target_kwh_mt = EXCLUDED.target_kwh_mt,
                 updated_by    = EXCLUDED.updated_by,
                 updated_at    = NOW()
           RETURNING section, target_kwh_mt`,
          [section, target_kwh_mt, req.user.id]
        );

        await client.query(
          `INSERT INTO audit_log (user_id, username, action, form_type, details, ip_address)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.user.id, req.user.username, 'POWER_TARGET_SET', 'power-cons',
           `${section} -> ${target_kwh_mt} kWh/MT`, req.ip]
        );

        return upd.rows[0];
      });

      res.json({ section: row.section, target_kwh_mt: Number(row.target_kwh_mt) });
    } catch (err) { next(err); }
  });

module.exports = router;
