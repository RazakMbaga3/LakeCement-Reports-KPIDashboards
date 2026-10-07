/*
  services/odooMaterialsAutofill.js — writes the Odoo Stores feed
  (rm_gate_entries / rm_grn_lines, migration 031) into daily_reports
  (form_type='materials'), so the Raw Material Report carries the day's
  receipts without anyone opening the form and pressing a button.

  This is the Raw Material counterpart of odooProductionAutofill.js, and it
  follows that file's decisions deliberately rather than inventing its own.

  ── Why this exists at all ─────────────────────────────────────────────
  Before it, the ONLY path from Odoo onto this report was the "Fill from
  Odoo" button in forms/materials-form.html: an officer had to open the
  form, pick the date and click. The stores pull itself has run every 30
  minutes since 2026-10-01 (config/odooPulls.js), so the data was already
  in Postgres — it just never reached a report anybody reads. Measured on
  2026-10-07: rm_gate_entries held 1,086 rows up to 2026-10-02, while
  daily_reports held no 'materials' row newer than 2026-06-30. The report
  rendered zeros over live data, which is the fabricated-zero failure the
  2026-09-30 integrity audit named.

  ── What this writes, and from which of TWO Odoo feeds ─────────────────
  Receipts and consumption are different questions answered by different
  endpoints, and conflating them is the trap this header exists to mark.

      <row>_rcvd   on-date received tonnage   ] stores gate entries
      <row>_grn    of that, still pending GRN ] (rm_gate_entries)
      <row>_open   carried from yesterday's close (computed here)
      <row>_cons   on-date consumption        ] production_report
      <row>_rcvd   PLUS own production, for   ] (odoo_production_entries)
                   clinker — the plant makes  ]
                   it rather than buying it   ]

  Consumption was originally believed to be unavailable, on the strength of
  stores_issues — where every line really is diesel, lubricant, PPE or a
  spare part, because kiln and mill draws never pass through a stores issue.
  That was the wrong table to judge by. Re-checked 2026-10-07: the
  production_report feed carries real daily MT for limestone, coal, fine
  coal, raw meal, clinker, gypsum, iron ore, clay and bauxite, back to
  2024-01-01.

  Only THREE of those are written here — gypsum, iron ore and clinker —
  because they are the only ones that are one row on the report and one
  code in Odoo, so a total is the whole truth. Coal is excluded on two
  independent grounds (no supplier split, and no CPP burn in any feed);
  config/odooMaterialConsumption.js carries the full reasoning and must be
  read before anyone adds a fourth row.

  Everything else stays the officer's: min/max, and the consumption of
  every row not in that config. Closing stock = opening + received −
  consumed, so a day whose coal burn is still unentered is OVERSTATED, and
  the form says so — a "provisional" banner and a marker on every affected
  figure, including the KPI tiles, until a human fills the rest in.

  Writing a zero into a consumption cell merely to "complete" a row would
  be the exact bug the 2026-09-30 integrity audit exists to prevent: a
  fabricated zero is indistinguishable from a real quiet day, and here it
  would silently inflate stock on hand by a full day's burn — thousands of
  tonnes a week. A zero is written ONLY where Odoo positively reported one
  (the mills ran and took none), never to fill a silence.

  ── Status: 'pending_approval', mirroring decision B′ ──────────────────
  A day this writer CREATES lands as 'pending_approval', not 'draft'. The
  reasoning is odooProductionAutofill.js's, and it applies verbatim here:
  these receipts are already approved in Odoo by the plant's own Purchase &
  Stores people before the API returns them, so holding them behind a
  second local approval asks the same question twice — and 'draft' is not
  in REPORTED_STATUSES (config/forms.js), so a drafted day shows as "No
  data" on every surface while real tonnage sits in the table.

  What it does NOT do, exactly as the production writer:
    - never marks anything 'approved' — nothing here claims a human signed
    - never changes the status of an EXISTING row, in any status
    - never touches a day a human has started (submitted_by/updated_by set)
      beyond the two Odoo-owned columns
    - never overwrites a figure an officer typed; see reconcileDay()
*/

const db = require('../db');
const logger = require('./logger');
const { recordRevision } = require('./reportRevisions');
const { receiptsForDate } = require('./storesReport');
const { pullAllStores } = require('./odooStoresSync');
const { SECTIONS, ROWS } = require('../config/storeMaterials');
const { CONSUMPTION_SOURCES, PRODUCTION_SOURCES } = require('../config/odooMaterialConsumption');
/* The closing-stock rule itself is NOT re-derived here. services/stores.js
   already mirrors recompute() in forms/materials-form.html, including the
   two cases that are easy to get wrong — a CPP `pair` row drawing off its
   supplier's kiln pile, and the diesel `tank` absorbing the whole section's
   issues. Importing it means the carry-forward below can never drift from
   what the form and the Stores dashboard compute. */
