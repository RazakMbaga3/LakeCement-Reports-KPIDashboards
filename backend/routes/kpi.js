/*
  routes/kpi.js — Monthly KPI Targets & Actuals

  GET  /api/kpi/summary/:year/:month      → executive summary — all depts
  GET  /api/kpi/ytd/:dept/:year           → year-to-date aggregation
  GET  /api/kpi/fiscal/:dept/:fyStartYear → whole fiscal year (Apr→Mar), one dept
  GET  /api/kpi/range/:dept?from=&to=     → an arbitrary run of months, one dept
  GET  /api/kpi/:dept/:year/:month        → get KPIs for a dept/month
  PUT  /api/kpi/:dept/:year/:month        → save KPI targets or actuals

  Monthly submission lock, and the way back through it (migration 036):
  GET  /api/kpi/submissions/:dept?from=YYYY-MM&to=YYYY-MM   → each month's lock state
  GET  /api/kpi/reopen-requests?state=open|all              → reopen requests I made / decide
  POST /api/kpi/:dept/:year/:month/submit                   → HOD declares the month final
  POST /api/kpi/:dept/:year/:month/reopen-request           → HOD asks for it back
  POST /api/kpi/:dept/:year/:month/reopen-request/:id/withdraw
  POST /api/kpi/:dept/:year/:month/reopen-request/:id/decline   (admin/md)
  POST /api/kpi/:dept/:year/:month/reopen                   → admin/md reopens (grants)

  Every request is validated (middleware/validate.js) before it touches SQL;
  handlers read the parsed (coerced-to-number) values from req.validated.

  Lake Cement's business year runs April → March, not calendar Jan-Dec (see
  app.js's calMonthToFiscalPos/fiscalPosToCalYear on the frontend for the
  full convention). /fiscal is registered ahead of the generic
  /:dept/:year/:month route below — Express matches routes top-to-bottom,
  and both have a 3-segment shape after /api/kpi, so if the generic route
  came first it would swallow /fiscal/X/Y requests (dept='fiscal',
  year='X', which fails zYear validation) before this handler ever runs.
*/

const express = require('express');
const db      = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireKpiDeptAccess, requireKpiPeriodOpen } = require('../middleware/kpiAccess');
const { validate, z, zNumeric } = require('../middleware/validate');
const { KPI_DEPTS, ROLE_KPI_EDIT_DEPTS } = require('../config/kpiAccess');

const router = express.Router();

const zYear  = z.coerce.number().int().min(2000).max(2100);
const zMonth = z.coerce.number().int().min(1).max(12);
/* A real department key, not just a plausible-looking string. The loose
   /^[a-z0-9_-]+$/ this used to be let a typo (or a stale client) create
   kpi_monthly rows under a department no page renders — invisible data that
   nothing ever reports. KPI_DEPTS is shared with the frontend via
   forms/access-registry.js. Reads stay permissive-by-shape and simply return
   [] for an unknown dept; only writes are constrained. */
const zDept     = z.string().regex(/^[a-z0-9_-]+$/i, 'must be a department key').max(50);
const zRealDept = z.enum(KPI_DEPTS);

const yearMonthParams     = z.object({ year: zYear, month: zMonth });
const deptYearParams      = z.object({ dept: zDept, year: zYear });
const deptYearMonthParams = z.object({ dept: zDept, year: zYear, month: zMonth });

// ── GET /api/kpi/summary/:year/:month ───────────────────────
// Executive summary — all departments, one month
router.get('/summary/:year/:month',
  requireAuth, validate(yearMonthParams, 'params'),
  async (req, res, next) => {
    try {
      const { year, month } = req.validated.params;
      const result = await db.query(
        `SELECT department, kpi_key, target, actual, unit, remarks
         FROM kpi_monthly
         WHERE year = $1 AND month = $2
         ORDER BY department, kpi_key`,
        [year, month]
      );
      res.json(result.rows);
    } catch (err) { next(err); }
  });

// ── GET /api/kpi/ytd/:dept/:year ────────────────────────────
// Year-to-date: sum/avg actuals Jan → current month. NOT currently called
// by the dashboard (the live YTD view is client-side column show/hide
// against /fiscal's data, see app.js) and NOT fiscal-year-aware — plain
// calendar-year aggregation. Fix this if it ever gets a real caller.
router.get('/ytd/:dept/:year',
  requireAuth, validate(deptYearParams, 'params'),
  async (req, res, next) => {
    try {
      const { dept, year } = req.validated.params;
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
    } catch (err) { next(err); }
  });

