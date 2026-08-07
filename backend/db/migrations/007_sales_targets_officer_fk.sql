-- 007: sales_targets.officer_code must accept the '_company' sentinel for
-- company-wide targets (see 006_sales.sql's own header comment), but a
-- foreign key to sales_territories(officer_code) makes that structurally
-- impossible — no '_company' row can ever exist there, so any INSERT with
-- officer_code='_company' always fails with a 23503 FK violation. Found by
-- pre-deployment review (2026-08-06), confirmed by reproducing the exact
-- failure against a live DB.
--
-- Fix: drop the FK. Per-officer targets are now validated at the
-- application layer instead (backend/routes/sales.js's POST /targets
-- checks officerCode is either '_company' or an existing active
-- sales_territories row before inserting) — a DB-level FK can't express
-- "this column is either X or a valid FK", so the integrity check moves
-- up a layer rather than being dropped.

ALTER TABLE sales_targets DROP CONSTRAINT IF EXISTS sales_targets_officer_code_fkey;
