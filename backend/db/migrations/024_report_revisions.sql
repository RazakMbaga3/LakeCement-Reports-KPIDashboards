-- 024: append-only revision log for daily_reports — every PRE-IMAGE of a
-- report that was ever reported, and who changed it into what.
--
-- Until now a daily report's history was a one-line summary in audit_log
-- ("12 field(s), merged → status approved", routes/reports.js). That tells
-- you a change happened; it cannot tell you WHAT the report said before it.
-- Re-POSTing an approved day merges new values straight over the old JSONB
-- and the previous figures are gone from the database entirely — there is no
-- table, no column and no backup granularity that can answer "what number
-- did this report carry when the MIS pack quoted it on Tuesday". For a
-- record that feeds KPIs, the monthly MIS pack and an HOD's signature, that
-- is the difference between an audit trail and an assertion.
--
-- WHY A FULL SNAPSHOT AND NOT A DIFF CHAIN
--
-- The obvious cheaper design is to store only the delta per revision and
-- replay the chain to reconstruct any point in time. Three reasons this
-- stores the whole prior `data` JSONB instead:
--
--   1. One row answers the question. "What did 14 Sept's CPP report say at
--      14:32?" is a single SELECT on (form_type, record_date, shift), not a
--      replay of every link since the row was created. The people who ask
--      that question are auditors and HODs, not programmers.
--   2. A diff chain is only as trustworthy as its weakest writer. This table
--      is not the only thing that writes daily_reports — the Odoo autofill
--      (services/odooProductionAutofill.js) goes straight to the table by
--      design, the seed migrations wrote rows directly, and psql exists. Any
--      writer that skips a link silently corrupts every reconstruction AFTER
--      it in a chain, whereas it costs a snapshot log exactly one missing
--      row and nothing else.
--   3. Reversibility is one UPDATE. Restoring a mangled day is
--      "UPDATE daily_reports SET data = (SELECT prior_data FROM
--      report_revisions WHERE …)". No replay code to write, test and trust
--      under pressure, at the exact moment somebody is panicking about a
--      number.
--
-- The cost this buys is trivial: 11 form types x ~365 days, plus corrections,
-- is on the order of 11k rows a year, each a JSONB the same size as one
-- report — a few MB annually against a table we already keep forever. And
-- draft-over-draft saves are deliberately NOT snapshotted at all
-- (services/reportRevisions.js shouldSnapshot()), so pressing Save Draft
-- twenty times writes one revision, not twenty.
--
-- Rows are permanent and append-only, like production_odoo_overrides (019)
-- and kpi_overrides (002): there is no "cleared" state, because this is a log
-- of events that already happened, not a standing decision to undo.
CREATE TABLE IF NOT EXISTS report_revisions (
  id                 BIGSERIAL PRIMARY KEY,
  -- Which report this is a revision OF. Deliberately the natural key
  -- (form_type, record_date, shift) rather than daily_reports.id, so the
  -- history survives a row being deleted and recreated.
  form_type          VARCHAR(50)  NOT NULL,
  record_date        DATE         NOT NULL,
  shift              VARCHAR(10)  NOT NULL DEFAULT 'day',
  -- 1, 2, 3 … per report. Allocated under the row lock the writer already
  -- holds (SELECT … FOR UPDATE on daily_reports), so two concurrent submits
  -- cannot claim the same number; the UNIQUE below is the backstop.
  revision           INTEGER      NOT NULL,
  action             VARCHAR(30)  NOT NULL CHECK (action IN (
                       'FORM_SUBMIT',            -- an officer/HOD submission
                       'FORM_DRAFT',             -- an explicit Save Draft (never an autosave)
                       'FORM_APPROVE',           -- HOD signed it off
                       'FORM_REJECT',            -- HOD sent it back
                       'AMENDMENT_GRANT',        -- a correction window was opened (WS-A2)
                       'AMENDMENT_EXPIRE_REVERT',-- that window closed unused and the row reverted (WS-A2)
                       'FORM_AMEND_DIRECT',      -- admin/md break-glass edit of a locked report
                       'ODOO_AUTOFILL'           -- the robot corrected a value (bypasses the route)
                     )),
  -- The PRE-IMAGE: what the report held immediately BEFORE this action.
  -- NULL is meaningful and not "unknown": either the report did not exist
  -- yet (revision 1 of a brand-new day), or the action does not touch `data`
  -- at all (approve/reject only move the status columns).
  prior_data         JSONB,
  prior_status       VARCHAR(20),
  prior_approved_by  INTEGER      REFERENCES users(id),
  prior_approved_at  TIMESTAMP,
  -- Which keys of `data` this action added, removed or altered. Redundant
  -- against prior_data by construction, and stored anyway: it is what a
  -- human scanning a history list actually reads, and it keeps "show me
  -- every day somebody changed kiln_prod_mt" a cheap array query instead of
  -- a JSONB comparison across every revision ever written.
  changed_fields     TEXT[]       NOT NULL DEFAULT '{}',
  -- The correction window (WS-A2) this change was made under, if any.
  -- Intentionally WITHOUT a foreign key: report_amendments does not exist
  -- yet. Migration 025 creates that table and adds the FK, in that order —
  -- an FK here now would make this migration unappliable.
  amendment_id       INTEGER,
  -- Who. NULL actor_id means no human: the Odoo sync, a cron, a migration.
  -- actor_name is denormalised on purpose so the trail still reads
  -- correctly after a user is renamed or deleted (same reason audit_log
  -- keeps `username` alongside `user_id`).
  actor_id           INTEGER      REFERENCES users(id),
  actor_name         VARCHAR(100),
  -- Why: the rejection reason, or the admin's mandatory amendReason.
  reason             TEXT,
  ip_address         VARCHAR(45),
  created_at         TIMESTAMP    NOT NULL DEFAULT NOW(),
  -- One revision number per report. Also the uniqueness a concurrent
  -- submit would violate rather than silently duplicating a number.
  UNIQUE (form_type, record_date, shift, revision)
);

-- "The history of this one report, newest first" — the only lookup the UI
-- and the recovery path ever do.
CREATE INDEX IF NOT EXISTS idx_report_revisions_report
  ON report_revisions(form_type, record_date, shift, revision DESC);
-- "What changed across the whole plant this week" — the compliance read.
CREATE INDEX IF NOT EXISTS idx_report_revisions_created
  ON report_revisions(created_at DESC);

COMMENT ON TABLE report_revisions IS
  'APPEND-ONLY. Pre-image of a daily_reports row before each change, plus who/why. '
  'Never UPDATE or DELETE a row here: a correction is a NEW revision. '
  'prior_data NULL means either the report did not exist yet, or the action '
  'did not touch data (approve/reject). See db/migrations/024_report_revisions.sql.';