// ── GET /api/kpi/fiscal/:dept/:fyStartYear ──────────────────
// Whole fiscal year in one call (Apr fyStartYear → Mar fyStartYear+1) —
// powers the dashboard's 12-column month tracker without one request per
// month, and without the client having to know which two calendar years
// a fiscal year straddles.
const deptFyParams = z.object({ dept: zDept, fyStartYear: zYear });
router.get('/fiscal/:dept/:fyStartYear',
  requireAuth, validate(deptFyParams, 'params'),
  async (req, res, next) => {
    try {
      const { dept, fyStartYear } = req.validated.params;
      const result = await db.query(
        `SELECT year, month, kpi_key, target, actual, unit, remarks
         FROM kpi_monthly
         WHERE department = $1
           AND ( (year = $2     AND month BETWEEN 4 AND 12)
              OR (year = $2 + 1 AND month BETWEEN 1 AND 3) )
         ORDER BY kpi_key, year, month`,
        [dept, fyStartYear]
      );
      res.json(result.rows);
    } catch (err) { next(err); }
  });

// ── GET /api/kpi/range/:dept?from=YYYY-MM&to=YYYY-MM ────────
// An arbitrary run of months for one department, in order.
//
// /fiscal answers "one Apr→Mar year", which is the right shape for the
// dashboard's 12-column tracker but the wrong one for looking at a stretch
// of history: Jan–Jun 2026 straddles two fiscal years, so it takes two calls
// and still cannot be laid out as consecutive columns. This backs the
// "Last 12 Months" view, where the columns are a rolling window ending at
// the selected month and crossing the April boundary freely.
//
// Registered ahead of the generic /:dept/:year/:month for the same reason
// /fiscal is — Express matches top-to-bottom and both are 3 segments deep.
const zPeriod = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM');
const rangeQuery = z.object({ from: zPeriod, to: zPeriod });

router.get('/range/:dept',
  requireAuth,
  validate(z.object({ dept: zDept }), 'params'),
  validate(rangeQuery, 'query'),
  async (req, res, next) => {
    try {
      const { dept } = req.validated.params;
      const { from, to } = req.validated.query;
      const n = p => Number(p.slice(0, 4)) * 100 + Number(p.slice(5, 7));
      const [lo, hi] = [n(from), n(to)].sort((a, b) => a - b);
      const result = await db.query(
        `SELECT year, month, kpi_key, target, actual, unit, remarks
         FROM kpi_monthly
         WHERE department = $1 AND (year * 100 + month) BETWEEN $2 AND $3
         ORDER BY kpi_key, year, month`,
        [dept, lo, hi]
      );
      res.json(result.rows);
    } catch (err) { next(err); }
  });

/* ══════════════════════════════════════════════════════════════════════
   REOPEN REQUESTS — reads. Registered ahead of the generic
   /:dept/:year/:month for the reason /fiscal and /range give.
══════════════════════════════════════════════════════════════════════ */

const isPrivileged = u => u.role === 'admin' || u.role === 'md';
const actorName = req => req.user.name || req.user.username;
/* Departments whose KPI months this user may file — and so ask to reopen. */
function editableDepts(user) {
  const allowed = ROLE_KPI_EDIT_DEPTS[user.role] || [];
  if (allowed === 'all') return KPI_DEPTS.slice();
  return user.level === 'hod' || user.role === 'admin' ? allowed : [];
}

const REQUEST_COLUMNS = `
  q.id, q.department, q.year, q.month, q.status, q.reason,
  q.requested_by, q.requested_by_name, q.requested_at,
  q.decided_by_name, q.decided_at, q.decision_note`;

/* GET /api/kpi/submissions/:dept?from=YYYY-MM&to=YYYY-MM
   Every month in the range that has figures or a lock, with its lock state
   and any open reopen request — the month picker on corrections.html. */
