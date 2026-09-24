-- 025: let a user be deleted without taking the audit trail hostage.
--
-- 024 declared report_revisions.actor_id and .prior_approved_by as plain
-- REFERENCES users(id) with no ON DELETE action, i.e. NO ACTION. That makes
-- the revision log *block* deleting any user who has ever touched a report:
--
--   update or delete on table "users" violates foreign key constraint
--   "report_revisions_actor_id_fkey" on table "report_revisions"
--
-- Which is the wrong way round. An audit trail exists to outlive the people
-- in it. Refusing to delete a leaver because they filed a report in April is
-- not integrity, it is a hostage situation — and it breaks two real things:
-- admin-users.html's delete, and every acceptance suite, which creates
-- throwaway users and drops them in cleanup().
--
-- The name is not lost when the id goes. 024 already stores actor_name as
-- plain text alongside actor_id, precisely because some writers (the Odoo
-- sync, cron jobs, migrations) have no users row at all. So SET NULL degrades
-- "user 41" to "Godhania Natha, account since removed", which is what an
-- auditor actually wants to read, rather than to a blocked DELETE.
--
-- audit_log has the same unqualified REFERENCES and gets away with it only
-- because every cleanup path happens to delete audit_log rows before users.
-- That is luck, not design; left alone here because changing it is a wider
-- blast radius than this migration's scope.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_revisions_actor_id_fkey') THEN
    ALTER TABLE report_revisions DROP CONSTRAINT report_revisions_actor_id_fkey;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_revisions_prior_approved_by_fkey') THEN
    ALTER TABLE report_revisions DROP CONSTRAINT report_revisions_prior_approved_by_fkey;
  END IF;
END $$;

ALTER TABLE report_revisions
  ADD CONSTRAINT report_revisions_actor_id_fkey
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE report_revisions
  ADD CONSTRAINT report_revisions_prior_approved_by_fkey
  FOREIGN KEY (prior_approved_by) REFERENCES users(id) ON DELETE SET NULL;
