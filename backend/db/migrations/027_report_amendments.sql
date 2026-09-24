-- 027: correction requests for daily reports that have already been reported.
--
-- Migration 024/025 made a reported report (approved, or sitting in an HOD's
-- queue) impossible to overwrite silently: a submit or a Save Draft over it
-- now returns 409 REPORT_LOCKED. That closed a real hole, but it left a person
-- who spots their own typo with nowhere to go except "ask an HOD to do it for
-- me" — and the only path an HOD had was the written-reason break-glass, which
-- no screen offers. This table is the way through that does not need a
-- developer: a request, a decision by someone other than the requester, and a
-- time-boxed window in which the author may correct and resubmit.
--
-- THE LOAD-BEARING CHOICE: A GRANT DOES NOT CHANGE daily_reports.status.
--
-- The obvious design is a new status ('amending'). It has no good branch:
--   • put it in REPORTED_STATUSES and every downstream claim of "approved"
--     becomes untrue, across fifteen call sites;
--   • leave it out and the day vanishes from every KPI, the MIS pack, entry
--     completeness and the watchdog the instant somebody asks a question about
--     one figure — and the watchdog would fire a false missed-entry alert for a
--     day that was filed on time.
-- config/forms.js already records the judgement for pending_approval: it counts
-- BECAUSE excluding it "would blank today's dashboard until the HOD gets to it,
-- which is worse than showing it". The same judgement, applied consistently,
-- says an open correction must not blank the day either.
--
-- So "approved, and one person has been granted a window to correct it" is two
-- facts and is stored as two facts: the report keeps its status, and a row in
-- this table says who may write to it until when. REPORTED_STATUSES is
-- untouched.
--
-- WHAT THE WINDOW TRADES AWAY, honestly: while it is open, autosave and saves
-- land in place on a row that is still 'approved', so partly-corrected figures
-- are briefly visible on dashboards. That is bounded three ways: expires_at
-- (default 24 h, at most 72); the sweeper restores the grant-time snapshot if
-- nothing was resubmitted, so a half-typed correction can never become the
-- record; and the amendment is returned with the day so surfaces can badge it.
-- The alternative — a shadow copy of the proposed figures, live row untouched
-- until applied — is safer and roughly triples the client work.
--
-- Same vocabulary and same "one open at a time" partial unique index as
-- kpi_submissions (013) and kpi_overrides (002).
--
-- NAMES ARE STORED BESIDE THE IDS, and the FKs are ON DELETE SET NULL. 024 was
-- first written with plain REFERENCES users(id) and turned out to block
-- deleting any user who had ever touched a report (fixed in 025); an audit
-- trail exists to outlive the people in it, so the mistake is not repeated here.

CREATE TABLE IF NOT EXISTS report_amendments (
  id                   SERIAL       PRIMARY KEY,
  form_type            VARCHAR(50)  NOT NULL,
  record_date          DATE         NOT NULL,
  shift                VARCHAR(10)  NOT NULL DEFAULT 'day',

  -- requested → granted → applied | expired ;  requested → declined | withdrawn
  status               VARCHAR(20)  NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','granted','applied','declined','withdrawn','expired')),

  -- Why the figures are wrong. NOT NULL, and >= 10 chars at the route: "fix"
  -- is not a reason, and this is what an approver reads to decide.
  reason               TEXT         NOT NULL,
  fields_flagged       TEXT[]       NOT NULL DEFAULT '{}',   -- what the requester says is wrong (optional)

  requested_by         INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  requested_by_name    VARCHAR(100),
  requested_at         TIMESTAMP    NOT NULL DEFAULT NOW(),
  locked_status        VARCHAR(20),                          -- daily_reports.status when it was asked for

  decided_by           INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  decided_by_name      VARCHAR(100),
  decided_at           TIMESTAMP,
  decision_note        TEXT,                                 -- mandatory on decline

  -- The restore point. A granted window snapshots the report's data into
  -- report_revisions (action AMENDMENT_GRANT) BEFORE anyone can edit, and the
  -- sweeper reverts to it if the window closes unused.
  baseline_revision_id BIGINT       REFERENCES report_revisions(id) ON DELETE SET NULL,
  expires_at           TIMESTAMP,
  applied_at           TIMESTAMP,
  applied_revision_id  BIGINT       REFERENCES report_revisions(id) ON DELETE SET NULL
);

-- At most ONE open amendment per report-day-shift. Two people noticing the same
-- typo at once must not open two windows; the loser is handed the existing one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_report_amendments_open
  ON report_amendments (form_type, record_date, shift)
  WHERE status IN ('requested','granted');

-- The queue read and the sweeper's scan: "what is open, anywhere". Partial, so
-- it stays tiny however many closed amendments accumulate.
CREATE INDEX IF NOT EXISTS idx_report_amendments_open
  ON report_amendments (status, requested_at)
  WHERE status IN ('requested','granted');

CREATE INDEX IF NOT EXISTS idx_report_amendments_day
  ON report_amendments (form_type, record_date, shift);

CREATE INDEX IF NOT EXISTS idx_report_amendments_requester
  ON report_amendments (requested_by, requested_at DESC);

-- 024 left report_revisions.amendment_id as a bare integer because this table
-- did not exist yet. SET NULL, like everything else here: deleting an amendment
-- must never take a revision (the audit trail) with it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_revisions_amendment_fk') THEN
    ALTER TABLE report_revisions
      ADD CONSTRAINT report_revisions_amendment_fk
      FOREIGN KEY (amendment_id) REFERENCES report_amendments(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON TABLE report_amendments IS
  'A correction request against a report that has already been reported. status=granted opens a time-boxed write window enforced in routes/reports.js; daily_reports.status is NOT changed, so the day keeps counting in every KPI while it is open.';