router.get('/submissions/:dept',
  requireAuth, validate(z.object({ dept: zRealDept }), 'params'), validate(rangeQuery, 'query'),
  async (req, res, next) => {
    try {
      const { dept } = req.validated.params;
      const { from, to } = req.validated.query;
      if (!isPrivileged(req.user) && !editableDepts(req.user).includes(dept)) {
        return res.status(403).json({ error: `Role '${req.user.role}' does not file KPIs for '${dept}'.` });
      }
      const n = p => Number(p.slice(0, 4)) * 100 + Number(p.slice(5, 7));
      const [lo, hi] = [n(from), n(to)].sort((a, b) => a - b);

      const { rows } = await db.query(`
        WITH months AS (
          SELECT year, month, COUNT(*)::int AS kpi_rows,
                 COUNT(actual)::int AS actuals
            FROM kpi_monthly
           WHERE department = $1 AND (year * 100 + month) BETWEEN $2 AND $3
           GROUP BY year, month
          UNION
          SELECT year, month, 0, 0 FROM kpi_submissions
           WHERE department = $1 AND (year * 100 + month) BETWEEN $2 AND $3
        )
        SELECT m.year, m.month, MAX(m.kpi_rows) AS kpi_rows, MAX(m.actuals) AS actuals,
               COALESCE(s.status, 'open') AS status,
               s.submitted_at, su.full_name AS submitted_by_name,
               s.reopened_at, ru.full_name AS reopened_by_name, s.reopen_reason,
               (SELECT row_to_json(x) FROM (
                  SELECT ${REQUEST_COLUMNS} FROM kpi_reopen_requests q
                   WHERE q.department = $1 AND q.year = m.year AND q.month = m.month
                   ORDER BY q.id DESC LIMIT 1) x) AS last_request
          FROM months m
          LEFT JOIN kpi_submissions s
            ON s.department = $1 AND s.year = m.year AND s.month = m.month
          LEFT JOIN users su ON su.id = s.submitted_by
          LEFT JOIN users ru ON ru.id = s.reopened_by
         GROUP BY m.year, m.month, s.status, s.submitted_at, su.full_name,
                  s.reopened_at, ru.full_name, s.reopen_reason
         ORDER BY m.year DESC, m.month DESC`, [dept, lo, hi]);
      res.json(rows);
    } catch (err) { next(err); }
  });

/* GET /api/kpi/reopen-requests?state=open|all&days=N
   admin/md: every request (they decide them). An HOD: requests on the
   departments they file. Anyone else: nothing to see. */
router.get('/reopen-requests',
  requireAuth,
  validate(z.object({
    state: z.enum(['open', 'all']).default('open'),
    days:  z.coerce.number().int().min(1).max(365).default(30),
  }), 'query'),
  async (req, res, next) => {
    try {
      const { state, days } = req.validated.query;
      const params = [];
      const where = [];
      if (!isPrivileged(req.user)) {
        const depts = editableDepts(req.user);
        if (!depts.length) return res.json([]);
        params.push(depts);
        where.push(`q.department = ANY($${params.length})`);
      }
      if (state === 'open') {
        where.push(`q.status = 'requested'`);
      } else {
        params.push(days);
        where.push(`(q.status = 'requested' OR q.requested_at >= NOW() - ($${params.length}::int * INTERVAL '1 day'))`);
      }
      const { rows } = await db.query(`
        SELECT ${REQUEST_COLUMNS},
               (SELECT COUNT(*)::int FROM kpi_monthly k
                 WHERE k.department = q.department AND k.year = q.year AND k.month = q.month) AS kpi_rows
          FROM kpi_reopen_requests q
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY (q.status = 'requested') DESC, q.requested_at DESC
         LIMIT 200`, params);
      res.json(rows);
    } catch (err) { next(err); }
  });

// ── GET /api/kpi/:dept/:year/:month ─────────────────────────
router.get('/:dept/:year/:month',
  requireAuth, validate(deptYearMonthParams, 'params'),
  async (req, res, next) => {
    try {
      const { dept, year, month } = req.validated.params;
      const result = await db.query(
        `SELECT * FROM kpi_monthly WHERE department=$1 AND year=$2 AND month=$3 ORDER BY kpi_key`,
        [dept, year, month]
      );
      res.json(result.rows);
    } catch (err) { next(err); }
  });

// ── PUT /api/kpi/:dept/:year/:month ─────────────────────────
// Save KPI values — dept-aware: admin/management edit any dept, each
// department HOD only their own (see config/kpiAccess.js). md is view-only.
// Body: [ { kpi_key, target?, actual?, unit?, remarks?, clear? }, ... ]
//
// `clear` is how a field is REMOVED. Every other field COALESCEs onto the
// stored row so a remarks-only save doesn't wipe the actual (and vice versa)
// — which also meant a wrong figure could never be taken back out: omitting
// `actual` kept it, and sending null kept it too. Listing a field name in
// `clear` sets that column to NULL explicitly.
const kpiRowsBody = z.array(z.object({
  kpi_key: z.string().trim().min(1).max(100),
  target:  zNumeric.optional(),
  actual:  zNumeric.optional(),
  unit:    z.string().max(20).optional().default(''),
  remarks: z.string().max(2000).optional(),
  clear:   z.array(z.enum(['target', 'actual', 'remarks'])).max(3).optional(),
})).min(1, 'KPI data must be a non-empty array').max(500);

