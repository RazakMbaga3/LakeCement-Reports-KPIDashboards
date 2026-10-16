/*
  services/odooCppAutofill.js — writes Odoo's Captive Power Plant entries
  (cpp_entry, read straight from Odoo's database through services/odooDb.js)
  into daily_reports (form_type='cpp'), so the CPP daily report carries the
  day's generation, steam, water, coal and fly-ash figures without anyone
  retyping them.

  ── Why this exists ─────────────────────────────────────────────────────
  On 2026-10-15 the dashboard's CPP report stopped at 2026-09-20: Jul–Sep
  had been keyed from the plant's FRM-LCL-PP-06 workbooks (migrations 020 +
  023) and nothing had been entered since, while Odoo's cpp_entry held every
  day up to the day before. No Odoo report URL carries CPP data, so this is
  the first pull built on the direct read-only database login.

  Every field this writes was verified against those 77 workbook days before
  it was allowed in — config/odooCppMap.js carries the per-field match
  counts and the reasoning for each one that is not a clean 77/77.

  ── Which Odoo rows count ───────────────────────────────────────────────
  state = 'complete' only. Odoo also keeps draft rows (an all-zero 'New #'
  for the day being entered, or a second draft beside a finished entry —
  2026-09-28 has both) and cancelled ones (2026-10-01 has a cancelled
  174,000 kWh entry beside the complete 167,100 one). All 1,275 complete rows
  are also approval_status 'approved' in Odoo, i.e. signed off by the plant's
  own CPP approvers before this ever reads them.

  Two complete rows on one date (it happened three times in 2023) is
  ambiguous — picking either would be a guess — so such a day is skipped and
  reported, never written.

  ── The write convention: the same as the other Odoo autofills ──────────
  (odooProductionAutofill.js / odooMaterialsAutofill.js, decision B″.)
    • A day nobody has a report for is CREATED as 'approved' with
      approved_by IS NULL: approved in Odoo already, counted on every
      surface at once (REPORTED_STATUSES), never parked in the HOD's queue,
      and still correctable without a correction window because the
      write-lock (DEC-008) keys on approved_by.
    • A day a HUMAN has touched — submitted_by, updated_by, approved_by or
      rejected_by set — is never written at all. That covers the 168 seeded
      days (submitted and approved by the 'cpp' user) and any day an officer
      opens and saves later. If Odoo disagrees with a human day the
      difference is reported, not applied: the officer's report is theirs.
    • On a day this writer created, a field is written only when Odoo's value
      differs from what is stored — so a repeat run over a quiet window
      writes nothing and records no revision. An entry edited in Odoo after
      approval flows through on the next run, recorded as an ODOO_AUTOFILL
      revision like every other robot write.
    • Never a fabricated zero: lab readings Odoo leaves at 0 are omitted, and
      an all-zero "complete" entry is treated as empty (see odooCppMap.js).

  ── Skips cleanly when the database login isn't configured ──────────────
  The production droplet has no ODOO_PG_* yet. pullAndAutofillCpp() then
  returns { skipped } without touching anything, so adding this to the live
  job cannot break a tick there.
*/

const db     = require('../db');
const logger = require('./logger');
const odooDb = require('./odooDb');
const { recordRevision } = require('./reportRevisions');
const { CPP_FIELD_MAP } = require('../config/odooCppMap');

const FORM_TYPE = 'cpp';
const SHIFT     = 'day';

/* Fields are rounded to at most 2 dp (4 for the constants); a difference
   below half a hundredth is float noise, not a disagreement. Same role as
   EQUAL_TOLERANCE in odooProductionAutofill.js. */
const EQUAL_TOLERANCE = 0.005;

const COLUMNS = [...new Set(CPP_FIELD_MAP.map(m => m.column))];

