/*
  ⚠ SPENT / DO NOT RE-RUN WITHOUT READING THIS (2026-10-14).
  This script's target status, 'pending_approval', is no longer where
  machine-filled days belong. DEC-012 (2026-10-14) moved the Odoo autofill
  writers to 'approved' with approved_by IS NULL, because parking robot rows
  in the HOD queue filled it with 143 machine-filled reports against zero
  human ones and buried the real submissions. Re-running this would put
  untouched Odoo drafts straight back into that queue.

  As of 2026-10-14 there are NO 'draft' rows left for it to act on, so it is
  a no-op; it is kept for the audit trail of the 2026-09-23 remediation. If a
  future backlog of untouched Odoo drafts ever needs clearing, change the
  target status to 'approved' (approved_by left NULL) to match DEC-012 —
  both statuses count in REPORTED_STATUSES, so the KPI effect is identical.
  The original rationale follows, unchanged.

  scripts/queue-production-backlog.js — one-time remediation for the
  2026-09-23 finding (docs/pm/RAID_LOG.md, R-1 investigation): 78 days of
  the daily Production report (2026-07-01..2026-09-22 in the dev DB; the
  droplet's own count may differ) sat as 'draft' — real Odoo-sourced
  figures already landed by odooProductionAutofill.js, but never reviewed
  or submitted by anyone, so they never counted toward the KPI dashboard
  (formulaEngine.js / insights.js / misReport.js all gate on
  REPORTED_STATUSES = ['approved','pending_approval'] — drafts don't
  qualify, by the autofill's own explicit design: "a day Odoo has data
  for, that nobody has touched yet, is created as a 'draft' ... the
  officer still has to open it, add what Odoo cannot supply (run hours,
  receipts, opening stock) and submit it" (odooProductionAutofill.js
  header, decision B).

  This does NOT approve anything and does NOT pretend a human submitted
  it. It moves each untouched draft to 'pending_approval' — the same
  queue a real Officer/Senior submission lands in — so a HOD sees it in
  the normal Approvals screen instead of the backlog requiring someone
  to first notice, open, and manually "submit" each of 78 days one at a
  time before it can even be reviewed. The Officer's remaining step
  (adding run hours/receipts/opening stock, if that department wants
  those figures on record) still has to happen — this script does not
  invent them — and the HOD approving still has to actually look at the
  numbers; it just gets them into the queue.

  Deliberately scoped to rows with NO human fingerprint at all
  (submitted_by IS NULL AND updated_by IS NULL) — anything a person has
  already started reviewing is left alone, exactly as it was.

  Usage:
    node scripts/queue-production-backlog.js            (dry run — lists what WOULD change)
    node scripts/queue-production-backlog.js --apply     (actually queues them)
*/
require('../config/env');
const db = require('../db');

const apply = process.argv.includes('--apply');

(async () => {
  try {
    const candidates = await db.query(`
      SELECT id, record_date::text AS record_date
      FROM daily_reports
      WHERE form_type = 'production' AND status = 'draft'
        AND submitted_by IS NULL AND updated_by IS NULL
      ORDER BY record_date
    `);

    if (!candidates.rows.length) {
      console.log('No untouched production drafts found — nothing to queue.');
      process.exit(0);
    }

    console.log(`Found ${candidates.rows.length} untouched production draft(s): `
      + `${candidates.rows[0].record_date} .. ${candidates.rows[candidates.rows.length - 1].record_date}`);

    if (!apply) {
      console.log('\nDRY RUN — no changes made. Re-run with --apply to actually queue these for HOD review.');
      console.log(candidates.rows.map(r => r.record_date).join(', '));
      process.exit(0);
    }

    let queued = 0;
    for (const { record_date } of candidates.rows) {
      await db.withTransaction(async (client) => {
        const result = await client.query(`
          UPDATE daily_reports
          SET status = 'pending_approval', updated_at = NOW()
          WHERE form_type = 'production' AND record_date = $1 AND status = 'draft'
            AND submitted_by IS NULL AND updated_by IS NULL
          RETURNING id
        `, [record_date]);
        if (!result.rows.length) return; // raced with something else — skip, don't force it

        await client.query(
          `INSERT INTO audit_log (user_id, username, action, form_type, record_date, details)
           VALUES (NULL, 'system:queue-production-backlog', 'PRODUCTION_BACKLOG_QUEUED', 'production', $1, $2)`,
          [record_date,
           'Moved draft -> pending_approval: pure Odoo-autofill data, never touched by a human, part of the '
           + '2026-07-01..2026-09-22 backlog found 2026-09-23 (RAID R-1 investigation). Not approved — an HOD '
           + 'still needs to review and approve/reject. See odooProductionAutofill.js decision B.']
        );
        queued++;
      });
    }

    console.log(`\nQueued ${queued} day(s) for HOD review (status: draft -> pending_approval).`);
    console.log('Nothing was approved. Whoever approves Production reports should now see these in Approvals.');
    process.exit(0);
  } catch (err) {
    console.error('QUEUE_PRODUCTION_BACKLOG_FAILED ' + err.message);
    process.exit(1);
  }
})();
