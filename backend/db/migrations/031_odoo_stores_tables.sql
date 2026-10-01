-- 031: Odoo Stores pipeline — gate entries, GRN lines and material issues.
--
-- Three endpoints went live on the production ERP on 2026-10-01
-- (gate_entry_report, grn_register_report, material_request_report). Before
-- this, the Raw Material and Diesel reports were built by an officer
-- downloading three .xls files out of Odoo's UI and pivoting them by hand.
-- These tables are where the scheduled pull lands that same data.
--
-- WHY THREE TABLES AND NOT ONE
--
-- Unlike migration 028's deliberately polymorphic it_assets, these three
-- are NOT the same question repeated. They sit at different grains and
-- answer different questions:
--
--   rm_gate_entries   one row per TRUCK VISIT (physical). Keyed by the gate
--                     token. This is the timely source — the truck is on the
--                     weighbridge today whether or not Accounts has booked it.
--   rm_grn_lines      one row per GRN LINE (accounting). Keyed by GRN no +
--                     item. Carries rate/value — the stock valuation.
--   stores_issues     one row per MATERIAL ISSUE LINE (consumption). Keyed by
--                     issue no + line. Feeds diesel-by-department and, later,
--                     consumption for every other store item.
--
-- A gate entry can exist with no GRN (that IS "pending GRN", a column the
-- Raw Material report already has), and an issue has no relationship to
-- either. Collapsing them would mean a nullable-everything table whose rows
-- can only be read by first asking which kind they are.
--
-- THE 1.5-DAY LAG THAT SHAPES THIS
--
-- Measured over the 2026-09-16 exports: GRN is booked 0.1-5.1 days after the
-- truck physically arrives (mean 1.5). So a "received today" figure built
-- from grn_date understates stock for days and then dumps a backlog into one
-- day. The gate entry's unloading_end_time is the honest "received" date, and
-- that is why rm_gate_entries exists at all rather than GRN alone being
-- synced. Keeping both lets the report show received (gate, timely) and
-- pending GRN (gate rows with no GRN yet) as two separate, true facts.
--
-- source: 'odoo' | 'excel' — mirrors migration 016's convention so a manual
-- upload and a scheduled sync can never double-count the same truck. The
-- sync only ever overwrites rows it owns ('odoo').