const { _closing } = require('./stores');

const FORM_TYPE = 'materials';
const SHIFT = 'day';

/* Tonnages are rounded to 3dp upstream (storesReport.js's round()), so a
   difference below half a thousandth is float noise, not a disagreement
   anybody would act on. Matches EQUAL_TOLERANCE's role in the production
   writer, scaled to this report's precision. */
const EQUAL_TOLERANCE = 0.0005;

/* The ONLY two column suffixes this writer is allowed to touch. Kept as a
   frozen list rather than inlined, so that "what may the robot write" is
   one grep away and a future change to it is a visible diff. */
const ODOO_OWNED_SUFFIXES = Object.freeze(['rcvd', 'grn', 'cons']);

/* ── Consumption, from the production feed ──────────────────────────────
   One day's consumption for the three rows Odoo can fill without
   apportioning anything (config/odooMaterialConsumption.js explains which
   and why coal is not among them).

   Reads the odoo_production_entries mirror that odooProductionSync.js
   already keeps — no extra Odoo call, and the same rows the Production
   report is built from, so the two reports cannot disagree about how much
   gypsum the mills took.

   `withdrawn_at IS NULL` is the live filter: an entry Odoo later retracts
   is marked withdrawn rather than deleted, and counting a retracted entry
   would hold consumption that the plant has since said did not happen.

   Returns { <row>: mt }, omitting a row Odoo said nothing about. A row
   with no entry is NOT zero — "Odoo has nothing yet" and "Odoo says zero"
   are different facts, and only the caller can tell which matters. */
async function consumptionForDate(date) {
  const { rows } = await db.query(
    `SELECT i->>'code'                            AS code,
            e.stage                               AS stage,
            sum((i->>'input_quantity')::numeric)  AS qty
       FROM odoo_production_entries e,
            jsonb_array_elements(e.consumed_items) i
      WHERE e.withdrawn_at IS NULL
        AND e.production_date = $1
      GROUP BY 1, 2`,
    [date]);

  const out = {};
  for (const [field, rule] of Object.entries(CONSUMPTION_SOURCES)) {
    const hits = rows.filter(r => r.code === rule.code && rule.stages.includes(r.stage));
    if (!hits.length) continue;
    const mt = hits.reduce((s, r) => s + (Number(r.qty) || 0), 0);
    /* Round to the 3dp the receipts side already uses, so a figure written
       by this writer and one written by the gate feed carry the same
       precision on the same row. */
    out[field] = Math.round(mt * 1000) / 1000;
  }
  return out;
}

/* Own production for the rows the plant MAKES rather than buys — in
   practice clinker alone (config/odooMaterialConsumption.js).

   This lands in the row's RECEIVED column, which the report's own Clinker
   Stock tile already describes as "own production + purchased receipts".
   Without it the ledger has clinker leaving for the mills and nothing
   arriving from the kiln, and the tile goes negative within a day.

   Produced quantity is the entry's own produced_qty, not a consumed item,
   so it is a separate query rather than another filter over the same rows. */
async function productionForDate(date) {
  const stages = [...new Set(Object.values(PRODUCTION_SOURCES))];
  if (!stages.length) return {};

  const { rows } = await db.query(
    `SELECT stage, sum(produced_qty) AS qty
       FROM odoo_production_entries
      WHERE withdrawn_at IS NULL
        AND production_date = $1
        AND stage = ANY($2::varchar[])
      GROUP BY 1`,
    [date, stages]);

  const byStage = new Map(rows.map(r => [r.stage, Number(r.qty) || 0]));
  const out = {};
  for (const [field, stage] of Object.entries(PRODUCTION_SOURCES)) {
    if (!byStage.has(stage)) continue;
    out[field] = Math.round(byStage.get(stage) * 1000) / 1000;
  }
  return out;
}

function asNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* One day's receipts -> { field: value } over the Odoo-owned columns only.

   A row with no receipts is OMITTED, not written as zero. The distinction
   matters: an absent key leaves whatever the officer has (or an untouched
   blank), while an explicit 0 would overwrite a figure they typed and
   assert "nothing arrived" on a day we may simply have no gate rows for
   yet. Only materials that actually appeared at the gate are reported. */