const deptYearMonthWrite = z.object({ dept: zRealDept, year: zYear, month: zMonth });

router.put('/:dept/:year/:month',
  requireAuth, requireKpiDeptAccess, requireKpiPeriodOpen,
  validate(deptYearMonthWrite, 'params'), validate(kpiRowsBody, 'body'),
  async (req, res, next) => {
    try {
      const { dept, year, month } = req.validated.params;
      const kpis = req.validated.body;

      /* One transaction for the whole save AND its audit row. Previously each
         upsert was its own statement with the audit insert separate, so a
         failure part-way through left some KPIs written, some not, and no
         record that anything had been attempted. withTransaction() is the
         same helper routes/reports.js already uses for form submissions. */
      const touched = await db.withTransaction(async (client) => {
        const rows = [];
        for (const kpi of kpis) {
          const clear = new Set(kpi.clear || []);
          const result = await client.query(`
            INSERT INTO kpi_monthly (department, year, month, kpi_key, target, actual, unit, remarks, updated_by, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            ON CONFLICT (department, year, month, kpi_key)
            DO UPDATE SET
              target  = CASE WHEN $10 THEN NULL ELSE COALESCE(EXCLUDED.target,  kpi_monthly.target)  END,
              actual  = CASE WHEN $11 THEN NULL ELSE COALESCE(EXCLUDED.actual,  kpi_monthly.actual)  END,
              remarks = CASE WHEN $12 THEN NULL ELSE COALESCE(EXCLUDED.remarks, kpi_monthly.remarks) END,
              unit    = CASE WHEN EXCLUDED.unit = '' THEN kpi_monthly.unit ELSE EXCLUDED.unit END,
              updated_by = $9, updated_at = NOW()
            RETURNING kpi_key, target, actual, remarks
          `, [
            dept, year, month, kpi.kpi_key,
            clear.has('target') ? null : (kpi.target ?? null),
            clear.has('actual') ? null : (kpi.actual ?? null),
            kpi.unit ?? '',
            clear.has('remarks') ? null : (kpi.remarks ?? null),
            req.user.id,
            clear.has('target'), clear.has('actual'), clear.has('remarks'),
          ]);
          rows.push(result.rows[0]);
        }

        /* Record WHAT changed, not just that something did. The override flow
           (routes/formula.js) has always logged a mandatory reason and the
           value it superseded; a KPI_UPDATE logged only "dept/year/month",
           leaving no way to answer "who changed this figure, and to what". */
        await client.query(
          `INSERT INTO audit_log (user_id, username, action, form_type, details, ip_address)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.user.id, req.user.username, 'KPI_UPDATE', `${dept}/${year}/${month}`,
            rows.map(r => {
              const bits = [];
              if (r.actual  !== null) bits.push('actual=' + r.actual);
              if (r.target  !== null) bits.push('target=' + r.target);
              if (r.remarks !== null) bits.push('remarks="' + String(r.remarks).slice(0, 80) + '"');
              return r.kpi_key + ' -> ' + (bits.length ? bits.join(', ') : 'cleared');
            }).join('; ').slice(0, 4000),
            req.ip]
        );

        return rows;
      });

      res.json({ success: true, updated: touched.length });
    } catch (err) { next(err); }
  });

/* ══════════════════════════════════════════════════════════════════════
   MONTHLY SUBMISSION — an HOD declaring a department-month final.
   Submitting locks kpi_monthly writes for that period (see
   requireKpiPeriodOpen); only admin/MD can reopen it, and only with a
   reason. Read the state first so a client can show the right button.
══════════════════════════════════════════════════════════════════════ */

// Who submitted this department-month, if anyone, and is it locked now?
router.get('/:dept/:year/:month/submission',
  requireAuth, validate(deptYearMonthParams, 'params'),
  async (req, res, next) => {
    try {
      const { dept, year, month } = req.validated.params;
      const { rows } = await db.query(
        `SELECT s.status, s.submitted_at, s.reopened_at, s.reopen_reason,
                su.full_name AS submitted_by, ru.full_name AS reopened_by
           FROM kpi_submissions s
           LEFT JOIN users su ON su.id = s.submitted_by
           LEFT JOIN users ru ON ru.id = s.reopened_by
          WHERE s.department = $1 AND s.year = $2 AND s.month = $3`,
        [dept, year, month]);
      /* The open reopen request, if any, and the last decided one if recent —
         so the KPI page can say "reopen requested, waiting" or "your request
         was declined: <why>" instead of offering the button again blind. */
      const reqs = await db.query(`
        SELECT ${REQUEST_COLUMNS} FROM kpi_reopen_requests q
         WHERE q.department = $1 AND q.year = $2 AND q.month = $3
           AND (q.status = 'requested' OR q.decided_at > NOW() - INTERVAL '14 days')
         ORDER BY q.id DESC LIMIT 1`, [dept, year, month]);
      const last = reqs.rows[0] || null;
      // No row at all is a normal, open period — not a 404.
      res.json(Object.assign(
        rows[0] || { status: 'open', submitted_at: null, submitted_by: null },
        { reopen_request: last && last.status === 'requested' ? last : null,
          last_reopen_request: last && last.status !== 'requested' ? last : null }));
    } catch (err) { next(err); }
  });

/* Submit. requireKpiDeptAccess enforces that this is the owning
   department's L1/HOD (or admin); requireKpiPeriodOpen makes a second
   submit of an already-locked month a 409 rather than a silent no-op. */
router.post('/:dept/:year/:month/submit',
  requireAuth, requireKpiDeptAccess, requireKpiPeriodOpen,
  validate(deptYearMonthWrite, 'params'),
  async (req, res, next) => {
    try {
      const { dept, year, month } = req.validated.params;

      const result = await db.withTransaction(async (client) => {
        /* Refuse to "submit" a month with nothing in it — an empty
           submission would lock the period against the very edits needed
           to populate it, and would read downstream as a department
           reporting zero rather than as a department that never filed. */
        const { rows: [{ n }] } = await client.query(
          'SELECT COUNT(*)::int AS n FROM kpi_monthly WHERE department = $1 AND year = $2 AND month = $3',
          [dept, year, month]);
        if (n === 0) return { empty: true };

        const { rows } = await client.query(
          `INSERT INTO kpi_submissions (department, year, month, status, submitted_by, submitted_at)
           VALUES ($1, $2, $3, 'submitted', $4, NOW())
           ON CONFLICT (department, year, month) DO UPDATE SET
             status = 'submitted', submitted_by = $4, submitted_at = NOW(),
             reopened_by = NULL, reopened_at = NULL, reopen_reason = NULL
           RETURNING status, submitted_at`,
          [dept, year, month, req.user.id]);

        await client.query(
          `INSERT INTO audit_log (user_id, username, action, form_type, details, ip_address)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.user.id, req.user.username, 'KPI_SUBMIT', `${dept}/${year}/${month}`,
           `${n} KPI row(s) submitted and locked`, req.ip]);

        return { submission: rows[0], count: n };
      });

      if (result.empty) {
        return res.status(400).json({
          error: `There are no KPI values recorded for ${dept} ${year}-${String(month).padStart(2, '0')}. Fill the month before submitting it.`,
          code: 'EMPTY_PERIOD',
        });
      }
      res.json({ ok: true, ...result });
    } catch (err) { next(err); }
  });

