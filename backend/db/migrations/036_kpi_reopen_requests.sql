-- 036: a way for a department HOD to ask for a submitted KPI month back.
--
-- Migration 013 locks a department-month's kpi_monthly figures the moment its
-- HOD submits them, and only an admin or the MD may reopen it. That is the
-- right rule — the figures management read must not change underneath them
-- without someone else agreeing — but it shipped with no way to ASK. The HOD
-- who found a wrong figure in a submitted month saw "locked" and nothing else,
-- and the reopen itself existed only as an API call no screen made. So a
-- mistake in a submitted month could not be corrected by anyone without a
-- developer. This is the same gap migration 027 closed for daily reports, and
-- the same shape of answer: a request with a reason, decided by someone other
-- than the person asking.
--
-- WHAT IS DIFFERENT FROM 027, deliberately:
--   • No time-boxed window. A reopened month is already a first-class state in
--     kpi_submissions ('reopened': editable until the HOD submits it again),
--     and the HOD re-submitting is what closes it. A second clock beside that
--     state would be two answers to one question.
--   • Only admin/md decide. That is 013's existing rule for reopening, not a
--     new one; the department's own HOD is the requester by construction.
--
-- THE SNAPSHOT. kpi_monthly has no revision log — a reopened month's figures
-- are simply overwritten by the next save. So the month's rows are copied into
-- `snapshot` at the moment it is reopened (by request or directly), and the
-- figures management had read can always be recovered afterwards.
--
-- Names are stored beside the ids and the FKs are ON DELETE SET NULL, for the
-- reason 025 and 027 give: an audit trail exists to outlive the people in it.

CREATE TABLE IF NOT EXISTS kpi_reopen_requests (
  id                SERIAL       PRIMARY KEY,
  department        VARCHAR(50)  NOT NULL,
  year              SMALLINT     NOT NULL,
  month             SMALLINT     NOT NULL CHECK (month BETWEEN 1 AND 12),

  -- requested → granted | declined | withdrawn.  A direct reopen by admin/md
  -- with no request behind it is recorded as a row born 'granted'.
  status            VARCHAR(20)  NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','granted','declined','withdrawn')),

  reason            TEXT         NOT NULL,           -- >= 10 chars at the route
  requested_by      INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  requested_by_name VARCHAR(100),
  requested_at      TIMESTAMP    NOT NULL DEFAULT NOW(),

  decided_by        INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  decided_by_name   VARCHAR(100),
  decided_at        TIMESTAMP,
  decision_note     TEXT,                            -- mandatory on decline

  -- The month's kpi_monthly rows as they stood when it was reopened:
  -- [{kpi_key, target, actual, unit, remarks}, ...]. NULL until granted.
  snapshot          JSONB
);

-- One undecided request per department-month: two people noticing the same
-- wrong figure must not file two requests for one decision.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kpi_reopen_requests_open
  ON kpi_reopen_requests (department, year, month) WHERE status = 'requested';

CREATE INDEX IF NOT EXISTS idx_kpi_reopen_requests_period
  ON kpi_reopen_requests (department, year, month);
CREATE INDEX IF NOT EXISTS idx_kpi_reopen_requests_status
  ON kpi_reopen_requests (status, requested_at);

COMMENT ON TABLE kpi_reopen_requests IS
  'Requests to reopen a submitted (locked) KPI department-month, and every reopen with the figures it superseded — see migrations/036_kpi_reopen_requests.sql.';