function odooFieldsFor(receipts, consumption = {}, production = {}) {
  const out = {};
  for (const r of receipts.rows || []) {
    if (!r.row) continue;
    if (r.mt) out[`${r.row}_rcvd`] = r.mt;
    if (r.pending_grn_mt) out[`${r.row}_grn`] = r.pending_grn_mt;
  }
  /* Consumption for the three rows Odoo can fill outright. A zero IS
     written here, unlike a receipt: the production feed having an entry
     for the day that consumed none of this material is a positive
     statement ("the mills ran and took no iron ore"), whereas an absent
     row means Odoo said nothing and is skipped by consumptionForDate()
     before it ever reaches this function. */
  for (const [field, mt] of Object.entries(consumption)) {
    out[`${field}_cons`] = mt;
  }
  /* Own production joins the RECEIVED column. Added to whatever the gate
     feed reported for the same row rather than replacing it, because the
     report's clinker line is explicitly "own production + purchased
     receipts" — a plant that both burns its own and buys in must show the
     sum, not whichever source happened to be written last. */
  for (const [field, mt] of Object.entries(production)) {
    const key = `${field}_rcvd`;
    out[key] = Math.round(((out[key] || 0) + mt) * 1000) / 1000;
  }
  return out;
}

/* Yesterday's closing stock -> today's opening, per row.

   ── Why this is here at all ────────────────────────────────────────────
   Closing = opening + received − consumed. Odoo supplies received; the
   officer supplies consumed; NOBODY supplies opening, because on paper it
   was always just the previous day's closing figure carried down the page.
   A day written from the feed alone therefore has no opening at all, and
   the whole report computes closing stock from zero — measured on
   2026-10-07, the Stores dashboard read "Coal closing 0 MT" on a day with
   three live coal piles behind it. That is a fabricated zero of exactly
   the kind the 2026-09-30 integrity audit named, and it is worse than a
   blank because a reader cannot tell it from a real empty yard.

   ── What it does and does not assume ───────────────────────────────────
   It carries forward ONLY from an immediately-preceding day (prevDate must
   be the calendar day before). It never reaches further back to find the
   last day with data: across a gap, the intervening receipts and draws are
   unknown, so an older closing figure is not this day's opening — it is a
   stale number wearing today's date. A gap leaves opening absent, the
   report shows what it actually knows, and the officer fills it in.

   Returns {} when there is nothing trustworthy to carry. */
function carryForwardOpening(prevData, prevDate, date) {
  if (!prevData) return {};
  const day = (s) => new Date(`${s}T00:00:00Z`).getTime();
  const ONE_DAY = 86400000;
  if (day(date) - day(prevDate) !== ONE_DAY) return {};

  /* The diesel tank absorbs its whole section's on-date issues, so the
     section totals have to be computed before any row's closing. */
  const tankDrawBySection = {};
  for (const sec of SECTIONS) {
    tankDrawBySection[sec.id] = sec.rows.reduce(
      (s, r) => s + (asNumber(prevData[`${r.f}_cons`]) || 0), 0);
  }

  const out = {};
  for (const row of ROWS) {
    /* consOnly rows hold no stock of their own (the stock sits in the same
       supplier's kiln pile), so they have no opening to carry. */
    const closing = _closing(prevData, row, tankDrawBySection[row.section]);
    if (closing === null || !Number.isFinite(closing)) continue;

    /* A NEGATIVE closing is never carried, and this is the guard that keeps
       the whole chain honest.

       Stock cannot go below zero. When this computes one it is not telling
       us the yard is in deficit, it is telling us the chain was started
       without a real opening balance and has been subtracting consumption
       from nothing ever since. That happened for real: the gate feed begins
       2026-08-31 while the last typed report is 2026-06-30, so the first
       Odoo day opened at zero, and once consumption was added the error
       compounded daily — clinker reached −10,409 MT before this guard
       existed, and every closing figure downstream inherited it.

       Writing the number anyway would be the fabricated-zero bug wearing a
       minus sign: arithmetically faithful to a premise nobody checked, and
       far harder to spot than a blank. Leaving the cell empty makes the
       missing baseline visible exactly where someone can fix it — by typing
       the real opening stock for the first day, after which the chain is
       correct from there on. */
    if (closing < 0) continue;

    out[`${row.f}_open`] = Math.round(closing * 1000) / 1000;
  }
  return out;
}