/* Reopen REQUEST — the department's HOD asks for a submitted month back,
   with a reason an admin/MD reads to decide. The lock's rule is unchanged
   (only admin/MD reopen); what is new is that the HOD can ask from the
   screen instead of having to know whom to phone. requireKpiDeptAccess is
   the same gate as editing the month: whoever could file it may ask. */
const reasonBody = z.object({
  reason: z.string().trim().min(10, 'Say what is wrong in at least 10 characters').max(500),
});
const requestIdParams = deptYearMonthWrite.extend({ id: z.coerce.number().int().positive() });
const label = (dept, year, month) => `${dept} ${year}-${String(month).padStart(2, '0')}`;

router.post('/:dept/:year/:month/reopen-request',
  requireAuth, requireKpiDeptAccess,
  validate(deptYearMonthWrite, 'params'), validate(reasonBody, 'body'),
  async (req, res, next) => {
    try {
      const { dept, year, month } = req.validated.params;
      const { reason } = req.validated.body;
      if (isPrivileged(req.user)) {
        return res.status(409).json({
          error: 'You can reopen this month yourself — use "Reopen month" rather than asking.',
          code: 'REOPEN_DIRECTLY',
        });
      }

      const out = await db.withTransaction(async (client) => {
        const sub = await client.query(
          `SELECT status FROM kpi_submissions WHERE department = $1 AND year = $2 AND month = $3 FOR UPDATE`,
          [dept, year, month]);
        if (!sub.rows[0] || sub.rows[0].status !== 'submitted') return { notLocked: true };

        const ins = await client.query(`
          INSERT INTO kpi_reopen_requests (department, year, month, reason, requested_by, requested_by_name)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (department, year, month) WHERE status = 'requested' DO NOTHING
          RETURNING id`, [dept, year, month, reason, req.user.id, actorName(req)]);
        const existing = !ins.rows[0];

        if (!existing) {
          await client.query(
            `INSERT INTO audit_log (user_id, username, action, form_type, details, ip_address)
             VALUES ($1,$2,'KPI_REOPEN_REQUEST',$3,$4,$5)`,
            [req.user.id, req.user.username, `${dept}/${year}/${month}`, reason.slice(0, 4000), req.ip]);
        }
        const row = await client.query(
          `SELECT ${REQUEST_COLUMNS} FROM kpi_reopen_requests q
            WHERE q.department = $1 AND q.year = $2 AND q.month = $3 AND q.status = 'requested'`,
          [dept, year, month]);
        return { existing, request: row.rows[0] };
      });

      if (out.notLocked) {
        return res.status(409).json({
          error: `${label(dept, year, month)} is not submitted, so it is already open for editing.`,
          code: 'NOT_LOCKED',
        });
      }
      if (out.existing) {
        return res.status(409).json({
          error: 'A reopen request is already waiting for this month.',
          code: 'REQUEST_ALREADY_OPEN', request: out.request,
        });
      }
      res.status(201).json({ ok: true, request: out.request });
    } catch (err) { next(err); }
  });

