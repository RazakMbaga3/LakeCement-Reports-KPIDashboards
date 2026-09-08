-- 016: mark where each weighbridge ticket came from.
--
-- Until now every row in weighbridge_tickets arrived one way: a human
-- uploading the Odoo "Uploaded_Data" Excel export through
-- POST /api/quarry/tickets/import. The mining_report API (live since
-- 2026-09-08, see services/odooMiningClient.js) is a second source for the
-- SAME physical weighings, and the Quarry dashboard sums every ticket it
-- finds — so without a way to tell the two apart, pulling a date that was
-- already imported from Excel would silently DOUBLE COUNT that day's
-- tonnage. Everything downstream (TMH, crusher throughput, stock-yard
-- movement) would read high with no visible error.
--
-- 'excel' as the default is the historically correct answer for every row
-- that already exists: all of them came from a manual upload.
ALTER TABLE weighbridge_tickets
  ADD COLUMN IF NOT EXISTS source VARCHAR(12) NOT NULL DEFAULT 'excel';

-- The sync's two hot paths are both (source, ticket_date): "does this date
-- already hold Excel rows I must not shadow?" and "which odoo rows for this
-- date are no longer in the pull and should be dropped?".
CREATE INDEX IF NOT EXISTS idx_weighbridge_source_date
  ON weighbridge_tickets(source, ticket_date);
