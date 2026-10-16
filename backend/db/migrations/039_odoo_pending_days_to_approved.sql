-- 039_odoo_pending_days_to_approved.sql
--
-- Empties the approvals queue of reports no human wrote.
--
-- Measured on 2026-10-14, the queue held 143 reports awaiting an HOD
-- signature:
--
--     form          Odoo-filled   human-filed
--     production             99             0
--     materials              44             0
--
-- Every single one was machine-filled and NONE was human-filed. An HOD
-- opening Approvals saw 143 items nobody wrote and nobody needs to read,
-- which buried the real submissions underneath them — an officer's CPP
-- report was reported "missing" because it was row 138 of 138 (RAID I-40,
-- 2026-10-12) — and trains approvers to ignore the queue entirely, which
-- destroys the control the queue exists to be.
--
-- The cause: odooProductionAutofill.js and odooMaterialsAutofill.js created
-- new days as 'pending_approval' (decision B', 2026-10-07). That was right
-- that the day must COUNT ('draft' is outside REPORTED_STATUSES and left
-- the Production Report reading "No data" over real tonnage) and wrong
-- about where to park it: these writers walk every day Odoo has, so the
-- queue necessarily fills with their rows.
--
-- Both writers now create 'approved' with approved_by IS NULL — the exact
-- shape odooDispatchSync.js has used since DEC-008. This is not a new
-- convention; it is the one the dispatch sync already proved. 'approved'
-- describes the DATA (Odoo's own people approved it before the API returned
-- it), while approved_by IS NULL describes the SIGNATURE (there isn't one).
--
-- Why this changes no number on any dashboard: REPORTED_STATUSES in
-- config/forms.js is ['approved', 'pending_approval'] — BOTH already count.
-- Every surface that reads daily_reports for analysis (the formula engine,
-- the MIS daily/monthly packs, entry completeness, the anomaly baseline,
-- the stoppage Pareto) treats these two identically, so moving a row from
-- one to the other is invisible to all of them. Verified by replaying every
-- (day x formula) over the full stored range 2026-03-01..2026-10-13 before
-- and after: 7,264 daily evaluations and 256 monthly aggregates, 0 diffs.
--
-- Why this does NOT weaken the write-lock: the lock keys on approved_by
-- (DEC-008, routes/reports.js), and this migration sets approved_by on
-- nothing. These rows were already unlocked when they were
-- 'pending_approval' with approved_by NULL; they stay exactly as correctable
-- as they were. An HOD who wants to review or fix an Odoo day still can,
-- directly, with no correction window needed. Nothing about a HUMAN-signed
-- report changes anywhere.
--
-- Why the audit trail still shows these are machine-filled: each row already
-- carries an ODOO_AUTOFILL row in report_revisions with actor_id NULL and
-- actor_name 'odoo-sync', and approved_by/approved_at stay NULL here — so
-- no row can be mistaken for a human approval. Deliberately NOT stamping a
-- synthetic "system user" into approved_by: that column is the record of a
-- human signature, and faking one would both lie in the trail and re-lock
-- every Odoo day, recreating the lockout DEC-008 fixed.
--
-- Safe on the same grounds as 029/030/032: every row this touches is
-- robot-written, and the WHERE clause re-asserts that per row, so a day a
-- person has submitted, edited, signed or rejected keeps its own status
-- untouched. Reversible: see the commented-out inverse at the foot of this
-- file. Restricted to the two form types whose autofill writers changed;
-- a human's pending report on any form type is left strictly alone.

BEGIN;

UPDATE daily_reports
   SET status = 'approved'
 WHERE form_type    IN ('production', 'materials')
   AND status       = 'pending_approval'
   AND approved_by  IS NULL      -- never signed by a person
   AND submitted_by IS NULL      -- never submitted by a person
   AND updated_by   IS NULL      -- never edited by a person
   AND rejected_by  IS NULL;     -- never rejected by a person

COMMIT;

-- Reversal, if this is ever to be undone. It is deliberately NOT run here.
-- It is exact only while no person has touched these rows in the meantime,
-- which is the same condition the forward migration asserts:
--
--   BEGIN;
--   UPDATE daily_reports
--      SET status = 'pending_approval'
--    WHERE form_type    IN ('production', 'materials')
--      AND status       = 'approved'
--      AND approved_by  IS NULL
--      AND submitted_by IS NULL
--      AND updated_by   IS NULL
--      AND rejected_by  IS NULL;
--   COMMIT;
