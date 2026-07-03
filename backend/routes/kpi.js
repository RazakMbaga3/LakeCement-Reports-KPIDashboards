/*
  routes/kpi.js — Monthly KPI Targets & Actuals

  GET  /api/kpi/:dept/:year/:month        → get KPIs for a dept/month
  PUT  /api/kpi/:dept/:year/:month        → save KPI targets or actuals
  GET  /api/kpi/summary/:year/:month      → executive summary — all depts
  GET  /api/kpi/ytd/:dept/:year           → year-to-date aggregation
*/

const express = require('express');
const db      = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/kpi/summary/:year/:month ───────────────────────
// Executive summary — all departments, one month
router.get('/summary/:year/:month', requireAuth, async (req, res) => {
  try {
    const { year, month } = req.params;
    const result = await db.query(
      `SELECT department, kpi_key, target, actual, unit
       FROM kpi_monthly
       WHERE year = $1 AND month = $2
       ORDER BY department, kpi_key`,
      [year, month]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch KPI summary.' });
  }
});

// ── GET /api/kpi/ytd/:dept/:year ────────────────────────────
// Year-to-date: sum/avg actuals Jan → current month
router.get('/ytd/:dept/:year', requireAuth, async (req, res) => {
  try {
    const { dept, year } = req.params;
    const result = await db.query(
      `SELECT kpi_key, unit,
              SUM(target) AS ytd_target,
              SUM(actual) AS ytd_actual,
              COUNT(*) AS months_reported
       FROM kpi_monthly
       WHERE department = $1 AND year = $2
       GROUP BY kpi_key, unit
       ORDER BY kpi_key`,
      [dept, year]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch YTD data.' });
  }
});

// ── GET /api/kpi/:dept/:year/:month ─────────────────────────
router.get('/:dept/:year/:month', requireAuth, async (req, res) => {
  try {
    const { dept, year, month } = req.params;
    const result = await db.query(
      `SELECT * FROM kpi_monthly WHERE department=$1 AND year=$2 AND month=$3 ORDER BY kpi_key`,
      [dept, year, month]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch KPIs.' });
  }
});

// ── PUT /api/kpi/:dept/:year/:month ─────────────────────────
// Save KPI values — management/admin only (md is view-only)
// Body: [ { kpi_key, target, actual, unit }, ... ]
router.put('/:dept/:year/:month', requireAuth, requireRole('admin', 'management'), async (req, res) => {
  try {
    const { dept, year, month } = req.params;
    const kpis = req.body; // array of KPI rows

    if (!Array.isArray(kpis) || kpis.length === 0) {
      return res.status(400).json({ error: 'KPI data must be a non-empty array.' });
    }

    // Upsert each KPI row
    for (const kpi of kpis) {
      await db.query(`
        INSERT INTO kpi_monthly (department, year, month, kpi_key, target, actual, unit, updated_by, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (department, year, month, kpi_key)
        DO UPDATE SET target=EXCLUDED.target, actual=EXCLUDED.actual, unit=EXCLUDED.unit,
                      updated_by=$8, updated_at=NOW()
      `, [dept, year, month, kpi.kpi_key, kpi.target ?? null, kpi.actual ?? null, kpi.unit ?? '', req.user.id]);
    }

    await db.query(
      'INSERT INTO audit_log (user_id, username, action, form_type, ip_address) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, req.user.username, 'KPI_UPDATE', `${dept}/${year}/${month}`, req.ip]
    );

    res.json({ success: true, updated: kpis.length });

  } catch (err) {
    console.error('KPI save error:', err);
    res.status(500).json({ error: 'Failed to save KPIs.' });
  }
});

module.exports = router;
