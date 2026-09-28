-- 029_unlock_odoo_dispatch_days.sql
--
-- Reopens the Dispatch & SO report for manual entry.
--
-- services/odooDispatchSync.js inserted every day it pulled as 'approved'.
-- That was a reasonable call when written — an ERP figure is reported data,
-- not a draft, and a 'draft' would have been invisible to the KPI engine and
-- the MIS pack (REPORTED_STATUSES in config/forms.js). It then collided with
-- the write-lock added 2026-09-24: routes/reports.js refuses any submit over
-- an 'approved' report with code REPORT_LOCKED.
--
-- Because the sync touches EVERY dispatch date, the combination pre-approved
-- all 208 stored days, and the half of the report Odoo cannot supply — SO
-- Pendency, Bags Packed, Burst Bag Rate, the 8 AM vehicle queue — became
-- impossible for anyone to enter. Those four cards read "No data" on the
-- review page not because nobody had bothered, but because the form refused
-- every attempt. Zero dispatch rows have ever had a human submitter.
--
-- The sync now writes 'pending_approval' for new days (see upsertDay()).
-- This migration brings the already-written days to the same state.
--
-- Safe because none of these rows was ever touched by a person: at the time
-- of writing all 208 have approved_by IS NULL, submitted_by IS NULL and
-- updated_by IS NULL. The WHERE clause re-asserts that per row rather than
-- trusting the snapshot, so any day a human HAS since signed keeps its
-- approval and is left exactly as it is.
--
-- 'pending_approval' is in REPORTED_STATUSES, so every figure these rows
-- carry keeps counting in the KPI engine, the MIS pack and Entry
-- Completeness exactly as before — this changes writability, not visibility.

BEGIN;

UPDATE daily_reports
   SET status = 'pending_approval'
 WHERE form_type    = 'dispatch'
   AND status       = 'approved'
   AND approved_by  IS NULL      -- never signed by a person
   AND submitted_by IS NULL      -- never submitted by a person
   AND updated_by   IS NULL;     -- never edited by a person

COMMIT;