function round(v, dp) {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function asNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* Pure. One Odoo cpp_entry row -> { field: value } over the mapped fields.

   Returns {} for an entry with no reading at all — every mapped column 0 or
   null — because that is the shape of an entry that was opened and never
   filled (the draft 'New #' rows look exactly like this, and a 'complete'
   one that did would be no more truthful). An empty object makes the caller
   skip the day rather than write a page of zeros. */
function mapEntry(entry) {
  if (!entry) return {};
  const anyReading = CPP_FIELD_MAP.some(m => {
    const v = asNumber(entry[m.column]);
    return v !== null && v !== 0;
  });
  if (!anyReading) return {};

  const out = {};
  for (const m of CPP_FIELD_MAP) {
    const v = asNumber(entry[m.column]);
    if (v === null) continue;
    /* A lab reading of 0 means "not measured" in Odoo — never written. */
    if (m.kind === 'lab' && !(v > 0)) continue;
    out[m.field] = round(v, m.dp);
  }
  return out;
}

/* Pure. Which Odoo entries may fill which day.
   rows: cpp_entry rows (any state) with a text `d` date.
   -> { byDate: { 'YYYY-MM-DD': entry }, ambiguous: [date…] } — complete
   rows only, and a date with more than one complete row is withheld. */
function pickCompleteEntries(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    if (r.state !== 'complete') continue;
    if (!groups.has(r.d)) groups.set(r.d, []);
    groups.get(r.d).push(r);
  }
  const byDate = {};
  const ambiguous = [];
  for (const [d, list] of groups) {
    if (list.length === 1) byDate[d] = list[0];
    else ambiguous.push(d);
  }
  return { byDate, ambiguous: ambiguous.sort() };
}

/* Pure. A human has touched this row if any person-column is set. The
   seeded workbook days carry submitted_by and approved_by ('cpp'); a day an
   officer later opens and saves gets updated_by. Any of them hands the day
   to people for good. */
function isHumanRow(row) {
  return !!(row && (row.submitted_by || row.updated_by || row.approved_by || row.rejected_by));
}

/* Pure. existingData = stored `data` JSONB (or null for no report);
   odooFields = mapEntry() output. Returns exactly what changes, and which of
   those changes replace a value already stored. */
function reconcileDay(existingData, odooFields) {
  const toWrite = {};
  const differences = [];
  for (const [field, odooValue] of Object.entries(odooFields)) {
    const previous = existingData ? asNumber(existingData[field]) : null;
    if (previous === null) {
      toWrite[field] = odooValue;
    } else if (Math.abs(previous - odooValue) > EQUAL_TOLERANCE) {
      toWrite[field] = odooValue;
      differences.push({ field, stored_value: previous, odoo_value: odooValue });
    }
  }
  return { toWrite, differences };
}

/* [from, to] inclusive, every state — the state filter is applied in
   pickCompleteEntries() so the "two complete rows" check can see them all.
   cpp_entry is ~1,300 rows (1.1 MB) with only a primary-key index, so the
   date filter is a cheap sequential scan; the result is one row per day. */
async function fetchCppEntries(from, to) {
  return odooDb.query(
    `SELECT id, name, date::text AS d, state, approval_status, write_date,
            ${COLUMNS.join(', ')}
       FROM cpp_entry
      WHERE date BETWEEN $1 AND $2
      ORDER BY date, id`,
    [from, to]);
}

/* One day -> one transaction, FOR UPDATE against a concurrent officer save
   of the same row. dryRun takes the same read-and-decide path and rolls
   back, so a preview never diverges from a real run. */
