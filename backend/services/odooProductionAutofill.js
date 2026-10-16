/*
  services/odooProductionAutofill.js — Phase 3 of the Odoo Production
  Autofill plan: writes odoo_production_entries (the mirror Phase 1 built —
  see odooProductionSync.js) into daily_reports (form_type='production'),
  so the officer opens a form that already has Odoo's numbers instead of
  retyping them.

  Three decisions (Razak, 2026-09-21) shape everything below:

  A. Odoo is the source of record for the fields it owns. If a value already
     stored differs from what Odoo now says, Odoo's value wins — but the
     overwrite is logged to production_odoo_overrides first, because a
     number that changes with no trace looks like corruption to whoever
     notices. This applies to a day in ANY status, including 'approved' —
     an approved report's stored data can be corrected in place. What it
     never does is touch that report's status/approved_by/approved_at: a
     correction is not a re-approval, and this must never look like a human
     re-signed anything. Since 2026-09-24 each such write also lands in
     report_revisions as an ODOO_AUTOFILL row, so the robot's corrections
     sit in the same history as a person's — see upsertDay().
  B. (SUPERSEDED 2026-10-07 — see B′ below.) A day Odoo has data for, that
     nobody has touched yet, was created as a 'draft' — never 'approved' or
     'pending_approval'. The officer still had to open it, add what Odoo
     cannot supply (run hours, receipts, opening stock) and submit it
     through the normal HOD approval step.

  B″. (2026-10-14, see DEC-012) A day Odoo filled that NO HUMAN HAS TOUCHED
     is created as 'approved' with approved_by IS NULL — the shape
     odooDispatchSync.js has used since DEC-008. B′ (below) was right that
     the day must count and wrong about where to park it: 'pending_approval'
     put the robot's rows in the HOD's approval queue, and this writer walks
     every day Odoo has, so the queue became 143 machine-filled rows against
     zero human ones. See the INSERT in upsertDay() for the full reasoning.
     approved_by stays NULL, so nothing here claims a human signed and the
     DEC-008 write-lock still leaves the day correctable.

  B′. (Razak, 2026-10-07 — SUPERSEDED by B″ above, kept because its
     diagnosis stands and only the status changed.) A day Odoo filled that
     NO HUMAN HAS TOUCHED is
     created as 'pending_approval', not 'draft', so its figures count
     immediately. The reasoning that replaced B: these entries are already
     approved in Odoo by the plant's own people before the API ever returns
     them, so requiring a second, local approval of the same numbers was
     asking the same question twice. In practice the backlog it created was
     the whole problem — 85 days queued at once on 2026-09-29, and the
     Production Report screen reading "No data" while real tonnage sat in
     the table, because 'draft' is not in REPORTED_STATUSES
     (config/forms.js) and no KPI counts it.

     What this deliberately does NOT do:
       - It does not mark anything 'approved'. 'pending_approval' is in
         REPORTED_STATUSES, so the figures count, but the day still appears
         in the HOD's queue and a human can still approve or reject it.
         Nothing here claims a person signed off.
       - It does not touch a day a human has started (submitted_by or
         updated_by set) — same no-human-fingerprint test
         scripts/queue-production-backlog.js already uses. An officer's own
         draft stays a draft.
       - It does not change the status of any EXISTING row, in any status.
         Only the INSERT of a brand-new day is affected. A correction to an
         already-stored day still moves data alone (decision A).

     The officer's remaining job is unchanged: open the day and add what
     Odoo cannot supply. The difference is that Odoo's 24 fields are
     readable by everyone with Production access from the moment they land,
     instead of waiting on an approval of numbers Odoo already approved.
  C. Odoo reports Raw Meal as one combined stream; the form has mill-level
     rm1_prod_mt/rm2_prod_mt (and a kiln-feed rm1_cons_mt with no rm2
     counterpart). Forcing a combined number into a mill-specific field
     would misattribute it, so it lands in two NEW keys instead —
     raw_meal_prod_mt and raw_meal_cons_mt — that daily-report.html does
     not render yet. They are written into the JSONB regardless (the column
     is schemaless, and a form is free to carry keys no input reads yet —
     see routes/reports.js's submitBody comment), ready for the one
     remaining UI step: adding those two inputs and the "from Odoo" badge
     this plan's doc describes for Phase 3's front end. Deliberately not
     done here — daily-report.html has another session's uncommitted edits
     in flight, and editing it now risks colliding with that work.

  Odoo's own two-word summary — "raw meal" — is genuinely one thing to
  Odoo and two things (RM1, RM2) to the plant; the new field names spell
  that out rather than picking a mill to blame the whole number on.
*/

