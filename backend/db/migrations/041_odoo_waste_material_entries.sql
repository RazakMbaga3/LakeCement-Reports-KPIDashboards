-- 041: mirror of Odoo's Waste Material Entry (Operations -> Waste Material
-- Entry, table waste_material_entry) — the overburden the quarry contractors
-- haul from the North/South mines to the dump areas.
--
-- Why a mirror and not a live query: Odoo is the LIVE ERP the plant works in,
-- reached over a read-only login (services/odooDb.js). Pages and the MIS
-- summary read this table; only the scheduled pull (services/odooWasteSync.js)
-- reads Odoo, over a short re-pulled window.
--
-- What one row is: one Odoo entry (WM/2026/0117 …) — a date, a hauling
-- contractor, a trip count and a quantity in MT. Measured 2026-10-15 over all
-- 643 entries (2023-08-16..2026-10-12): quantity = trips x 20 t on 609 of
-- them; the 34 others are LCL's own trucks at 25 t/trip (2025) and a handful
-- of one-offs (WM/2026/0100, 2026-09-15: 26 trips, 502 t). The tonnage is
-- therefore a load-factor figure Odoo records, NOT a weighbridge weight, and
-- every reader must say so. The mine (North/South) appears only in free-text
-- remarks, so it is stored as text and never presented as a split.
--
-- odoo_id is Odoo's own primary key, so the pull is a plain upsert. An entry
-- keeps its row whatever its state: totals count state = 'approved' only,
-- and an entry awaiting approval is visible as exactly that. An entry that
-- disappears from Odoo inside a re-pulled window is marked withdrawn (kept,
-- never deleted) — the same convention as odoo_production_entries (018).
CREATE TABLE IF NOT EXISTS odoo_waste_material_entries (
  odoo_id          INTEGER       PRIMARY KEY,
  name             VARCHAR(40),
  entry_date       DATE          NOT NULL,
  contractor_id    INTEGER,
  contractor       VARCHAR(255),
  trips            INTEGER,
  quantity_mt      NUMERIC(14,3),
  remarks          TEXT,
  state            VARCHAR(20),
  approval_status  VARCHAR(20),
  odoo_write_date  TIMESTAMP,
  first_seen_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  last_seen_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ,
  withdrawn_at     TIMESTAMPTZ
);

-- The two hot paths: totals for a date range (MIS summary, Quarry page) and
-- the withdrawal sweep over a re-pulled window.
CREATE INDEX IF NOT EXISTS idx_odoo_waste_entries_date
  ON odoo_waste_material_entries (entry_date);