/* Pure — no I/O, unit-tested directly.

   The rule that separates this from the production writer: here Odoo does
   NOT win a disagreement. If a stored value differs from Odoo's, the
   officer's figure is KEPT and the difference is reported as a conflict.

   Why the opposite call: a production tonnage is a single machine-measured
   fact that Odoo owns outright, so decision A lets Odoo correct it. A
   received tonnage is not — the gate feed lags, a truck can be weighed
   after cut-off, and the officer reconciling against delivery notes is
   frequently right where the feed is merely incomplete. Overwriting them
   would retype their corrections away every 30 minutes, which is worse
   than showing a conflict they can resolve.

   So: fill blanks, leave everything else, and surface the disagreement. */
function reconcileDay(existingData, odooFields) {
  const toWrite = {};
  const conflicts = [];
  for (const [field, odooValue] of Object.entries(odooFields)) {
    const previous = existingData ? asNumber(existingData[field]) : null;
    /* A literal 0 counts as unfilled, matching isUnset() in the form's own
       prefill — the grid is seeded with zeros, so treating 0 as "the
       officer said nothing arrived" would make the autofill a no-op on
       every untouched row. */
    if (previous === null || previous === 0) {
      toWrite[field] = odooValue;
    } else if (Math.abs(previous - odooValue) > EQUAL_TOLERANCE) {
      conflicts.push({ field, stored_value: previous, odoo_value: odooValue });
    }
  }
  return { toWrite, conflicts };
}

/* One day -> one transaction. FOR UPDATE serialises against an officer
   saving the same day from the form, so a concurrent save cannot be
   half-overwritten. dryRun takes the same read-and-decide path and rolls
   back, so a preview can never diverge from a real run. */
