-- 037: Compliance Master — the register of statutory obligations.
--
-- Replaces "1. Compliance Master.xlsx", a hand-kept workbook whose Status
-- column had drifted from its own dates: on 2026-10-12, 96 of its 106 dated
-- rows were past their "To" date and 66 of those still said "Active". So the
-- rule here is that STATUS IS NEVER STORED. It is computed from the dates by
-- services/complianceStatus.js on every read, and what this schema keeps is
-- only what that computation needs. Every input that drives a deadline is a
-- typed column, not JSONB (contrast it_assets, migration 028, whose JSONB is
-- fine only because nothing is computed from it).
--
-- Three kinds of obligation, one table:
--   validity   a licence / certificate / calibration with Valid From/To that
--              gets renewed (OSHA, TBS calibrations, business licences);
--   recurring  a filing or payment due on a rule — VAT by the 20th every
--              month, City Service Levy quarterly — each instance a row in
--              compliance_periods, marked done with evidence;
--   condition  a standing obligation reviewed periodically (mining-lease
--              conditions: keep 200 m from public buildings, signage...),
--              each review a row in compliance_assessments.
--
-- Ownership: owner_role is the access boundary (a department may see and
-- maintain only its own obligations; md/management read all). It is a role
-- key, the same boundary every other module enforces; section_label keeps
-- the workbook's own department wording ("Admin/Safety") for display.
--
-- People: the workbook names the responsible people ("Marina", "Pavan
-- Gandhi") but has no emails, and most of them have no MIS login. They are
-- compliance_contacts — a reminder goes to a contact; a contact may be linked
-- to a user, whose email then wins because it stays current.
--
-- Actors are stored as id + name with ON DELETE SET NULL, the rule 025/027
-- set: a compliance trail has to outlive the people in it.

-- ── People who are reminded ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_contacts (
  id               SERIAL       PRIMARY KEY,
  name             VARCHAR(100) NOT NULL,
  email            VARCHAR(120)
    CHECK (email IS NULL OR email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  user_id          INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  aliases          TEXT[]       NOT NULL DEFAULT '{}',
  active           BOOLEAN      NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by       INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  updated_by_name  VARCHAR(100)
);
CREATE UNIQUE INDEX IF NOT EXISTS compliance_contacts_name_uniq ON compliance_contacts (LOWER(name));
CREATE UNIQUE INDEX IF NOT EXISTS compliance_contacts_user_uniq ON compliance_contacts (user_id) WHERE user_id IS NOT NULL;

-- ── Groups: a mining licence and its obligations, or a bundle (ISO set) ──
CREATE TABLE IF NOT EXISTS compliance_groups (
  id          SERIAL       PRIMARY KEY,
  kind        VARCHAR(20)  NOT NULL CHECK (kind IN ('mining_licence','bundle')),
  code        VARCHAR(60)  NOT NULL,
  title       VARCHAR(200),
  owner_role  VARCHAR(30)  NOT NULL,
  entity      VARCHAR(10)  NOT NULL DEFAULT 'LCL',
  attrs       JSONB        NOT NULL DEFAULT '{}',   -- location, licence type, resource, area: display only
  import_key  VARCHAR(80)  UNIQUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (kind, code)
);

-- ── The obligations ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_items (
  id                     SERIAL        PRIMARY KEY,
  kind                   VARCHAR(10)   NOT NULL CHECK (kind IN ('validity','recurring','condition')),
  owner_role             VARCHAR(30)   NOT NULL CHECK (owner_role ~ '^[a-z]+$'),
  section_label          VARCHAR(60),
  entity                 VARCHAR(10)   NOT NULL DEFAULT 'LCL' CHECK (entity IN ('LCL','BRL','UCL')),
  group_id               INTEGER       REFERENCES compliance_groups(id) ON DELETE SET NULL,
  title                  VARCHAR(200)  NOT NULL,
  description            TEXT,
  agency                 VARCHAR(200),
  reference_no           VARCHAR(100),
  custodian              VARCHAR(30),
  criticality            VARCHAR(8)    NOT NULL DEFAULT 'normal' CHECK (criticality IN ('high','normal','low')),
  frequency_label        VARCHAR(120),

  -- validity
  valid_from             DATE,
  valid_to               DATE,
  no_expiry              BOOLEAN       NOT NULL DEFAULT false,

  -- recurrence (kind = 'recurring')
  rec_unit               VARCHAR(10)   CHECK (rec_unit IN ('month','quarter','half','year','years','on_demand')),
  rec_interval           SMALLINT      NOT NULL DEFAULT 1 CHECK (rec_interval BETWEEN 1 AND 20),
  rec_due_day            SMALLINT      CHECK (rec_due_day BETWEEN 1 AND 31),
  rec_due_month          SMALLINT      CHECK (rec_due_month BETWEEN 1 AND 12),
  rec_anchor_date        DATE,
  track_from             DATE,

  -- condition
  review_interval_months SMALLINT      CHECK (review_interval_months BETWEEN 1 AND 120),
  next_review_on         DATE,
  condition_result       VARCHAR(14)   CHECK (condition_result IN ('complied','partial','not_complied','not_applicable')),
  condition_assessed_on  DATE,

  -- reminders (NULL = the kind's default, from compliance_settings)
  lead_days_1            SMALLINT      CHECK (lead_days_1 BETWEEN 0 AND 365),
  lead_days_2            SMALLINT      CHECK (lead_days_2 BETWEEN 0 AND 365),
  lead_days_3            SMALLINT      CHECK (lead_days_3 BETWEEN 0 AND 365),
  reminders_enabled      BOOLEAN       NOT NULL DEFAULT true,

  -- lifecycle and secondary flags (flags never change the computed status)
  lifecycle              VARCHAR(10)   NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','inactive','archived')),
  inactive_reason        TEXT,
  renewal_in_progress    BOOLEAN       NOT NULL DEFAULT false,
  renewal_note           TEXT,
  renewal_started_on     DATE,
  next_due_on            DATE,          -- maintained by the service; an index, never the truth

  verified_at            TIMESTAMPTZ,
  verified_by            INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  verified_by_name       VARCHAR(100),

  source                 VARCHAR(10)   NOT NULL DEFAULT 'manual' CHECK (source IN ('import','manual')),
  import_key             VARCHAR(80),
  source_sheet           VARCHAR(60),
  source_row             INTEGER,
  source_raw             JSONB,         -- the workbook cells as found: the "Sheet said" view
  user_edited_at         TIMESTAMPTZ,   -- set by any in-app edit; re-import never overwrites such a row

  fee_amount             NUMERIC(18,2),
  fee_currency           CHAR(3),
  remarks                TEXT,
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by             INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  created_by_name        VARCHAR(100),
  updated_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_by             INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  updated_by_name        VARCHAR(100),

  CHECK (lead_days_1 IS NULL OR lead_days_2 IS NULL OR lead_days_1 >= lead_days_2),
  CHECK (lead_days_2 IS NULL OR lead_days_3 IS NULL OR lead_days_2 >= lead_days_3),
  CHECK (NOT no_expiry OR valid_to IS NULL),
  CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from),
  CHECK (kind <> 'recurring' OR rec_unit IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS compliance_items_import_key_uniq ON compliance_items (import_key) WHERE import_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_compliance_items_owner   ON compliance_items (owner_role);
CREATE INDEX IF NOT EXISTS idx_compliance_items_due     ON compliance_items (next_due_on) WHERE lifecycle = 'active';
CREATE INDEX IF NOT EXISTS idx_compliance_items_group   ON compliance_items (group_id);

-- Responsible person (tier 1, "Level 1" in the workbook) and supervisor
-- (tier 2, "Level 2"). Several per tier: the workbook writes "Muneesh/ Rahul".
CREATE TABLE IF NOT EXISTS compliance_item_responsibles (
  item_id     INTEGER  NOT NULL REFERENCES compliance_items(id) ON DELETE CASCADE,
  tier        SMALLINT NOT NULL CHECK (tier IN (1,2)),
  contact_id  INTEGER  NOT NULL REFERENCES compliance_contacts(id) ON DELETE RESTRICT,
  position    SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, tier, contact_id)
);

-- One instance of a recurring obligation. A missed period stays 'open', so
-- the item stays Overdue until that period is done or waived — a later
-- period being generated never hides it.
CREATE TABLE IF NOT EXISTS compliance_periods (
  id             SERIAL        PRIMARY KEY,
  item_id        INTEGER       NOT NULL REFERENCES compliance_items(id) ON DELETE CASCADE,
  period_key     VARCHAR(12)   NOT NULL,    -- '2026-10', '2026-Q4', '2026-H2', '2026', 'adhoc-n'
  due_on         DATE          NOT NULL,
  status         VARCHAR(8)    NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','waived')),
  done_on        DATE,
  done_by        INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  done_by_name   VARCHAR(100),
  reference      VARCHAR(100),
  amount         NUMERIC(18,2),
  currency       CHAR(3),
  note           TEXT,
  waived_reason  TEXT,
  source         VARCHAR(10)   NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','import','manual')),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, period_key),
  CHECK (status <> 'done' OR done_on IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_compliance_periods_open ON compliance_periods (item_id, due_on) WHERE status = 'open';

-- Append-only judgements on a condition item. assessed_on is unknown only
-- for what the workbook said (source 'import').
CREATE TABLE IF NOT EXISTS compliance_assessments (
  id                SERIAL        PRIMARY KEY,
  item_id           INTEGER       NOT NULL REFERENCES compliance_items(id) ON DELETE CASCADE,
  assessed_on       DATE,
  result            VARCHAR(14)   NOT NULL CHECK (result IN ('complied','partial','not_complied','not_applicable')),
  note              TEXT,
  raw_text          VARCHAR(200),
  source            VARCHAR(10)   NOT NULL DEFAULT 'manual' CHECK (source IN ('import','manual')),
  assessed_by       INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  assessed_by_name  VARCHAR(100),
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CHECK (source = 'import' OR assessed_on IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_compliance_assessments_item ON compliance_assessments (item_id, created_at DESC);

-- What changed on an item, by whom — the record's own History tab.
CREATE TABLE IF NOT EXISTS compliance_history (
  id          BIGSERIAL     PRIMARY KEY,
  item_id     INTEGER       NOT NULL REFERENCES compliance_items(id) ON DELETE CASCADE,
  at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  actor_id    INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  actor_name  VARCHAR(100),
  action      VARCHAR(30)   NOT NULL,
  changes     JSONB,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_compliance_history_item ON compliance_history (item_id, at DESC);

CREATE TABLE IF NOT EXISTS compliance_imports (
  id           SERIAL        PRIMARY KEY,
  at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  by_id        INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  by_name      VARCHAR(100),
  file_name    VARCHAR(255),
  file_sha256  CHAR(64),
  counts       JSONB,
  mapping      JSONB,
  warnings     JSONB
);

-- Key/value settings. reminders_enabled starts FALSE: deploying the module
-- sends nothing until someone with the authority switches it on.
CREATE TABLE IF NOT EXISTS compliance_settings (
  key              VARCHAR(60)   PRIMARY KEY,
  value            JSONB         NOT NULL,
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_by       INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  updated_by_name  VARCHAR(100)
);
INSERT INTO compliance_settings (key, value) VALUES ('reminders_enabled', 'false')
ON CONFLICT (key) DO NOTHING;

-- The central "Head" escalation list (one list for every department).
CREATE TABLE IF NOT EXISTS compliance_head_recipients (
  contact_id  INTEGER      PRIMARY KEY REFERENCES compliance_contacts(id) ON DELETE CASCADE,
  label       VARCHAR(60)  NOT NULL,
  position    SMALLINT     NOT NULL DEFAULT 0
);

-- One row per owning department per day, written by the daily job: the
-- trend line, the KPI month-end figure and the adoption metrics read this.
CREATE TABLE IF NOT EXISTS compliance_snapshots (
  as_of       DATE         NOT NULL,
  owner_role  VARCHAR(30)  NOT NULL,
  active      INTEGER      NOT NULL DEFAULT 0,
  due         INTEGER      NOT NULL DEFAULT 0,
  overdue     INTEGER      NOT NULL DEFAULT 0,
  undated     INTEGER      NOT NULL DEFAULT 0,
  inactive    INTEGER      NOT NULL DEFAULT 0,
  verified    INTEGER      NOT NULL DEFAULT 0,
  total       INTEGER      NOT NULL DEFAULT 0,
  PRIMARY KEY (as_of, owner_role)
);
