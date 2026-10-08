-- 035: which days of the Sale Register feed have actually been pulled.
--
-- A day with no rows in odoo_sale_invoices is ambiguous: no invoices were
-- raised (a real zero — 16-19 Sep 2026 had almost none), or the day was
-- never synced. On the droplet every month before the sync started is the
-- second kind until it is backfilled. Without this table the Sales
-- dashboard could not tell a quiet month from an unsynced one, and would
-- report the latter as low sales.
--
-- One row per day storeDay() has completed, written in the same
-- transaction as that day's invoices, so a row here means the day's data
-- is fully present as of synced_at.

CREATE TABLE IF NOT EXISTS odoo_sale_sync_days (
  sync_day   DATE         PRIMARY KEY,
  invoices   INTEGER      NOT NULL,
  cement_mt  NUMERIC(14,3) NOT NULL,
  synced_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Days already mirrored before this table existed.
INSERT INTO odoo_sale_sync_days (sync_day, invoices, cement_mt, synced_at)
SELECT invoice_date, count(*), coalesce(sum(cement_mt), 0), max(synced_at)
FROM odoo_sale_invoices
GROUP BY invoice_date
ON CONFLICT (sync_day) DO NOTHING;
