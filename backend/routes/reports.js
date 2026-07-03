/*
  routes/reports.js — Daily Form Submit & Retrieve

  All 10 forms (production, dispatch, quality, power, kiln,
  cement-mill, limestone, materials, pile-quality, stoppage)
  use the same endpoints. The "form_type" field differentiates them.

  POST /api/reports/:formType           → submit/update a daily form
  GET  /api/reports/:formType/:date     → get one day's data
  GET  /api/reports/:formType?from=&to= → get a date range (for monthly/YTD views)
*/

const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Valid form types — prevents someone injecting garbage form types
const VALID_FORMS = [
  'production', 'dispatch', 'quality', 'power',
  'kiln', 'cement-mill', 'limestone', 'materials',
  'pile-quality', 'stoppage'
];

// ── POST /api/reports/:formType ──────────────────────────────
// Submit or update a daily form
// The browser sends: { date: "2026-06-08", shift: "day", data: { field1: val, ... } }
router.post('/:formType', requireAuth, async (req, res) => {
  try {
    const { formType } = req.params;
    const { date, shift = 'day', data } = req.body;

    if (!VALID_FORMS.includes(formType)) {
      return res.status(400).json({ error: 'Invalid form type.' });
    }
    if (!date || !data) {
      return res.status(400).json({ error: 'Date and data are required.' });
    }

    // INSERT OR UPDATE — if a record for this form+date+shift already exists, update it
    // This is called an "upsert" — INSERT on conflict UPDATE
    const result = await db.query(`
      INSERT INTO daily_reports (form_type, record_date, shift, data, submitted_by, submitted_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (form_type, record_date, shift)
      DO UPDATE SET
        data       = EXCLUDED.data,
        updated_by = $5,
        updated_at = NOW()
      RETURNING *
    `, [formType, date, shift, JSON.stringify(data), req.user.id]);

    // Log the action
    await db.query(
      'INSERT INTO audit_log (user_id, username, action, form_type, record_date, ip_address) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.user.id, req.user.username, 'FORM_SUBMIT', formType, date, req.ip]
    );

    res.json({ success: true, record: result.rows[0] });

  } catch (err) {
    console.error('Report submit error:', err);
    res.status(500).json({ error: 'Failed to save report.' });
  }
});

// ── GET /api/reports/:formType/:date ────────────────────────
// Get one specific day's data for a form
// e.g. GET /api/reports/production/2026-06-08
router.get('/:formType/:date', requireAuth, async (req, res) => {
  try {
    const { formType, date } = req.params;
    const { shift = 'day' } = req.query;

    if (!VALID_FORMS.includes(formType)) {
      return res.status(400).json({ error: 'Invalid form type.' });
    }

    const result = await db.query(
      'SELECT * FROM daily_reports WHERE form_type = $1 AND record_date = $2 AND shift = $3',
      [formType, date, shift]
    );

    // Return the record if found, or null (form not yet filled for this day)
    res.json(result.rows[0] || null);

  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch report.' });
  }
});

// ── GET /api/reports/:formType?from=2026-06-01&to=2026-06-30 ─
// Get all records for a form in a date range (used for monthly/YTD views)
router.get('/:formType', requireAuth, async (req, res) => {
  try {
    const { formType } = req.params;
    const { from, to, shift } = req.query;

    if (!VALID_FORMS.includes(formType)) {
      return res.status(400).json({ error: 'Invalid form type.' });
    }
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to date parameters are required.' });
    }

    let query = `
      SELECT r.*, u.full_name as submitted_by_name
      FROM daily_reports r
      LEFT JOIN users u ON r.submitted_by = u.id
      WHERE r.form_type = $1 AND r.record_date BETWEEN $2 AND $3
    `;
    const params = [formType, from, to];

    if (shift) {
      query += ` AND r.shift = $4`;
      params.push(shift);
    }

    query += ` ORDER BY r.record_date ASC`;

    const result = await db.query(query, params);
    res.json(result.rows);

  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reports.' });
  }
});

module.exports = router;
