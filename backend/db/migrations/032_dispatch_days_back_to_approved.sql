-- 032_dispatch_days_back_to_approved.sql
--
-- Puts the Dispatch & Sales Orders dashboard back on screen.
--
-- Migration 030 moved every Odoo-synced dispatch day to 'draft' so the
-- packing plant could enter the half of the report Odoo cannot supply (SO
-- Pendency, Bags Packed, Burst Bag Rate, the 8 AM vehicle queue). It worked
-- for data entry and broke the thing management actually looks at: 'draft'
-- is outside REPORTED_STATUSES (config/forms.js), so dispatch.html counted
-- none of these days and showed
--
--     "A draft exists for 01 Sept 2026, but it has not been submitted"
--
-- in place of the plant's own figures — on all 211 days, i.e. every date
-- there was.
--
-- The mistake was treating `status` as the record of whether a report had
-- been signed. It is not; `approved_by` is. routes/reports.js now tests
-- approved_by rather than status, so an ERP-written row (approved_by IS
-- NULL) carries no human signature to protect and stays writable, while a
-- day a person approves locks exactly as before. That removes the reason
-- 030 existed, so these days can hold the status that is actually true of
-- them: Odoo approved this data.
--
-- Net effect for the plant: the dashboard reads live again AND the packing
-- plant can still add their manual figures on top. Both, not either.
--
-- Safe on the same grounds as 029/030: every row this touches is
-- robot-written. The WHERE clause re-asserts that per row, so a day a person
-- has since submitted, edited or signed keeps its own status untouched.

BEGIN;

UPDATE daily_reports
   SET status = 'approved'
 WHERE form_type    = 'dispatch'
   AND status       = 'draft'
   AND approved_by  IS NULL      -- never signed by a person
   AND submitted_by IS NULL      -- never submitted by a person
   AND updated_by   IS NULL;     -- never edited by a person

COMMIT;
