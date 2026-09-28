-- 028: IT Asset Register — replaces the static, hardcoded, read-only
-- backend/data/mis/it-assets.json with a real, database-backed, editable,
-- Excel-importable register owned by the IT department.
--
-- THE SHAPE CHOICE: ONE POLYMORPHIC TABLE, NOT NINE.
--
-- The source workbook (M - 19 IT Report, a monthly export IT already
-- maintains) has ten sheets that are all "asset registers" in spirit but
-- share almost no columns: a computer has a MAC address and an OS, a CCTV
-- camera has an IP and a status, a DCS license has an order number and a
-- dispatch note, e-waste has a disposal remark. Nine bespoke tables would
-- mean nine near-identical CRUD code paths in services/itAssetImport.js and
-- routes/itAssets.js for what is, from the app's point of view, one
-- question repeated nine times: "list/create/update/delete a row in
-- register X". A `category` column plus a JSONB `data` column lets one
-- table, one import routine and one set of routes serve all nine, with the
-- register-specific shape validated in code (services/itAssetImport.js's
-- per-category column list, and routes/itAssets.js's per-category zod
-- schema) rather than in nine copies of DDL. This mirrors daily_reports'
-- own `form_type` + JSONB `data` design one table up in this same file,
-- which this codebase already trusts for the same reason: many report
-- shapes, one lifecycle.
--
-- The tradeoff, stated honestly: JSONB columns have no per-field type or
-- NOT NULL enforcement at the database level. That is acceptable here
-- because every field in every register is free-text-shaped in the source
-- (serials, model names, MAC/IP strings, remarks) — there is no numeric
-- computation or cross-row arithmetic done on this data anywhere in the
-- app, unlike kpi_monthly or daily_reports' numeric facts. If that changes
-- (e.g. a "warranty expiry" date used in an alert), that field should move
-- to a real typed column at that point, the way stoppage_facts pulled
-- specific numbers out of stoppages.data when the KPI engine needed them.
--
-- CATEGORY LIST (pinned by CHECK, not left free-text — an import must not
-- be able to invent an eleventh register nobody's UI or route code knows
-- about, the same reasoning as KPI_DEPTS in forms/access-registry.js):
--   factory_computers, ho_computers, printers, equipment_software,
--   dcs_licenses, network_switches, cctv, external_hard_disks,
--   biometric_devices, ewaste
--
-- REPLACE-WHOLE-CATEGORY ON IMPORT, NOT MERGE/UPSERT — a real tradeoff,
-- not a shortcut:
--
-- IT maintains ONE master Excel workbook monthly (a snapshot of everything
-- that currently exists) and re-uploads the whole thing. Merge-by-key was
-- considered and rejected: most of these sheets have no reliable natural
-- key. "Serial Number" looks like one until the second row where it is
-- literally the string 'NULL' (several computers/printers ship with it
-- blank in the source and IT typed NULL as a placeholder); MAC/IP addresses
-- repeat across a NIC's failover interfaces; "Sr No" is a per-sheet ordinal
-- that resets and is not stable between exports (a row deleted mid-list
-- shifts every ordinal after it). Attempting an upsert against any of these
-- would silently create duplicate rows or silently overwrite the wrong
-- one — worse than an honest full replace.
--
-- So a re-import of a category DELETEs that category's existing rows and
-- INSERTs the freshly parsed ones, inside one transaction (routes/itAssets.js),
-- so a partial import can never leave a category half-old/half-new. THE
-- TRADE THIS MAKES: there is no soft-undo of a replace. If IT uploads a
-- workbook missing rows that quietly vanished during editing, those rows
-- are gone from `it_assets` the moment the transaction commits — there is
-- no "restore the previous version of the CCTV register" button, the way
-- report_revisions gives daily_reports one. it_asset_imports below is NOT
-- that safety net; it is a record that a replace happened, not a copy of
-- what was replaced. A future "keep the last N snapshots" table is a
-- reasonable follow-up if IT ever needs to recover from a bad upload, but
-- it does not exist yet and this migration does not pretend otherwise.
--
-- it_asset_imports IS the operational safety net that DOES exist: one row
-- per import event, per category touched, so IT (and an admin) can see
-- when a register was last refreshed, by whom, from which file, and
-- whether the row count moved in a way worth a second look (a category
-- that goes from 164 rows to 12 is almost certainly the wrong file).
--
-- NAMES STORED BESIDE IDS, FKS ON DELETE SET NULL — same "an audit trail
-- must outlive the people in it" lesson as 024/025 (report_revisions) and
-- 027 (report_amendments): a leaver who once edited the register must not
-- block their own deletion, and the row should still say who touched it
-- last by name after the account is gone.

