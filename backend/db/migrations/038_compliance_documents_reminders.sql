-- 038: Compliance Master — documents & versions, and the reminder outbox.
--
-- DOCUMENTS LIVE IN POSTGRES (bytea), deliberately not on disk:
--   • nginx's web root is the git checkout, and on 2026-10-12 it was found
--     serving whatever sat in it (RAID I-42) — a certificate store under the
--     checkout would have been public;
--   • the nightly pg_dump and the monthly restore drill already cover the
--     database, so the documents are backed up and restore-tested for free;
--   • a document row can never point at a file that is not there.
-- Volume is small (≈200 obligations × 1–2 certificates a year × ~0.5 MB).
-- Revisit if compliance_blobs passes ~2 GB or backup time doubles; the blob
-- table is separate so a later move to object storage stays local.
--
-- Blobs are keyed by content hash: one TBS certificate attached to the 24
-- calibrations it covers is stored once.
CREATE TABLE IF NOT EXISTS compliance_blobs (
  sha256      CHAR(64)     PRIMARY KEY,
  size_bytes  INTEGER      NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  bytes       BYTEA        NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
-- PDFs and JPEGs are already compressed; EXTERNAL skips a pointless second
-- compression and makes substring() chunk reads cheap for streaming.
ALTER TABLE compliance_blobs ALTER COLUMN bytes SET STORAGE EXTERNAL;

-- Every upload is a new version; nothing is ever overwritten or deleted.
-- A mistaken upload is retracted (kept, marked, reason recorded).
CREATE TABLE IF NOT EXISTS compliance_documents (
  id                 SERIAL        PRIMARY KEY,
  item_id            INTEGER       NOT NULL REFERENCES compliance_items(id) ON DELETE RESTRICT,
  period_id          INTEGER       REFERENCES compliance_periods(id) ON DELETE SET NULL,
  assessment_id      INTEGER       REFERENCES compliance_assessments(id) ON DELETE SET NULL,
  version_no         INTEGER       NOT NULL CHECK (version_no >= 1),
  doc_type           VARCHAR(12)   NOT NULL DEFAULT 'certificate'
    CHECK (doc_type IN ('certificate','receipt','application','evidence','other')),
  file_name          VARCHAR(255)  NOT NULL,
  mime_type          VARCHAR(100)  NOT NULL,
  size_bytes         INTEGER       NOT NULL,
  blob_sha256        CHAR(64)      NOT NULL REFERENCES compliance_blobs(sha256) ON DELETE RESTRICT,
  valid_from         DATE,
  valid_to           DATE,
  reference_no       VARCHAR(100),
  note               TEXT,
  uploaded_by        INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  uploaded_by_name   VARCHAR(100)  NOT NULL,
  uploaded_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  retracted_at       TIMESTAMPTZ,
  retracted_by       INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  retracted_by_name  VARCHAR(100),
  retracted_reason   TEXT
);
-- Version numbers are per item (period evidence shares the item's sequence).
CREATE UNIQUE INDEX IF NOT EXISTS compliance_documents_version_uniq ON compliance_documents (item_id, version_no);
CREATE INDEX IF NOT EXISTS idx_compliance_documents_item ON compliance_documents (item_id, uploaded_at DESC);

-- ── Reminder job ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_reminder_runs (
  id             SERIAL        PRIMARY KEY,
  started_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ,
  as_of          DATE          NOT NULL,
  trigger        VARCHAR(8)    NOT NULL CHECK (trigger IN ('cron','manual')),
  dry_run        BOOLEAN       NOT NULL DEFAULT false,
  ok             BOOLEAN,
  error          VARCHAR(500),
  stats          JSONB,
  duration_ms    INTEGER,
  heap_delta_kb  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_compliance_runs_started ON compliance_reminder_runs (started_at DESC);

-- One row per email actually attempted (a consolidated email covers many
-- notification rows).
CREATE TABLE IF NOT EXISTS compliance_mail_log (
  id               BIGSERIAL     PRIMARY KEY,
  run_id           INTEGER       REFERENCES compliance_reminder_runs(id) ON DELETE SET NULL,
  recipient_email  VARCHAR(120)  NOT NULL,
  subject          VARCHAR(250),
  item_count       INTEGER       NOT NULL DEFAULT 1,
  sent             BOOLEAN       NOT NULL,
  reason           VARCHAR(200),
  transport        VARCHAR(8),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- The outbox. One row per (item, deadline, stage, recipient): the UNIQUE key
-- is what makes a reminder fire exactly once however often the job runs.
-- Rows that cannot go out yet are kept with the reason (held while the
-- record is unverified, no email for the person, reminders switched off), so
-- the app can show who WOULD have been told — and a later run releases them
-- once the reason is gone.
CREATE TABLE IF NOT EXISTS compliance_notifications (
  id               BIGSERIAL     PRIMARY KEY,
  item_id          INTEGER       NOT NULL REFERENCES compliance_items(id) ON DELETE CASCADE,
  deadline         DATE          NOT NULL,
  stage            VARCHAR(6)    NOT NULL,    -- 'D', 'S', 'H', 'OD0', 'OD1', …
  audience         VARCHAR(8)    NOT NULL CHECK (audience IN ('direct','second','head')),
  recipient_key    VARCHAR(20)   NOT NULL,    -- 'c:<contactId>' or 'u:<userId>' (HOD fallback)
  recipient_name   VARCHAR(100),
  recipient_email  VARCHAR(120),
  status           VARCHAR(18)   NOT NULL CHECK (status IN ('pending','sent','failed','gave_up','held_unverified',
                                                           'skipped_no_email','skipped_disabled','superseded')),
  attempts         SMALLINT      NOT NULL DEFAULT 0,
  last_error       VARCHAR(200),
  next_attempt_at  TIMESTAMPTZ,
  sent_at          TIMESTAMPTZ,
  mail_log_id      BIGINT        REFERENCES compliance_mail_log(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, deadline, stage, recipient_key)
);
CREATE INDEX IF NOT EXISTS idx_compliance_notifications_status ON compliance_notifications (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_compliance_notifications_item   ON compliance_notifications (item_id, created_at DESC);
