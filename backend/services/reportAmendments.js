/*
  services/reportAmendments.js — correction requests for reports that have
  already been reported.

  The shape, in one paragraph. A report that is approved (or waiting in an
  HOD's queue) is locked: a submit or a Save Draft over it is refused with 409
  REPORT_LOCKED (routes/reports.js). A person who finds a mistake asks for a
  CORRECTION with a written reason; someone other than the requester GRANTS it,
  which opens a time-boxed WINDOW in which the report can be edited and
  resubmitted; the resubmission re-enters approval like any other. Every step
  is an audit_log row, and the report's figures at the moment of the grant are
  snapshotted into report_revisions so the whole thing is reversible.

  The choice that matters: a grant does NOT change daily_reports.status. See
  migrations/027_report_amendments.sql for why — in short, an 'amending' status
  would either lie about "approved" or blank the day from every KPI, the MIS
  pack, entry completeness and the watchdog.

  This file is the rules and the queries; routes/amendments.js is the HTTP
  surface and routes/reports.js is where a granted window is honoured on write.
  The pure functions (no database) are at the top so test/report-amendments
  .test.js can pin them exactly.
*/

const db = require('../db');
const { changedFields, recordRevision } = require('./reportRevisions');

/* ── Vocabulary ──────────────────────────────────────────────────────── */

const OPEN_STATUSES = ['requested', 'granted'];

/* Statuses a report must be in for a correction to make sense. 'draft' and
   'rejected' are already editable by design — the existing reject-and-resubmit
   loop IS the correction path there, and a second one must not grow beside it. */
const LOCKED_STATUSES = ['approved', 'pending_approval'];

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 72;

const MIN_REASON_CHARS = 10;

/* ── Pure rules ──────────────────────────────────────────────────────── */

function isPrivileged(user) {
  return !!user && (user.role === 'admin' || user.role === 'md');
}

/* Is this amendment a live write window right now?

   The route layer asks the DATABASE (expires_at > NOW()) so the app server's
   clock can never disagree with the row it is comparing against; this is the
   same rule in JS, for the unit tests and for anything that already holds a
   row and a clock. */
function windowIsOpen(amendment, now = new Date()) {
  if (!amendment || amendment.status !== 'granted' || !amendment.expires_at) return false;
  return new Date(amendment.expires_at).getTime() > now.getTime();
}

/* SEPARATION OF DUTIES on a decision. Whoever asked for a correction never
   decides it — otherwise the lock is advisory, since the person who could
   sign a change off is the person who asked for it. admin/md are the
   exception: they are the escalation for exactly this case (an HOD who is the
   requester has nobody else at their own level to ask), the same carve-out
   kpi.js makes for reopening a closed month.

   Returns { ok: true } or { ok: false, code, error } — the route turns the
   latter into a 403 without re-deriving the wording. */
function mayDecide(amendment, user) {
  if (!amendment || !user) return { ok: false, code: 'NOT_FOUND', error: 'No such correction request.' };
  if (isPrivileged(user)) return { ok: true };
  if (amendment.requested_by != null && amendment.requested_by === user.id) {
    return {
      ok: false,
      code: 'SEPARATION_OF_DUTIES',
      error: 'You cannot decide your own correction request — another approver must. '
           + 'If you are the only approver for this form, ask an admin or the MD.',
    };
  }
  return { ok: true };
}

/* Who may withdraw a request that has not been decided: the person who made
   it, or an admin/md tidying up. */
function mayWithdraw(amendment, user) {
  if (!amendment || !user) return false;
  return isPrivileged(user) || (amendment.requested_by != null && amendment.requested_by === user.id);
}

/* A window length the route will accept, or null. Whole hours, 1..72; an
   omitted value is the default, never an error. */
function clampHours(hours) {
  if (hours === undefined || hours === null || hours === '') return DEFAULT_WINDOW_HOURS;
  const n = Number(hours);
  if (!Number.isInteger(n) || n < 1 || n > MAX_WINDOW_HOURS) return null;
  return n;
}

/* ── Queries ─────────────────────────────────────────────────────────────
   `q` is anything with .query(): the pool, or a transaction client. Passing
   the client is what lets the submit path read the window under the same row
   lock as the report it guards. */

const PRESENT_COLUMNS = `
  a.id, a.form_type, a.record_date, a.shift, a.status, a.reason, a.fields_flagged,
  a.requested_by, a.requested_by_name, a.requested_at, a.locked_status,
  a.decided_by, a.decided_by_name, a.decided_at, a.decision_note,
  a.expires_at, a.applied_at, a.baseline_revision_id, a.applied_revision_id,
  CASE WHEN a.status = 'granted'
       THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (a.expires_at - NOW()))))::int
  END AS seconds_left`;

/* seconds_left is computed by the DATABASE, relative to its own NOW(), so a
   browser can count down from it without ever comparing a server timestamp to
   its own clock — which, for a `timestamp without time zone`, is a comparison
   that is only right by coincidence of time zones. */

async function findOpen(q, { formType, date, shift = 'day' }) {
  const r = await q.query(
    `SELECT ${PRESENT_COLUMNS}
       FROM report_amendments a
      WHERE a.form_type = $1 AND a.record_date = $2 AND a.shift = $3
        AND a.status = ANY($4)
      LIMIT 1`,
    [formType, date, shift, OPEN_STATUSES]);
  return r.rows[0] || null;
}

/* The granted, unexpired window for a day — the one the write gates honour.
   With `lock: true` the row is FOR UPDATE, so two overlapping submits cannot
   both consume the same window. */