/* Lock the request row and check it belongs to the month in the path. */
async function lockRequest(client, { id, dept, year, month }) {
  const { rows } = await client.query(
    'SELECT * FROM kpi_reopen_requests WHERE id = $1 FOR UPDATE', [id]);
  const r = rows[0];
  if (!r || r.department !== dept || r.year !== year || r.month !== month) return null;
  return r;
}

router.post('/:dept/:year/:month/reopen-request/:id/withdraw',
  requireAuth, validate(requestIdParams, 'params'),
  async (req, res, next) => {
    try {
      const { dept, year, month, id } = req.validated.params;
      const out = await db.withTransaction(async (client) => {
        const r = await lockRequest(client, { id, dept, year, month });
        if (!r) return { notFound: true };
        if (r.status !== 'requested') return { notPending: r.status };
        if (!isPrivileged(req.user) && r.requested_by !== req.user.id) return { forbidden: true };
        await client.query(`UPDATE kpi_reopen_requests SET status = 'withdrawn' WHERE id = $1`, [id]);
        await client.query(
          `INSERT INTO audit_log (user_id, username, action, form_type, details, ip_address)
           VALUES ($1,$2,'KPI_REOPEN_WITHDRAW',$3,$4,$5)`,
          [req.user.id, req.user.username, `${dept}/${year}/${month}`, `Reopen request #${id} withdrawn`, req.ip]);
        return { ok: true };
      });
      if (out.notFound) return res.status(404).json({ error: 'No such reopen request.', code: 'NOT_FOUND' });
      if (out.notPending) return res.status(409).json({ error: `That request is already ${out.notPending}.`, code: 'NOT_PENDING' });
      if (out.forbidden) return res.status(403).json({ error: 'Only the person who asked can withdraw a reopen request.', code: 'NOT_REQUESTER' });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

router.post('/:dept/:year/:month/reopen-request/:id/decline',
  requireAuth, requireRole('admin', 'md'),
  validate(requestIdParams, 'params'),
  validate(z.object({ note: z.string().trim().min(10, 'Say why in at least 10 characters').max(500) }), 'body'),
  async (req, res, next) => {
    try {
      const { dept, year, month, id } = req.validated.params;
      const { note } = req.validated.body;
      const out = await db.withTransaction(async (client) => {
        const r = await lockRequest(client, { id, dept, year, month });
        if (!r) return { notFound: true };
        if (r.status !== 'requested') return { notPending: r.status };
        await client.query(`
          UPDATE kpi_reopen_requests SET status = 'declined', decided_by = $2, decided_by_name = $3,
                 decided_at = NOW(), decision_note = $4
           WHERE id = $1`, [id, req.user.id, actorName(req), note]);
        await client.query(
          `INSERT INTO audit_log (user_id, username, action, form_type, details, ip_address)
           VALUES ($1,$2,'KPI_REOPEN_DECLINE',$3,$4,$5)`,
          [req.user.id, req.user.username, `${dept}/${year}/${month}`, `Reopen request #${id} declined — ${note}`, req.ip]);
        return { ok: true };
      });
      if (out.notFound) return res.status(404).json({ error: 'No such reopen request.', code: 'NOT_FOUND' });
      if (out.notPending) return res.status(409).json({ error: `That request is already ${out.notPending}.`, code: 'NOT_PENDING' });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

/* Reopen — admin/MD only, reason mandatory. Kept off the department's own
   HOD on purpose: letting the submitter unlock their own month would make
   the lock advisory, and the point of it is that the figures management
   read cannot change underneath them without someone else agreeing.

   A reopen is also how a reopen REQUEST is granted: the open request for the
   month, if there is one, is marked granted in the same transaction. Either
   way the month's figures as they stood are copied into kpi_reopen_requests
   .snapshot first — kpi_monthly keeps no history, so this is the only record
   of what management had read before the correction. */
const reopenBody = z.object({
  reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500),
});
router.post('/:dept/:year/:month/reopen',
  requireAuth, requireRole('admin', 'md'),
  validate(deptYearMonthWrite, 'params'), validate(reopenBody, 'body'),
  async (req, res, next) => {
    try {
      const { dept, year, month } = req.validated.params;
      const { reason } = req.validated.body;

      const result = await db.withTransaction(async (client) => {
        const { rows } = await client.query(
          `UPDATE kpi_submissions
              SET status = 'reopened', reopened_by = $4, reopened_at = NOW(), reopen_reason = $5
            WHERE department = $1 AND year = $2 AND month = $3 AND status = 'submitted'
            RETURNING status, reopened_at`,
          [dept, year, month, req.user.id, reason]);
        if (!rows.length) return null;

        const snap = await client.query(
          `SELECT kpi_key, target, actual, unit, remarks FROM kpi_monthly
            WHERE department = $1 AND year = $2 AND month = $3 ORDER BY kpi_key`,
          [dept, year, month]);
        const granted = await client.query(`
          UPDATE kpi_reopen_requests
             SET status = 'granted', decided_by = $4, decided_by_name = $5, decided_at = NOW(),
                 decision_note = $6, snapshot = $7::jsonb
           WHERE department = $1 AND year = $2 AND month = $3 AND status = 'requested'
           RETURNING id`,
          [dept, year, month, req.user.id, actorName(req), reason, JSON.stringify(snap.rows)]);
        let requestId = granted.rows[0] ? granted.rows[0].id : null;
        if (!requestId) {
          const born = await client.query(`
            INSERT INTO kpi_reopen_requests
              (department, year, month, status, reason, requested_by, requested_by_name,
               decided_by, decided_by_name, decided_at, decision_note, snapshot)
            VALUES ($1, $2, $3, 'granted', $4, $5, $6, $5, $6, NOW(), $4, $7::jsonb)
            RETURNING id`,
            [dept, year, month, reason, req.user.id, actorName(req), JSON.stringify(snap.rows)]);
          requestId = born.rows[0].id;
        }

        await client.query(
          `INSERT INTO audit_log (user_id, username, action, form_type, details, ip_address)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.user.id, req.user.username, 'KPI_REOPEN', `${dept}/${year}/${month}`,
           (`${reason}` + (granted.rows[0] ? ` (grants reopen request #${requestId})` : '')
             + ` — ${snap.rows.length} KPI row(s) snapshotted`).slice(0, 4000), req.ip]);

        return { ...rows[0], request_id: requestId, snapshot_rows: snap.rows.length };
      });

      if (!result) {
        return res.status(404).json({
          error: `${label(dept, year, month)} is not currently submitted, so there is nothing to reopen.`,
        });
      }
      res.json({ ok: true, ...result });
    } catch (err) { next(err); }
  });

module.exports = router;
