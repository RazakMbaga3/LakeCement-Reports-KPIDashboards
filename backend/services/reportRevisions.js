/*
  services/reportRevisions.js — the append-only revision log for daily
  reports (table report_revisions, db/migrations/024_report_revisions.sql).

  audit_log already records that somebody changed a report. It cannot
  record what the report SAID before they did: routes/reports.js merges the
  new values straight over the stored JSONB, so the previous figures are
  gone from the database entirely. This module captures the PRE-IMAGE —
  the whole `data` blob plus the approval columns — immediately before each
  change, so "what number did this report carry on Tuesday" has an answer
  and a mangled day can be restored with one UPDATE.

  Three pieces, deliberately separated:

    shouldSnapshot()  — the anti-bloat rule. Pure.
    changedFields()   — what actually moved between two `data` blobs. Pure.
    recordRevision()  — the single INSERT. Takes a caller's transaction
                        client; imports no database of its own.

  Nothing here opens a connection or starts a transaction. A revision must
  land in the SAME transaction as the write it describes, or a transient
  error leaves a change with no history — the same reasoning that already
  puts the audit_log insert inside db.withTransaction in routes/reports.js.
  That is why every function takes the caller's `client`, and why this file
  does not require('../db') at all.
*/

const { REPORTED_STATUSES } = require('../config/forms');

/* Is this change worth a revision row?

   `prior` is the stored daily_reports row (or null if the day has no
   report yet); `next` is anything carrying the status about to be written.

     no prior row            -> YES. Revision 1 records that the report was
                                born, and from what (nothing).
     the status is changing  -> YES. draft->pending_approval, ->approved,
                                ->rejected: every one is a workflow event
                                somebody may later need to point at.
     the prior status was    -> YES, ALWAYS. This is the rule that matters.
     REPORTED (approved or      Once a report has been reported — fed to the
     pending_approval)          KPIs, quoted in the MIS pack, signed by an
                                HOD — nothing may overwrite it without a
                                pre-image, even a re-save that lands on the
                                same status it already had.
     draft -> draft          -> no. A person may press Save Draft twenty
                                times while filling a form in; twenty
                                identical-ish snapshots of half-typed work
                                is bloat that buys nothing. Nothing is lost:
                                the moment that draft becomes a real report,
                                the status changes and the rule above fires.

   (The form's UNATTENDED autosave never reaches here at all — it returns
   from the route before the transaction block. See the structural test in
   test/report-revisions.test.js, which enforces that it stays that way.) */
function shouldSnapshot(prior, next) {
  if (!prior) return true;
  const nextStatus = next && typeof next === 'object' ? next.status : next;
  if (prior.status !== nextStatus) return true;
  if (REPORTED_STATUSES.includes(prior.status)) return true;
  return false;
}

/* '' , null and undefined are the SAME thing in a report: "not filled in".
   The forms post every field they own on every save, blank ones included as
   '' (form-persist.js's _collect reads each input's value — see the merge
   note in routes/reports.js), while an importer or the Odoo sync omits a
   field entirely and a hand-written payload may send null. Treating those
   three as different would mark half the form as "changed" on every save. */
const BLANK = Symbol('blank');
function normalise(v) {
  return (v === '' || v === null || v === undefined) ? BLANK : v;
}

function sameValue(a, b) {
  const na = normalise(a), nb = normalise(b);
  if (na === BLANK || nb === BLANK) return na === nb;
  if (typeof na !== 'object' && typeof nb !== 'object') return na === nb;
  // Objects/arrays: a report field is only ever a value a form or an
  // importer put there, so structural equality by serialisation is enough.
  return JSON.stringify(na) === JSON.stringify(nb);
}

/* Which keys of `data` this write adds, removes or alters — sorted, so the
   stored array is stable and diffable between revisions.

   Underscore-prefixed keys are skipped: they are the forms' own bookkeeping
   (_savedAt and friends), not report content. routes/approvals.js:71 hides
   them from the approver for the same reason, and a revision list that said
   "changed: _savedAt" on every single save would bury the real changes.

   Note that `1` and `'1'` ARE a change: the stored JSONB really does differ,
   and for an audit trail a type-only false positive is far cheaper than a
   missed edit. */
function changedFields(priorData, nextData) {
  const a = priorData || {};
  const b = nextData || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter(k => !k.startsWith('_')));
  const out = [];
  for (const k of keys) {
    if (!sameValue(a[k], b[k])) out.push(k);
  }
  return out.sort();
}

/* Write one revision, inside the caller's transaction.

   `client` MUST be the same client that is performing the write this
   revision describes, and the caller MUST already hold the row lock
   (SELECT … FOR UPDATE on daily_reports, or an UPDATE that matched it).
   The revision number is allocated as MAX+1 under that lock, so two
   concurrent submits for the same day cannot both claim it; the table's
   UNIQUE (form_type, record_date, shift, revision) is the backstop that
   turns a lost race into a rolled-back transaction rather than a silently
   duplicated history entry.

   Every prior_* argument is the value BEFORE the change. prior_data is
   allowed — and expected — to be null for an action that does not touch
   `data` at all (approve, reject): a null there means "unchanged", not
   "unknown". */
async function recordRevision(client, {
  formType,
  recordDate,
  shift = 'day',
  action,
  priorData = null,
  priorStatus = null,
  priorApprovedBy = null,
  priorApprovedAt = null,
  changedFields: fields = [],
  amendmentId = null,
  actorId = null,
  actorName = null,
  reason = null,
  ipAddress = null,
}) {
  const result = await client.query(`
    INSERT INTO report_revisions (
      form_type, record_date, shift, revision, action,
      prior_data, prior_status, prior_approved_by, prior_approved_at,
      changed_fields, amendment_id, actor_id, actor_name, reason, ip_address)
    VALUES (
      $1::varchar, $2::date, $3::varchar,
      /* The casts above are load-bearing, not decoration. In an INSERT …
         VALUES list Postgres resolves a parameter's type from the target
         COLUMN — but a parameter reused inside a sub-SELECT in that same
         list is resolved independently, and defaults to text. $1/$2/$3
         appear in both places, so without the casts the planner deduces
         two different types for one parameter and refuses the statement
         outright: 42P08 "inconsistent types deduced for parameter $1 —
         text versus character varying". Every submit 500s. */
      (SELECT COALESCE(MAX(revision), 0) + 1 FROM report_revisions
        WHERE form_type = $1::varchar AND record_date = $2::date AND shift = $3::varchar),
      $4, $5::jsonb, $6, $7, $8, $9::text[], $10, $11, $12, $13, $14)
    RETURNING *
  `, [
    formType, recordDate, shift, action,
    priorData === null || priorData === undefined ? null : JSON.stringify(priorData),
    priorStatus, priorApprovedBy, priorApprovedAt,
    fields || [], amendmentId, actorId, actorName, reason, ipAddress,
  ]);
  return result.rows[0];
}

module.exports = { shouldSnapshot, changedFields, recordRevision };