CREATE TABLE IF NOT EXISTS rm_gate_entries (
  inward_token_no       VARCHAR(40)  PRIMARY KEY,
  token_date            TIMESTAMPTZ,
  token_type            VARCHAR(40),          -- 'Raw Material' | 'Others'
  status                VARCHAR(40),          -- 'Exit' observed; cancelled rows carry a reason
  cancel_reason         TEXT,
  -- These five are TEXT, not VARCHAR(n), for a measured reason: on a
  -- multi-vendor "Others" token Odoo COMMA-JOINS every value into one
  -- field. Measured 2026-10-01 over 86 rows: vendor reached 154 chars
  -- ('[CMLT0104] Cash Sale Stores Ltd., [CMLT0342] MMUT ...'), grn_no 93,
  -- po_ref 88, pr_ref 86, vendor_dc_no 25. A VARCHAR(40) here is not a
  -- tighter constraint, it is a crash on the first multi-vendor truck --
  -- which is exactly how the first run of this sync failed.
  vendor                TEXT,                 -- '[CODE] Name', comma-joined when multi-vendor
  vendor_code           VARCHAR(40),          -- parsed from the FIRST code only; null when multi
  vendor_dc_no          TEXT,                 -- delivery challan; comma-joined when multi
  vendor_dc_date        DATE,                 -- first parseable date only
  po_ref                TEXT,
  pr_ref                TEXT,
  material_code         VARCHAR(40),
  material_desc         TEXT,
  uom                   VARCHAR(20),
  challan_qty           NUMERIC(14,3),
  net_weight            NUMERIC(14,3),        -- weighbridge net, in KG as Odoo sends it
  gross_weight          NUMERIC(14,3),
  tare_weight           NUMERIC(14,3),
  unloading_end_time    TIMESTAMPTZ,          -- the honest "received" moment
  receipt_date          DATE,                 -- date(unloading_end_time), for day joins
  grn_no                TEXT,                 -- blank => pending GRN; comma-joined when multi
  grn_date              TIMESTAMPTZ,          -- first parseable date when comma-joined
  quantity              NUMERIC(14,3),        -- GRN-booked qty, null until booked
  cost_unit_rate        NUMERIC(18,4),
  value                 NUMERIC(18,2),
  po_qty                NUMERIC(14,3),
  po_balance_qty        NUMERIC(14,3),
  truck_no              VARCHAR(40),
  transporter_name      TEXT,
  department            TEXT,                 -- comma-joined on multi-department tokens (38 chars seen)
  source                VARCHAR(10)  NOT NULL DEFAULT 'odoo',
  synced_at             TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rm_gate_receipt_date ON rm_gate_entries (receipt_date);
CREATE INDEX IF NOT EXISTS idx_rm_gate_material     ON rm_gate_entries (material_code);
-- Partial index: "what is still waiting for a GRN" is THE pending-GRN query
-- and it only ever looks at this slice.
CREATE INDEX IF NOT EXISTS idx_rm_gate_pending_grn  ON rm_gate_entries (receipt_date)
  WHERE grn_no IS NULL OR grn_no = '';

-- GRN lines. A GRN can carry several items, so the key is GRN + item, not
-- GRN alone. Odoo sends no line id, so item_code completes the key; the sync
-- adds a line_seq for the (rare) case of one item twice on one GRN.
CREATE TABLE IF NOT EXISTS rm_grn_lines (
  grn_no                VARCHAR(40)  NOT NULL,
  item_code             VARCHAR(40)  NOT NULL,
  line_seq              SMALLINT     NOT NULL DEFAULT 1,
  grn_date              TIMESTAMPTZ,
  grn_status            VARCHAR(40),
  return_grn            VARCHAR(40),          -- non-empty => this reverses a GRN
  inward_token_no       VARCHAR(40),          -- joins back to rm_gate_entries
  po_no                 VARCHAR(40),
  po_date               TIMESTAMPTZ,
  purchase_type         VARCHAR(20),          -- 'Local' | 'Import'
  vendor_code           VARCHAR(40),
  vendor_name           TEXT,
  vendor_dc_no          VARCHAR(60),
  vendor_dc_date        DATE,
  item_name             TEXT,                 -- up to 103 chars measured (full spare-part names)
  uom                   VARCHAR(20),
  challan_qty           NUMERIC(14,3),
  received_qty          NUMERIC(14,3),
  qc_accepted_qty       NUMERIC(14,3),
  qc_rejected_qty       NUMERIC(14,3),
  variance_qty          NUMERIC(14,3),        -- weighbridge minus challan
  rate                  NUMERIC(18,4),        -- unit rate: the valuation input
  value                 NUMERIC(18,2),        -- qty x rate
  freight               NUMERIC(18,4),
  lc_amount             NUMERIC(18,2),
  weighbridge_net_qty   NUMERIC(14,3),
  weighbridge_ticket_no VARCHAR(40),
  location_and_bin      TEXT,
  pr_no                 VARCHAR(40),          -- empty for raw material (see below)
  department            TEXT,
  source                VARCHAR(10)  NOT NULL DEFAULT 'odoo',
  synced_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (grn_no, item_code, line_seq)
);

CREATE INDEX IF NOT EXISTS idx_rm_grn_date  ON rm_grn_lines (grn_date);
CREATE INDEX IF NOT EXISTS idx_rm_grn_token ON rm_grn_lines (inward_token_no);
CREATE INDEX IF NOT EXISTS idx_rm_grn_item  ON rm_grn_lines (item_code);

-- pr_no is recorded but is EMPTY on every raw-material row, by design on
-- Odoo's side: measured 2026-10-01 over 181 GRN lines, COAL 0/67, IRON ORE
-- 0/53, GYPSUM 0/26, INDUSTRIAL CLAY 0/11 carried a PR, while store/spare
-- items (cable, tape, felt, rope, gear oil) carried one on 15/15. Raw
-- material goes straight to PO with no requisition step. The column stays so
-- the store-item side of the same feed keeps its PR, and so nobody re-asks
-- the Odoo team for a field that is working as intended.

CREATE TABLE IF NOT EXISTS stores_issues (
  issue_no              VARCHAR(40)  NOT NULL,
  line_seq              SMALLINT     NOT NULL,
  issue_date            TIMESTAMPTZ,
  issue_day             DATE,                 -- date(issue_date), for day joins
  warehouse             VARCHAR(60),
  department            TEXT,
  division              TEXT,
  mrq_no                VARCHAR(40),
  requested_date        DATE,
  creator               TEXT,
  approved_by           TEXT,
  approved_date         TIMESTAMPTZ,
  product_code          VARCHAR(40),
  product_name          TEXT,                 -- up to 233 chars measured (full conveyor-belt specs)
  uom                   VARCHAR(20),
  approved_quantity     NUMERIC(14,3),
  issued_quantity       NUMERIC(14,3),
  equipment             TEXT,
  analytic_account      TEXT,                 -- the equipment/vehicle the diesel pivot groups by
  storage_location      TEXT,
  status                VARCHAR(30),
  force_closed          VARCHAR(10),
  unit_cost             NUMERIC(18,4),
  value                 NUMERIC(18,2),
  remarks               TEXT,
  source                VARCHAR(10)  NOT NULL DEFAULT 'odoo',
  synced_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (issue_no, line_seq)
);

CREATE INDEX IF NOT EXISTS idx_stores_issue_day     ON stores_issues (issue_day);
CREATE INDEX IF NOT EXISTS idx_stores_issue_product ON stores_issues (product_code);
CREATE INDEX IF NOT EXISTS idx_stores_issue_dept    ON stores_issues (department);