async function upsertDay(date, entry, { dryRun = false } = {}) {
  const odooFields = mapEntry(entry);
  if (!Object.keys(odooFields).length) {
    return { action: 'empty_entry', fieldsWritten: 0, differences: [] };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT data, status, approved_by, approved_at, submitted_by, updated_by, rejected_by
         FROM daily_reports
        WHERE form_type = $1 AND record_date = $2 AND shift = $3 FOR UPDATE`,
      [FORM_TYPE, date, SHIFT]);
    const row = existing.rows[0] || null;

    const { toWrite, differences } = reconcileDay(row ? row.data : null, odooFields);

    /* A person's day: report any disagreement, write nothing. */
    if (isHumanRow(row)) {
      await client.query('ROLLBACK');
      return { action: 'human_day', fieldsWritten: 0, differences };
    }

    let action = 'unchanged';
    if (Object.keys(toWrite).length && !dryRun) {
      if (!row) {
        /* 'approved', approved_by NULL — decision B″, see the header and the
           long note in odooProductionAutofill.js's upsertDay(). */
        await client.query(
          `INSERT INTO daily_reports (form_type, record_date, shift, data, status)
           VALUES ($1, $2, $3, $4::jsonb, 'approved')`,
          [FORM_TYPE, date, SHIFT, JSON.stringify(toWrite)]);
        action = 'created_approved';
      } else {
        /* Only data/updated_at move: status and every person-column stay as
           they are — a correction is not a re-approval. */
        await client.query(
          `UPDATE daily_reports SET data = data || $4::jsonb, updated_at = NOW()
            WHERE form_type = $1 AND record_date = $2 AND shift = $3`,
          [FORM_TYPE, date, SHIFT, JSON.stringify(toWrite)]);
        action = 'updated';
      }

      await recordRevision(client, {
        formType: FORM_TYPE, recordDate: date, shift: SHIFT, action: 'ODOO_AUTOFILL',
        priorData:       row ? row.data : null,
        priorStatus:     row ? row.status : null,
        priorApprovedBy: row ? row.approved_by : null,
        priorApprovedAt: row ? row.approved_at : null,
        changedFields:   Object.keys(toWrite).sort(),
        actorId:         null,             // no human did this
        actorName:       'odoo-sync',
        reason:          `Odoo CPP entry ${entry.name || entry.id} (cpp_entry id ${entry.id})`,
      });
    } else if (Object.keys(toWrite).length && dryRun) {
      action = row ? 'would_update' : 'would_create';
    }

    if (dryRun) await client.query('ROLLBACK');
    else await client.query('COMMIT');
    return { action, fieldsWritten: Object.keys(toWrite).length, differences };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* the original error is what matters */ });
    throw err;
  } finally {
    client.release();
  }
}

/* [from, to] inclusive. Walks the days Odoo has a complete entry for; a day
   with no entry yet (today's, still a draft) is simply not written — the
   report shows it as not entered, which is the truth. */
async function syncCppRange(from, to, { dryRun = false } = {}) {
  const rows = await fetchCppEntries(from, to);
  const { byDate, ambiguous } = pickCompleteEntries(rows);
  const dates = Object.keys(byDate).sort();

  const summary = {
    from, to, dryRun,
    odooRows: rows.length, days: dates.length,
    created: 0, updated: 0, unchanged: 0, humanDays: 0, emptyEntries: 0,
    fieldsWritten: 0, ambiguousDays: ambiguous, humanDayDifferences: [], changedDays: [],
  };

  for (const date of dates) {
    const r = await upsertDay(date, byDate[date], { dryRun });
    if (r.action === 'created_approved' || r.action === 'would_create') summary.created++;
    else if (r.action === 'updated' || r.action === 'would_update') summary.updated++;
    else if (r.action === 'human_day') summary.humanDays++;
    else if (r.action === 'empty_entry') summary.emptyEntries++;
    else summary.unchanged++;
    summary.fieldsWritten += r.fieldsWritten;
    if (r.action === 'human_day' && r.differences.length) {
      summary.humanDayDifferences.push({ date, differences: r.differences });
    }
    if (r.action === 'updated' && r.differences.length) {
      summary.changedDays.push({ date, differences: r.differences });
    }
  }

  if (ambiguous.length) {
    logger.warn({ dates: ambiguous },
      'odoo cpp autofill: more than one complete CPP entry on a date — day skipped, nothing written');
  }
  if (summary.humanDayDifferences.length) {
    logger.info({ days: summary.humanDayDifferences },
      'odoo cpp autofill: Odoo disagrees with a CPP report a person entered — the person\'s figures were KEPT');
  }
  return summary;
}

/* The entry point for the live job, the CLI and tests alike. */
async function pullAndAutofillCpp(from, to, { dryRun = false } = {}) {
  if (!odooDb.isConfigured()) return { skipped: 'odoo db not configured', from, to };
  const autofill = await syncCppRange(from, to, { dryRun });
  return {
    autofill,
    /* Flat aliases for odooSync.js's generic dropped-rows alert. An
       ambiguous day is a day Odoo has that could not be stored. */
    rowsRejected: autofill.ambiguousDays.length,
    rowsUnmapped: 0,
  };
}

module.exports = {
  mapEntry, pickCompleteEntries, isHumanRow, reconcileDay,
  fetchCppEntries, upsertDay, syncCppRange, pullAndAutofillCpp,
};