async function findActiveWindow(q, { formType, date, shift = 'day', lock = false }) {
  const r = await q.query(
    `SELECT a.*
       FROM report_amendments a
      WHERE a.form_type = $1 AND a.record_date = $2 AND a.shift = $3
        AND a.status = 'granted' AND a.expires_at > NOW()
      LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [formType, date, shift]);
  return r.rows[0] || null;
}

/* Did this day have a window that closed unused in the last day? Lets a 409
   say "your correction window closed" rather than the generic "already
   submitted". Only RECENT closures: a window that lapsed a fortnight ago says
   nothing useful about why a write is refused today, and would make every later
   lock error read as if the author had missed a deadline. An APPLIED window is
   not a closure — it did its job. */
async function lastClosedWindow(q, { formType, date, shift = 'day' }) {
  const r = await q.query(
    `SELECT a.id, a.status, a.expires_at
       FROM report_amendments a
      WHERE a.form_type = $1 AND a.record_date = $2 AND a.shift = $3
        AND (a.status = 'expired' OR (a.status = 'granted' AND a.expires_at <= NOW()))
        AND a.expires_at > NOW() - INTERVAL '24 hours'
      ORDER BY a.id DESC LIMIT 1`,
    [formType, date, shift]);
  return r.rows[0] || null;
}

/* ── The expiry sweeper ──────────────────────────────────────────────────
   Run by the watchdog every 15 minutes (services/watchdog.js).

   A window that closes with nothing resubmitted leaves whatever the author
   had autosaved sitting in an APPROVED report. That must never become the
   permanent record, so the sweeper restores the figures the report held when
   the window was granted.

   It does not destroy the half-typed work to do it: the revert is itself a
   report_revisions row whose pre-image is the half-corrected data, so anything
   the author typed is still recoverable by an admin. Nothing is reverted when
   nothing changed, and nothing is reverted for a window that was applied —
   applying moves the amendment out of 'granted', which is what the FOR UPDATE
   re-check below keys on.

   Lock order is the same as the submit path — the report row first, then the
   amendment — so the two cannot deadlock each other. */
async function sweepExpired() {
  const due = await db.query(
    `SELECT id, form_type, record_date, shift
       FROM report_amendments
      WHERE status = 'granted' AND expires_at <= NOW()
      ORDER BY id`);

  const done = [];
  for (const c of due.rows) {
    const outcome = await db.withTransaction(async (client) => {
      const rep = await client.query(
        `SELECT data, status, approved_by, approved_at
           FROM daily_reports
          WHERE form_type = $1 AND record_date = $2 AND shift = $3
          FOR UPDATE`,
        [c.form_type, c.record_date, c.shift]);

      const am = await client.query(
        `SELECT * FROM report_amendments
          WHERE id = $1 AND status = 'granted' AND expires_at <= NOW()
          FOR UPDATE`,
        [c.id]);
      if (!am.rows[0]) return null;          // applied, or already swept, since we looked
      const amendment = am.rows[0];

      let reverted = false;
      let baselineFound = false;
      if (rep.rows[0] && amendment.baseline_revision_id) {
        const base = await client.query(
          'SELECT prior_data FROM report_revisions WHERE id = $1', [amendment.baseline_revision_id]);
        const baseline = base.rows[0] && base.rows[0].prior_data;
        baselineFound = !!baseline;

        if (baseline && changedFields(baseline, rep.rows[0].data).length) {
          await recordRevision(client, {
            formType: c.form_type, recordDate: c.record_date, shift: c.shift,
            action: 'AMENDMENT_EXPIRE_REVERT',
            priorData:       rep.rows[0].data,              // the half-corrected figures, kept
            priorStatus:     rep.rows[0].status,
            priorApprovedBy: rep.rows[0].approved_by,
            priorApprovedAt: rep.rows[0].approved_at,
            changedFields:   changedFields(rep.rows[0].data, baseline),
            amendmentId:     amendment.id,
            actorId:         null,
            actorName:       'system',
            reason:          'Correction window expired with nothing resubmitted — restored the figures held when it was granted.',
          });
          await client.query(
            `UPDATE daily_reports SET data = $4::jsonb, updated_at = NOW()
              WHERE form_type = $1 AND record_date = $2 AND shift = $3`,
            [c.form_type, c.record_date, c.shift, JSON.stringify(baseline)]);
          reverted = true;
        }
      }

      await client.query(`UPDATE report_amendments SET status = 'expired' WHERE id = $1`, [amendment.id]);
      await client.query(
        `INSERT INTO audit_log (user_id, username, action, form_type, record_date, details)
         VALUES (NULL, 'system', 'REPORT_AMEND_EXPIRE', $1, $2, $3)`,
        [c.form_type, c.record_date,
         `Correction #${amendment.id} expired unused` +
         (reverted ? ' — restored the figures held at the grant; the half-corrected data is kept in report_revisions'
                   : (baselineFound ? ' — nothing had changed, nothing to restore' : ' — no baseline snapshot found, left as is'))]);

      return {
        id: amendment.id, formType: c.form_type, date: c.record_date, shift: c.shift,
        reverted, requestedBy: amendment.requested_by_name,
      };
    });
    if (outcome) done.push(outcome);
  }
  return done;
}

module.exports = {
  OPEN_STATUSES, LOCKED_STATUSES, DEFAULT_WINDOW_HOURS, MAX_WINDOW_HOURS, MIN_REASON_CHARS,
  isPrivileged, windowIsOpen, mayDecide, mayWithdraw, clampHours,
  PRESENT_COLUMNS, findOpen, findActiveWindow, lastClosedWindow, sweepExpired,
};
