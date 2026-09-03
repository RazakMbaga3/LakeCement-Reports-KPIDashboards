-- 013: locks a department's monthly KPIs once its HOD submits them.
--
-- Until now kpi_monthly had no notion of "finished". An HOD could keep
-- editing a month's targets and actuals indefinitely, including after
-- management had read and acted on them, and nothing recorded that the
-- figures had ever been declared final. That is the same gap the daily
-- reports closed with report_approvals (migration 010) — this is its
-- monthly counterpart.
--
-- GRANULARITY: the lock is on the PERIOD (department, year, month), not on
-- individual kpi_monthly rows. A monthly submission is one act covering
-- every KPI for that department-month, and a row-level flag would leave a
-- newly-added kpi_key silently writable inside an already-submitted month.
--
-- REOPENING is deliberately a state, not a delete: 'reopened' keeps the
-- original submitted_by/submitted_at intact next to who reopened it and
-- why, so the audit trail shows a month was closed, reopened and closed
-- again rather than appearing never to have been submitted at all.

CREATE TABLE IF NOT EXISTS kpi_submissions (
  id            SERIAL PRIMARY KEY,
  department    VARCHAR(50) NOT NULL,
  year          SMALLINT    NOT NULL,
  month         SMALLINT    NOT NULL CHECK (month BETWEEN 1 AND 12),
  -- 'submitted' = locked for editing. 'reopened' = an admin/MD deliberately
  -- unlocked it; edits are allowed again until it is submitted afresh.
  status        VARCHAR(20) NOT NULL DEFAULT 'submitted'
                  CHECK (status IN ('submitted', 'reopened')),
  submitted_by  INTEGER     REFERENCES users(id),
  submitted_at  TIMESTAMP   NOT NULL DEFAULT NOW(),
  reopened_by   INTEGER     REFERENCES users(id),
  reopened_at   TIMESTAMP,
  reopen_reason TEXT,
  UNIQUE (department, year, month)
);

CREATE INDEX IF NOT EXISTS idx_kpi_submissions_period
  ON kpi_submissions (department, year, month);

COMMENT ON TABLE kpi_submissions IS
  'One row per department-month that has been submitted. Presence with status=submitted locks kpi_monthly writes for that period — see backend/middleware/kpiAccess.js requireKpiPeriodOpen.';