const db     = require('../db');
const logger = require('./logger');
const { recordRevision } = require('./reportRevisions');
const { pullProductionEntries, loadRangeFacts } = require('./odooProductionSync');

const FORM_TYPE = 'production';
const SHIFT     = 'day';

// mapDay() rounds to 2dp (see odooProductionMapper.js's r2()); half a
// hundredth of a tonne is float noise, not a real disagreement worth logging.
const EQUAL_TOLERANCE = 0.005;

/* dayResult (mapDay's output) -> { field: value } for every field this
   autofill is allowed to write. `facts` is Phase 1's own "verified, safe to
   prefill" bucket, used as-is. The two Raw Meal keys are decision C's
   resolution of `extras`/`provisional`, renamed here rather than in
   odooProductionMapper.js so Phase 1's own tests and its "every emittable
   fact is a real form field" guardrail stay exactly as that phase left
   them — this file, not the mapper, owns the decision that these two are
   allowed to exist without a form field yet. */
function odooFieldsFor(dayResult) {
  const out = { ...dayResult.facts };
  if ('raw_meal_prod_mt' in dayResult.extras) out.raw_meal_prod_mt = dayResult.extras.raw_meal_prod_mt;
  if ('rm1_cons_mt' in dayResult.provisional) out.raw_meal_cons_mt = dayResult.provisional.rm1_cons_mt;
  return out;
}

function asNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* Pure — no I/O, unit-tested directly. existingData is the stored `data`
   JSONB (or null/undefined for a day with no report yet); odooFields is
   this day's odooFieldsFor() output. Returns exactly what changes: nothing
   is written for a field whose stored value already matches Odoo's,
   whether that match is because a human typed the same number or because
   this is a re-run of an earlier autofill. */
function reconcileDay(existingData, odooFields) {
  const toWrite = {};
  const overrides = [];
  for (const [field, odooValue] of Object.entries(odooFields)) {
    const previous = existingData ? asNumber(existingData[field]) : null;
    if (previous === null) {
      toWrite[field] = odooValue;
    } else if (Math.abs(previous - odooValue) > EQUAL_TOLERANCE) {
      toWrite[field] = odooValue;
      overrides.push({ field, previous_value: previous, odoo_value: odooValue });
    }
  }
  return { toWrite, overrides };
}

/* One day -> one transaction: read the current row, decide what changes,
   write it, log any overrides. FOR UPDATE serialises against a concurrent
   officer save for the same (form_type, date, shift) row — the same
   protection odooDispatchSync.js's header describes wanting and gets for
   free here from the transaction instead. dryRun runs the same read-and-
   decide path and rolls back, so a preview can never diverge from what a
   real run would do. */
