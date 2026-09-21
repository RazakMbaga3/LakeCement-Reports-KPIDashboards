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
     re-signed anything.
  B. A day Odoo has data for, that nobody has touched yet, is created as a
     'draft' — never 'approved' or 'pending_approval'. The officer still
     has to open it, add what Odoo cannot supply (run hours, receipts,
     opening stock) and submit it through the normal HOD approval step.
     This mirrors the officer/HOD workflow every other form already uses
     (routes/reports.js) rather than inventing a second one.
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
      `SELECT data FROM daily_reports WHERE form_type = $1 AND record_date = $2 AND shift = $3 FOR UPDATE`,
      [FORM_TYPE, date, SHIFT]);
    const row = existing.rows[0] || null;

    const { toWrite, overrides } = reconcileDay(row ? row.data : null, odooFields);

    let action = 'unchanged';
    if (Object.keys(toWrite).length && !dryRun) {
      if (!row) {
        await client.query(
          `INSERT INTO daily_reports (form_type, record_date, shift, data, status)
           VALUES ($1, $2, $3, $4::jsonb, 'draft')`,
          [FORM_TYPE, date, SHIFT, JSON.stringify(toWrite)]);
        action = 'created_draft';
      } else {
        // Only `data`/`updated_at` move. status/approved_by/approved_at/
        // submitted_by are untouched — see decision A in the header.
        await client.query(
          `UPDATE daily_reports SET data = data || $4::jsonb, updated_at = NOW()
           WHERE form_type = $1 AND record_date = $2 AND shift = $3`,
          [FORM_TYPE, date, SHIFT, JSON.stringify(toWrite)]);
        action = overrides.length ? 'overrode' : 'filled_blanks';
      }

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
      action = row ? (overrides.length ? 'would_override' : 'would_fill_blanks') : 'would_create_draft';
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
    if (r.action === 'created_draft' || r.action === 'would_create_draft') summary.created++;
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
