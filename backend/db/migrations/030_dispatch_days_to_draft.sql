-- 030_dispatch_days_to_draft.sql
--
-- Finishes what 029 started, and corrects it.
--
-- 029 moved the Odoo-written dispatch days from 'approved' to
-- 'pending_approval' to reopen the form for manual entry. That did not
-- actually unlock them: routes/reports.js:285 refuses a submit over EITHER
-- 'approved' or 'pending_approval' —
--
--     const lockedStatus =
--       prior && (prior.status === 'approved' || prior.status === 'pending_approval')
--
-- so the report stayed locked on every date and the four manual-only cards
-- (SO Pendency, Bags Packed, Burst Bag Rate, the 8 AM vehicle queue) would
-- have stayed empty. 'draft' is the only status that leaves a day writable.
--
-- 'draft' is also the answer services/odooProductionAutofill.js already
-- reached for the same problem (decision B, 2026-09-21): a day Odoo has data
-- for, that nobody has touched, is a draft the officer opens, completes and
-- submits through the normal HOD approval step. services/odooDispatchSync.js
-- now inserts new days the same way, so there is one autofill workflow in
-- this codebase rather than two.
--
-- KNOWN AND DELIBERATE COST: 'draft' is not in REPORTED_STATUSES
-- (config/forms.js), so these days stop counting in the KPI engine, the MIS
-- pack and Entry Completeness until an officer submits them. That is the
-- same bargain the Production autofill already makes. The alternative is a
-- report that presents itself as signed off while half its fields were never
-- filled and no one could ever fill them.
--
-- Still safe on the same grounds as 029: every row this touches is
-- robot-written. The WHERE clause re-asserts that per row, so any day a
-- person has since submitted or signed keeps its status untouched.

BEGIN;

UPDATE daily_reports
   SET status = 'draft'
 WHERE form_type    = 'dispatch'
   AND status       = 'pending_approval'
   AND approved_by  IS NULL      -- never signed by a person
   AND submitted_by IS NULL      -- never submitted by a person
   AND updated_by   IS NULL;     -- never edited by a person

COMMIT;
