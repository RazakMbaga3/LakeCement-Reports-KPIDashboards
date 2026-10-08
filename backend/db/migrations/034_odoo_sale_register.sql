-- 034: Odoo Sale Register mirror.
--
-- On 2026-10-08 Odoo replaced sale_dashboard_report's payload with an
-- invoice-centric feed: one row per posted customer invoice, with its
-- product lines, delivery notes and customer receipts nested inside. It is
-- the same data as the Sales team's "SALE REGISTER" workbook. Reconciled for
-- September 2026: all 2,003 Register invoices present, same tonnage per
-- invoice, untaxed amount equal to the Register's NET to the shilling. The
-- whole-month gap (+30 MT, +42.7M TZS) is one credit note the feed does not
-- carry and four non-cement invoices the Register leaves out.
--
-- WHY A MIRROR AND NOT A READ-THROUGH
--
-- The feed costs ~0.27 s per invoice: a month (~2,000 invoices) is ~9
-- minutes, and the 180 s client timeout fails on anything past a few days.
-- So it is pulled one day at a time on a schedule (odooSalesSync.js) and the
-- Sales dashboard reads these tables.
--
-- WHY FIVE TABLES
--
-- The feed nests three different things inside an invoice, at three grains,
-- and one of them is shared ACROSS invoices:
--
--   odoo_sale_invoices          one row per invoice (the Register's grain)
--   odoo_sale_invoice_lines     one row per invoice line, product or charge
--   odoo_sale_delivery_lines    one row per delivery-note stock move
--   odoo_sale_receipts          one row per customer receipt
--   odoo_sale_invoice_receipts  which receipts were applied to which invoice
--
-- Receipts get their own table because one receipt pays many invoices: in
-- September 1,353 distinct receipts appeared 2,000+ times across invoices.
-- The feed's invoice-level `collection_amount` is the WHOLE receipt repeated
-- on every invoice it touched; summed, it reads 8.7B for two days against
-- 1.7B actually paid. Storing receipts once, keyed by receipt_id, is what
-- makes a collection figure impossible to double-count.
--
-- DERIVED COLUMNS, AND WHY THEY ARE COMPUTED AT WRITE TIME
--
-- Almost every invoice carries a productless line: excise duty at 1,080 TZS
-- per bag (21,600 per MT for bulk). Its `quantity` repeats the bag count, so
-- the feed's invoice-level `quantity` double-counts bags on ~every invoice.
-- cement_mt / excise_amount / line_kind / qty_mt / grade_key are resolved
-- once, on ingest, by one function, so no reader can repeat that mistake.

CREATE TABLE IF NOT EXISTS odoo_sale_invoices (
  invoice_id        BIGINT        PRIMARY KEY,
  invoice_number    VARCHAR(40)   NOT NULL,
  invoice_date      DATE          NOT NULL,   -- the Register's month filter
  customer_id       BIGINT,
  customer_name     TEXT,
  customer_code     VARCHAR(40),              -- 'CUS928'; the join key to the Sales team's sheets
  sale_order_id     BIGINT,
  sale_order        TEXT,
  sale_order_ids    TEXT,                     -- comma-joined when an invoice covers several SOs
  sale_order_date   DATE,
  status            VARCHAR(20),              -- 'posted' (only value observed)
  payment_status    VARCHAR(20),              -- paid | in_payment | partial | not_paid
  salesperson_id    BIGINT,
  salesperson       TEXT,                     -- Odoo's officer; NOT always the Sales team's (see 035+)
  division_id       BIGINT,
  division          VARCHAR(20),              -- 'D1'
  zone_id           BIGINT,
  zone              TEXT,
  region_id         BIGINT,
  region            TEXT,
  currency          VARCHAR(8),
  untaxed_amount    NUMERIC(18,2),            -- == Register "NET amount without VAT"; includes excise
  tax_amount        NUMERIC(18,2),
  total_amount      NUMERIC(18,2),
  residual_amount   NUMERIC(18,2),            -- still outstanding as of synced_at
  -- derived on ingest:
  cement_mt         NUMERIC(14,3) NOT NULL DEFAULT 0,  -- cement product lines only, bags/20
  non_cement_mt     NUMERIC(14,3) NOT NULL DEFAULT 0,  -- fly ash, scrap, ...
  excise_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,  -- productless (charge) lines
  is_cement         BOOLEAN       NOT NULL DEFAULT TRUE, -- false = no cement line at all
  synced_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_osi_invoice_date  ON odoo_sale_invoices (invoice_date);
CREATE INDEX IF NOT EXISTS idx_osi_customer_code ON odoo_sale_invoices (customer_code);

CREATE TABLE IF NOT EXISTS odoo_sale_invoice_lines (
  line_id       BIGINT        PRIMARY KEY,
  invoice_id    BIGINT        NOT NULL REFERENCES odoo_sale_invoices (invoice_id) ON DELETE CASCADE,
  line_kind     VARCHAR(10)   NOT NULL,       -- 'product' | 'charge' (productless: excise)
  product_id    BIGINT,
  product       TEXT,
  product_code  VARCHAR(40),                  -- 'FG001'
  quantity      NUMERIC(14,3),
  uom           TEXT,                         -- '50 KG BAG' | 'MT' | '' on charges
  qty_mt        NUMERIC(14,3),                -- product lines only; null on charges
  grade_key     VARCHAR(20),                  -- super42|max32|duramax42|premiumopc; null otherwise
  is_cement     BOOLEAN       NOT NULL DEFAULT FALSE,
  rate          NUMERIC(18,6),
  amount        NUMERIC(18,2),
  taxed_amount  NUMERIC(18,2)
);
CREATE INDEX IF NOT EXISTS idx_osil_invoice ON odoo_sale_invoice_lines (invoice_id);

CREATE TABLE IF NOT EXISTS odoo_sale_delivery_lines (
  move_id             BIGINT       PRIMARY KEY,
  invoice_id          BIGINT       NOT NULL REFERENCES odoo_sale_invoices (invoice_id) ON DELETE CASCADE,
  delivery_id         BIGINT,
  delivery_number     VARCHAR(40),            -- 'CM/DN/2026/24530'
  -- Stored exactly as Odoo sends it ('2026-09-30 17:35:57'), with no zone:
  -- the feed does not say whether that is UTC or plant time, and nothing
  -- reads it for date bucketing (the Register buckets by invoice_date).
  delivery_date       TIMESTAMP,
  scheduled_date      TIMESTAMP,
  delivery_status     VARCHAR(20),
  origin              TEXT,
  delivery_partner    TEXT,                   -- the delivery-address contact, NOT the invoice customer
  source_location     TEXT,
  destination_location TEXT,
  product_id          BIGINT,
  product             TEXT,
  product_code        VARCHAR(40),
  quantity            NUMERIC(14,3),
  delivered_quantity  NUMERIC(14,3),
  uom                 VARCHAR(20)
);
CREATE INDEX IF NOT EXISTS idx_osdl_invoice ON odoo_sale_delivery_lines (invoice_id);

CREATE TABLE IF NOT EXISTS odoo_sale_receipts (
  receipt_id      BIGINT        PRIMARY KEY,
  receipt_number  VARCHAR(40),
  receipt_date    DATE,
  amount          NUMERIC(18,2),
  payment_type    VARCHAR(20),
  currency        VARCHAR(8),
  synced_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_osr_receipt_date ON odoo_sale_receipts (receipt_date);

CREATE TABLE IF NOT EXISTS odoo_sale_invoice_receipts (
  invoice_id  BIGINT NOT NULL REFERENCES odoo_sale_invoices (invoice_id) ON DELETE CASCADE,
  receipt_id  BIGINT NOT NULL REFERENCES odoo_sale_receipts (receipt_id) ON DELETE CASCADE,
  PRIMARY KEY (invoice_id, receipt_id)
);
CREATE INDEX IF NOT EXISTS idx_osir_receipt ON odoo_sale_invoice_receipts (receipt_id);