async function upsertDay(date, receipts, consumption = {}, production = {}, { dryRun = false } = {}) {
  const odooFields = odooFieldsFor(receipts, consumption, production);
  if (!Object.keys(odooFields).length) {
    /* Named for the common case, but it now means "Odoo had nothing at all
       for this day" — no receipts AND no production consumption. */
    return { action: 'no_receipts', fieldsWritten: 0, conflicts: 0, conflictDetail: [], openingCarried: 0, consumptionFilled: 0 };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT data, status, approved_by, approved_at
         FROM daily_reports
        WHERE form_type = $1 AND record_date = $2 AND shift = $3 FOR UPDATE`,
      [FORM_TYPE, date, SHIFT]);
    const row = existing.rows[0] || null;

    /* Opening stock, carried from the immediately-preceding day. Read
       inside the same transaction so a concurrent write to yesterday
       cannot leave today opening from a figure that no longer exists.
       Only the previous day is considered — see carryForwardOpening(). */
    const prev = await client.query(
      `SELECT record_date::text AS record_date, data
         FROM daily_reports
        WHERE form_type = $1 AND shift = $2 AND record_date = $3::date - INTERVAL '1 day'`,
      [FORM_TYPE, SHIFT, date]);
    const opening = prev.rows[0]
      ? carryForwardOpening(prev.rows[0].data, prev.rows[0].record_date, date)
      : {};

    /* Opening goes through the SAME reconcile as the receipts, so it can
       never overwrite a figure an officer typed either. */
    const { toWrite, conflicts } = reconcileDay(
      row ? row.data : null, { ...opening, ...odooFields });
    const openingCarried = Object.keys(toWrite).filter(k => k.endsWith('_open')).length;
    const consumptionFilled = Object.keys(toWrite).filter(k => k.endsWith('_cons')).length;

    let action = 'unchanged';
    if (Object.keys(toWrite).length && !dryRun) {
      if (!row) {
        /* 'pending_approval', not 'draft' — see the header. The day counts
           immediately and still appears in the HOD's queue. */
        await client.query(
          `INSERT INTO daily_reports (form_type, record_date, shift, data, status)
           VALUES ($1, $2, $3, $4::jsonb, 'pending_approval')`,
          [FORM_TYPE, date, SHIFT, JSON.stringify(toWrite)]);
        action = 'created_pending';
      } else {
        /* Only `data`/`updated_at` move — status, approved_by, approved_at
           and submitted_by are untouched. A correction is not a
           re-approval, and this must never look like a human re-signed. */
        await client.query(
          `UPDATE daily_reports SET data = data || $4::jsonb, updated_at = NOW()
            WHERE form_type = $1 AND record_date = $2 AND shift = $3`,
          [FORM_TYPE, date, SHIFT, JSON.stringify(toWrite)]);
        action = 'filled_blanks';
      }

      /* Same history as a human's edits (services/reportRevisions.js), from
         the pre-image already read above. This writer bypasses
         routes/reports.js — it writes daily_reports directly — which is
         exactly why the revision matters: otherwise "why did this number
         change" has one answer for people and no answer for the robot. */
      await recordRevision(client, {
        formType: FORM_TYPE, recordDate: date, shift: SHIFT, action: 'ODOO_AUTOFILL',
        priorData: row ? row.data : null,
        priorStatus: row ? row.status : null,
        priorApprovedBy: row ? row.approved_by : null,
        priorApprovedAt: row ? row.approved_at : null,
        changedFields: Object.keys(toWrite).sort(),
        actorId: null,                 // no human did this
        actorName: 'odoo-sync',
        reason: `Odoo stores gate entries for ${date}`,
      });
    } else if (Object.keys(toWrite).length && dryRun) {
      action = row ? 'would_fill_blanks' : 'would_create_pending';
    }

    if (dryRun) await client.query('ROLLBACK');
    else await client.query('COMMIT');

    return {
      action,
      fieldsWritten: Object.keys(toWrite).length,
      openingCarried,
      consumptionFilled,
      conflicts: conflicts.length,
      conflictDetail: conflicts,
      unassigned: (receipts.unassigned || []).length,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* the original error is what matters */ });
    throw err;
  } finally {
    client.release();
  }
}

/* [from, to] inclusive. Walks real calendar days rather than only the days
   the gate table happens to have rows for — a day with no receipts is a
   legitimate answer ('no_receipts') and must not be silently skipped, or a
   genuinely quiet Sunday becomes indistinguishable from a sync that never
   ran.

   STRICTLY ASCENDING, and that ordering is load-bearing, not incidental:
   each day's opening stock is carried from the day before, so a day must
   be written before the day after it is computed. Reversing this loop, or
   running the days concurrently, would silently leave every opening blank
   except the first. */
async function syncMaterialsRangeToReports(from, to, { dryRun = false } = {}) {
  const summary = {
    from, to, dryRun,
    days: 0, created: 0, updated: 0, unchanged: 0, noReceipts: 0,
    fieldsWritten: 0, openingCarried: 0, consumptionFilled: 0,
    conflicts: 0, conflictDays: [], unassignedDays: [],
  };

  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    summary.days++;

    const [receipts, consumption, production] = await Promise.all([
      receiptsForDate(date),
      consumptionForDate(date),
      productionForDate(date),
    ]);
    const r = await upsertDay(date, receipts, consumption, production, { dryRun });

    if (r.action === 'created_pending' || r.action === 'would_create_pending') summary.created++;
    else if (r.action === 'filled_blanks' || r.action === 'would_fill_blanks') summary.updated++;
    else if (r.action === 'no_receipts') summary.noReceipts++;
    else summary.unchanged++;

    summary.fieldsWritten += r.fieldsWritten;
    summary.openingCarried += r.openingCarried || 0;
    summary.consumptionFilled += r.consumptionFilled || 0;
    summary.conflicts += r.conflicts;
    if (r.conflicts) summary.conflictDays.push({ date, conflicts: r.conflictDetail });
    if (r.unassigned) summary.unassignedDays.push({ date, trucks: r.unassigned });
  }

  /* Both of these are warnings, not errors: the day still loaded. They are
     logged loudly because each one means a number on the report is
     knowably incomplete, and silence is how that gets signed off. */
  if (summary.conflicts) {
    logger.warn({ count: summary.conflicts, days: summary.conflictDays, dryRun },
      'odoo materials autofill: Odoo disagrees with a stored figure — the officer\'s value was KEPT, nothing was overwritten');
  }
  if (summary.unassignedDays.length) {
    logger.warn({ days: summary.unassignedDays },
      'odoo materials autofill: trucks could not be matched to a report row — see config/odooMaterialMap.js');
  }
  return summary;
}

/* The single entry point every caller (CLI, the live cron, a manual sync)
   uses: refresh the three stores tables, then reconcile them into
   daily_reports. Two summaries, not merged, because they answer different
   questions — "what did Odoo send" vs "what changed on the report". */
async function pullAndAutofillMaterials(from, to, { dryRun = false } = {}) {
  const pull = await pullAllStores(from, to);
  const autofill = await syncMaterialsRangeToReports(from, to, { dryRun });
  return {
    pull, autofill,
    /* Flat aliases so odooSync.js's generic "did anything get dropped"
       check sees this pull too, without a materials-specific branch. */
    rowsRejected: pull.errors ? pull.errors.length : 0,
    rowsUnmapped: autofill.unassignedDays.length,
  };
}

module.exports = {
  ODOO_OWNED_SUFFIXES,
  odooFieldsFor,
  reconcileDay,
  carryForwardOpening,
  consumptionForDate,
  productionForDate,
  upsertDay,
  syncMaterialsRangeToReports,
  pullAndAutofillMaterials,
};
