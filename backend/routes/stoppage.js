/*
  routes/stoppage.js — the governed stoppage REASON CATALOGUE.

  Why this exists: the stoppage entry form used to take the cause of a
  stoppage as free text, so the same fault arrived spelled a dozen ways and
  nothing could be counted. The plant's own monthly "Stoppage report"
  workbook has always had the answer — a fixed, pre-printed list of named
  faults per section, grouped by cause, where the shift only fills in hours
  against the line that happened. That list now lives in `stoppage_reasons`
  (db/migrations/017, seeded with the workbook's 417 rows) and the form
  renders from it instead of showing an empty text box.

  GET  /api/stoppage/reasons  → the active catalogue, for rendering the form
  POST /api/stoppage/reasons  → extend it (the plant meets new faults)

  Deliberately NOT here: writing the day's hours. Those ride the existing
  daily_reports blob through routes/reports.js like every other field on
  every other form — the catalogue rows carry `data-field` names, so they
  save and submit through the path that already exists rather than a second
  write endpoint with its own approval, audit and offline-queue semantics.
*/

const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const { validate, z } = require('../middleware/validate');
const { ROLE_FORM_ACCESS } = require('../config/formAccess');

const router = express.Router();

/* The same equipment/cause key sets services/insights.js uses for the
   stop_<equipment>_<cause> matrix — a reason outside them could never be
   rendered by the form or rolled up by the reliability report. */
const EQUIPMENT = ['crusher', 'rm', 'cm_coal', 'kiln', 'cm1', 'cm2', 'packing'];
const CAUSES    = ['mech', 'ei', 'prod', 'planned', 'power', 'other'];

/* Who may extend the vocabulary: exactly the roles who may submit a
   stoppage report, read from the shared access registry rather than
   hardcoded here, so this can't drift from the form's own gate. Note this
   excludes `admin` — that is the IT/system account and holds no form
   submit rights anywhere in the app (forms/access-registry.js). */
function requireStoppageEntry(req, res, next) {
  const allowed = ROLE_FORM_ACCESS[req.user.role] || [];
  if (!allowed.includes('stoppage')) {
    return res.status(403).json({
      error: `Role '${req.user.role}' may not add stoppage reasons.`,
    });
  }
  next();
}

// ── GET /api/stoppage/reasons ────────────────────────────────
// Whole catalogue in one call (417 rows ≈ 30 KB) — the form needs every
// section up front because all seven tabs render on load.
router.get('/reasons', requireAuth, async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, equipment, cause, label, sort_order, created_by IS NOT NULL AS custom
         FROM stoppage_reasons
        WHERE is_active = TRUE
        ORDER BY equipment, cause, sort_order, id`
    );
    res.json({
      reasons: rows.map(r => ({
        id: r.id, equipment: r.equipment, cause: r.cause,
        label: r.label, sortOrder: r.sort_order, custom: r.custom,
      })),
    });
  } catch (err) { next(err); }
});

const newReason = z.object({
  equipment: z.enum(EQUIPMENT),
  cause:     z.enum(CAUSES),
  label:     z.string().trim().min(3).max(300),
});

// ── POST /api/stoppage/reasons ───────────────────────────────
// Idempotent by (equipment, cause, label): two shifts meeting the same new
// fault at once must both succeed rather than one hitting a 409, and a
// reason previously retired comes back rather than colliding invisibly
// with the unique index. Returns 201 only when a row was actually created.
router.post('/reasons',
  requireAuth, requireStoppageEntry, validate(newReason, 'body'),
  async (req, res, next) => {
    try {
      const { equipment, cause, label } = req.validated.body;

      const outcome = await db.withTransaction(async (client) => {
        const existing = await client.query(
          `SELECT id, label, sort_order, is_active, created_by IS NOT NULL AS custom
             FROM stoppage_reasons
            WHERE equipment = $1 AND cause = $2 AND LOWER(label) = LOWER($3)`,
          [equipment, cause, label]
        );

        if (existing.rows.length) {
          const row = existing.rows[0];
          if (row.is_active) return { created: false, revived: false, row };
          const revived = await client.query(
            `UPDATE stoppage_reasons SET is_active = TRUE WHERE id = $1
             RETURNING id, label, sort_order, created_by IS NOT NULL AS custom`,
            [row.id]
          );
          return { created: false, revived: true, row: revived.rows[0] };
        }

        /* Sort last within its section. sort_order is a single running
           sequence per equipment in the seed (it follows the workbook's
           own row order down the sheet), so a new reason appends rather
           than landing in the middle of another cause's block. */
        const next = await client.query(
          `SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM stoppage_reasons WHERE equipment = $1`,
          [equipment]
        );
        const ins = await client.query(
          `INSERT INTO stoppage_reasons (equipment, cause, label, sort_order, created_by)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING id, label, sort_order, created_by IS NOT NULL AS custom`,
          [equipment, cause, label, next.rows[0].n, req.user.id]
        );

        await client.query(
          `INSERT INTO audit_log (user_id, username, action, form_type, details, ip_address)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.user.id, req.user.username, 'STOPPAGE_REASON_ADD', 'stoppage',
           `${equipment}/${cause}: "${label}"`.slice(0, 4000), req.ip]
        );

        return { created: true, revived: false, row: ins.rows[0] };
      });

      const r = outcome.row;
      res.status(outcome.created ? 201 : 200).json({
        created: outcome.created,
        revived: outcome.revived,
        reason: {
          id: r.id, equipment, cause,
          label: r.label, sortOrder: r.sort_order, custom: r.custom,
        },
      });
    } catch (err) { next(err); }
  });

module.exports = router;