async function upsertDay(date, dayResult, { dryRun = false } = {}) {
  const odooFields = odooFieldsFor(dayResult);
  if (!Object.keys(odooFields).length) return { action: 'no_fields', fieldsWritten: 0, overrides: 0 };

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT data, status, approved_by, approved_at
       FROM daily_reports WHERE form_type = $1 AND record_date = $2 AND shift = $3 FOR UPDATE`,
      [FORM_TYPE, date, SHIFT]);
    const row = existing.rows[0] || null;

    const { toWrite, overrides } = reconcileDay(row ? row.data : null, odooFields);

    let action = 'unchanged';
    if (Object.keys(toWrite).length && !dryRun) {
      if (!row) {
        /* 'approved' with approved_by IS NULL — decision B″ (2026-10-14),
           replacing B′'s 'pending_approval'. This is the SAME shape
           odooDispatchSync.js has used since DEC-008, not a new convention.

           B′ was right that the day must COUNT (so 'draft' is wrong: it is
           outside REPORTED_STATUSES and left the Production Report reading
           "No data" over real tonnage). It was wrong about where to park it.
           'pending_approval' put the robot's rows in the HOD's approval
           queue, and because this writer walks every day Odoo has, the queue
           filled with them: on 2026-10-14 it held 143 machine-filled rows
           (99 production + 44 materials) and ZERO human ones. An officer's
           own CPP report was reported "missing" because it was row 138 of
           138 under them. A queue of 143 items no human wrote and nobody
           needs to read trains HODs to ignore the queue, which destroys the
           control the queue exists to be.

           'approved' here is a statement about the DATA, not about a person:
           these entries are approved in Odoo by the plant's own people
           before the API returns them. approved_by stays NULL, which is the
           truth — nobody signed locally — and that NULL is load-bearing:
             • the write-lock keys on approved_by (DEC-008,
               routes/reports.js), so an HOD or officer can still open and
               correct an Odoo day with no correction window needed;
             • the audit trail reads 'odoo-sync' / actorId NULL on the
               ODOO_AUTOFILL revision below, so the row can never be
               mistaken for a human approval.
           Both 'approved' and 'pending_approval' are already in
           REPORTED_STATUSES (config/forms.js), so NO KPI, MIS or entry-
           completeness figure moves — verified by a full day x formula
           replay (7,264 evaluations, 0 diffs).

           This deliberately does NOT widen what counts as approved for a
           human-signed report: nothing sets approved_by, so the lock's
           humanSigned test is untouched. */
        await client.query(
          `INSERT INTO daily_reports (form_type, record_date, shift, data, status)
           VALUES ($1, $2, $3, $4::jsonb, 'approved')`,
          [FORM_TYPE, date, SHIFT, JSON.stringify(toWrite)]);
        action = 'created_approved';
      } else {
        // Only `data`/`updated_at` move. status/approved_by/approved_at/
        // submitted_by are untouched — see decision A in the header.
        await client.query(
          `UPDATE daily_reports SET data = data || $4::jsonb, updated_at = NOW()
           WHERE form_type = $1 AND record_date = $2 AND shift = $3`,
          [FORM_TYPE, date, SHIFT, JSON.stringify(toWrite)]);
        action = overrides.length ? 'overrode' : 'filled_blanks';
      }

      /* The general revision log (services/reportRevisions.js), written
         from the pre-image already read above — zero extra queries, since
         `row` is the FOR UPDATE'd row itself.

         This writer deliberately BYPASSES routes/reports.js: it writes
         daily_reports directly, which is why decision A can correct an
         already-'approved' day and why the route's REPORT_LOCKED check
         does not apply to it. That is exactly why the revision matters
         here — otherwise "why did this number change" has one answer for
         humans and a different table for the robot. production_odoo_
         overrides stays as it is: it is field-level and Odoo-specific
         (which entry refs, what the old number was); this is the general
         record that puts the robot's edits in the same history as
         everyone else's.

         Only written when something actually changed. The nightly cron
         re-walks a whole range every run, and logging "nothing changed"
         for every day of it would be precisely the bloat shouldSnapshot()
         exists to prevent. */
      await recordRevision(client, {
        formType: FORM_TYPE, recordDate: date, shift: SHIFT, action: 'ODOO_AUTOFILL',
        priorData:       row ? row.data : null,
        priorStatus:     row ? row.status : null,
        priorApprovedBy: row ? row.approved_by : null,
        priorApprovedAt: row ? row.approved_at : null,
        changedFields:   Object.keys(toWrite).sort(),
        actorId:         null,             // no human did this
        actorName:       'odoo-sync',
        reason:          dayResult.refs.length ? `Odoo entries: ${dayResult.refs.join(',')}` : null,
      });

      if (overrides.length) {
        const refs = dayResult.refs.join(',');
        const values = [];
        const tuples = overrides.map((o, i) => {
          values.push(date, o.field, o.previous_value, o.odoo_value, refs);
          const b = i * 5;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
        });
        await client.query(
          `INSERT INTO production_odoo_overrides (record_date, field, previous_value, odoo_value, entry_refs)
           VALUES ${tuples.join(',')}`,
          values);
      }
    } else if (Object.keys(toWrite).length && dryRun) {
      action = row ? (overrides.length ? 'would_override' : 'would_fill_blanks') : 'would_create_pending';
    }

    if (dryRun) await client.query('ROLLBACK');
    else await client.query('COMMIT');

    return { action, fieldsWritten: Object.keys(toWrite).length, overrides: overrides.length, overrideDetail: overrides };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* the original error is what matters */ });
    throw err;
  } finally {
    client.release();
  }
}

/* [from, to] inclusive -> every day the mirror has an entry for gets
   reconciled against daily_reports. Skips nothing: a day already
   'approved' is corrected exactly like a 'draft' one (decision A) — the
   only difference is whether creating a NEW row is possible at all (it
   is not, since there is no report yet to have a status). */
async function syncProductionRangeToReports(from, to, { dryRun = false } = {}) {
  const byDay = await loadRangeFacts(from, to);
  const dates = Object.keys(byDay).sort();

  const summary = {
    from, to, days: dates.length, dryRun,
    created: 0, updated: 0, unchanged: 0,
    fieldsWritten: 0, overrides: 0, overrideDays: [],
  };

  for (const date of dates) {
    const r = await upsertDay(date, byDay[date], { dryRun });
    if (r.action === 'created_approved' || r.action === 'created_pending' || r.action === 'would_create_pending') summary.created++;
    else if (r.action === 'overrode' || r.action === 'filled_blanks'
           || r.action === 'would_override' || r.action === 'would_fill_blanks') summary.updated++;
    else summary.unchanged++;
    summary.fieldsWritten += r.fieldsWritten;
    summary.overrides += r.overrides;
    if (r.overrides) summary.overrideDays.push({ date, overrides: r.overrideDetail });
  }

  if (summary.overrides) {
    logger.warn({ count: summary.overrides, days: summary.overrideDays, dryRun },
      dryRun
        ? 'odoo production autofill (dry run): would overwrite previously-stored production value(s) — nothing was written'
        : 'odoo production autofill: overwrote previously-stored production value(s) — see production_odoo_overrides for detail');
  }
  return summary;
}

/* The single entry point every caller (CLI, Monitor route, the nightly
   cron) uses: refresh the mirror, then reconcile it into daily_reports.
   Two summaries, not merged, because they answer different questions —
   "what did Odoo send" vs "what changed for the officer". */
async function pullAndAutofillProduction(from, to, { dryRun = false } = {}) {
  const pull = await pullProductionEntries(from, to);
  const autofill = await syncProductionRangeToReports(from, to, { dryRun });
  return {
    pull, autofill,
    // Flat aliases so odooSync.js's generic "did anything get dropped"
    // check (which reads these two names on every pull's result) sees this
    // one too, without needing a production-specific branch there.
    rowsRejected: pull.rejected,
    rowsUnmapped: Object.keys(pull.unmappedPickingTypes).length,
  };
}

module.exports = {
  odooFieldsFor, reconcileDay, upsertDay,
  syncProductionRangeToReports, pullAndAutofillProduction,
};