CREATE TABLE IF NOT EXISTS it_assets (
  id              SERIAL       PRIMARY KEY,
  category        VARCHAR(30)  NOT NULL
    CHECK (category IN (
      'factory_computers', 'ho_computers', 'printers', 'equipment_software',
      'dcs_licenses', 'network_switches', 'cctv', 'external_hard_disks',
      'biometric_devices', 'ewaste'
    )),

  -- Register-specific fields (see services/itAssetImport.js for the exact
  -- key set per category, taken verbatim from the source workbook's header
  -- cells). Free-text-shaped throughout — see the note above on why this is
  -- JSONB and not nine typed tables.
  data            JSONB        NOT NULL DEFAULT '{}',

  -- 'import' (came from an uploaded workbook) vs 'manual' (typed into the
  -- UI by an IT user) — so the register can show provenance per row rather
  -- than presenting a manually-added row as if the last bulk import knew
  -- about it, or vice versa.
  source          VARCHAR(10)  NOT NULL DEFAULT 'manual'
    CHECK (source IN ('import', 'manual')),

  created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_by      INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  updated_by_name VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_it_assets_category ON it_assets (category);

-- GIN index for the free-text `?q=` search across a category's JSONB
-- values (routes/itAssets.js casts data to text and searches it — see the
-- route file for why a generic per-field ILIKE isn't practical when the
-- field set varies by category). jsonb_path_ops keeps the index small;
-- plain search still works through the query's own ILIKE '%term%' on
-- data::text, which this index does not accelerate directly but the
-- category filter (the expensive part on a 1000+ row table) does use.
CREATE INDEX IF NOT EXISTS idx_it_assets_data_gin ON it_assets USING GIN (data);

COMMENT ON TABLE it_assets IS
  'IT asset register (computers, printers, licenses, CCTV, network gear, etc.), replacing backend/data/mis/it-assets.json. One row per asset; `category` says which of the 10 registers it belongs to and `data` holds that register''s columns as parsed from IT''s monthly Excel export. Re-import REPLACES a category''s rows wholesale inside a transaction — see this file''s header comment for why, and it_asset_imports for the resulting audit trail.';

-- ── IMPORT AUDIT TRAIL ──────────────────────────────────────────────────
-- One row per (import event × category actually touched). Answers "when
-- was this register last refreshed, by whom, from what file, and did the
-- count move in a way that deserves a second look" — the operational
-- safety net for a replace-on-import design that keeps no other history.
CREATE TABLE IF NOT EXISTS it_asset_imports (
  id                  SERIAL       PRIMARY KEY,
  category            VARCHAR(30)  NOT NULL,
  imported_at         TIMESTAMP    NOT NULL DEFAULT NOW(),
  imported_by         INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  imported_by_name    VARCHAR(100),
  source_filename     VARCHAR(255),
  row_count           INTEGER      NOT NULL,
  previous_row_count  INTEGER      NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_it_asset_imports_category ON it_asset_imports (category, imported_at DESC);

COMMENT ON TABLE it_asset_imports IS
  'One row per category replaced by an /api/it-assets/import upload — who, when, from which file, and the row count before/after. This is NOT a copy of the replaced rows (no soft-undo of a replace exists); it is the record that a replace happened, so an unexpected count drop is visible.';
