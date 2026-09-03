/*
  scripts/import-stoppage-facts.js — general importer for the plant's
  monthly "Stoppage report" workbooks (e.g. "3. Stoppage report
  30.08.2026.xlsx") into the granular `stoppage_facts` table
  (migrations/011_stoppage_facts.sql).

  This is a DIFFERENT source and a DIFFERENT table from
  scripts/import-stoppage.js, which POSTs the OLD coarse
  stop_<equip>_<cause> MINUTES matrix to daily_reports form_type='stoppage'
  over HTTP. That importer and its data are untouched by this one — see
  services/insights.js's equipmentStoppageDetail() for how the two sources
  are combined (granular wins per-day where it exists, coarse fills the
  rest).

  WHAT THE WORKBOOK LOOKS LIKE (verified against the live Aug-2026 file,
  not assumed — re-check this comment against a new month's file if the
  importer ever misbehaves):

    One sheet per equipment (Crusher, Raw Mill, Coal Mill, Cement Mill -1,
    Cement Mill -2, Kiln, Packing plant) + a "Summary " sheet used here only
    as a validation target. Each equipment sheet:
      · row 4 (0-indexed 3): equipment label, then one column per day of the
        month as a real Excel date SERIAL (not text — read raw, converted
        via XLSX.SSF.parse_date_code so no JS Date/timezone rounding can
        shift a date by a day), then a "Total" column.
      · Below that, repeating blocks: a CATEGORY header row (label present,
        every day-column cell truly empty/undefined — not even 0) followed
        by named-fault rows (label + a hours value, possibly 0, per day),
        then usually (not always — "Common" often has none) a "Total " row
        with an unreliable cached SUM() formula, which this importer never
        reads.
      · The category headers appear in a FIXED POSITIONAL ORDER on every
        sheet, confirmed across all 7: (1) Mechanical (2) Electrical &
        Instrumentation (3) Production [or "Production (Mining)" on
        Crusher] (4) "Common" — NOT a single cause; it holds exactly two
        named leaf rows, one containing "planned" (-> planned maintenance)
        and one containing "power" (-> power/CPP restriction), matched by
        keyword because the wording varies per sheet ("Power restriction
        from CPP", ".../TANESCO", ".../Tanesco / CPP") (5) "Others" [seen
        misspelled as a bare "3" on one real sheet — Cement Mill -1's own
        workbook, not a bug in this importer]. After that, three more
        header rows (CRITICAL/MEDIUM/Under Control, minutes-banded) exist
        on most sheets but are empty on every sheet in the source file —
        ignored, with a loud warning if a future workbook ever puts data
        under them, so nothing silently vanishes.
      Because the order is what's actually reliable (not the text — see the
      "3" case), category assignment is POSITIONAL, with a keyword sanity
      check that only WARNS on mismatch rather than blocking the import.

  USAGE
    node scripts/import-stoppage-facts.js --file "<path to workbook.xlsx>" [--dry-run]

  Idempotent: natural key is (equipment, cause, fault_description,
  record_date) — re-running the same file, or importing a corrected re-issue
  of the same month, upserts rather than duplicating.

  After writing, cross-checks the DB against the workbook's own "Summary "
  sheet (equipment x cause monthly totals) and prints any discrepancy —
  the plant asked for "correct formulas... reliable analysis", so this
  importer proves its own numbers rather than asking to be trusted.
*/
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const fs   = require('fs');
const XLSX = require('xlsx');
const db   = require('../db');

/* Same keys services/insights.js's STOP_EQUIPMENT/STOP_CAUSES already use —
   duplicated here (not required) rather than imported, so this script has
   zero runtime dependency on insights.js and can't be broken by changes
   there; the two are cross-checked by backend/test/*.test.js conventions
   if that ever drifts (see the equipment/cause key literals below). */
const EQUIPMENT_LABEL = {
  crusher: 'Crusher', rm: 'Raw Mill', cm_coal: 'Coal Mill', kiln: 'Kiln',
  cm1: 'Cement Mill 1', cm2: 'Cement Mill 2', packing: 'Packing Plant',
};
const CAUSE_LABEL = {
  mech: 'Mechanical', ei: 'Electrical & Instr.', prod: 'Process',
  planned: 'Planned Maintenance', power: 'Power', other: 'Other',
};

/* sheet name -> equipment key, matched after stripping everything but
   letters/digits and upper-casing — tolerant of "Cement Mill -1" vs
   "Cement Mill-1" vs "CEMENT MILL 1" across months without hand-listing
   every spacing variant. */
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const SHEET_NORM_TO_EQUIP = {
  CRUSHER: 'crusher', RAWMILL: 'rm', COALMILL: 'cm_coal', KILN: 'kiln',
  CEMENTMILL1: 'cm1', CEMENTMILL2: 'cm2', PACKINGPLANT: 'packing',
};
/* Summary sheet's own equipment-row labels ("CRUSHER", "CEMENT MILL - 1",
   "PACKING PLANT", ...) normalize onto the exact same table. */
const SUMMARY_NORM_TO_EQUIP = SHEET_NORM_TO_EQUIP;

/* Positional category order (see file header) -> cause key, or null for
   "Common" (split by keyword below) and 'ignore' for the trailing
   minutes-banded severity headers this workbook doesn't use. */
const CATEGORY_ORDER = ['mech', 'ei', 'prod', null /* Common */, 'other'];
const CATEGORY_KEYWORD = {
  mech: 'mechanical', ei: 'electrical', prod: 'production', other: 'other',
};

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).trim());
  return Number.isNaN(n) ? null : n;
}

/* Reads one equipment sheet into fact rows: [{ equipment, cause,
   faultDescription, recordDate, hours }]. Returns { facts, warnings }. */
function extractSheet(sheetName, sheet, equip, date1904, warnings) {
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true, range: sheet['!ref'] });
  const headerRow = grid[3] || [];

  /* Day columns: scan from index 1 until we hit the "Total" label (or run
     out of row) — NOT a fixed count, so a 28/29/30/31-day month all work
     without special-casing, and any stray trailing blank column (seen on
     the real Packing plant sheet) is naturally excluded. */
  const dayCols = []; // { idx, iso }
  for (let i = 1; i < headerRow.length; i++) {
    const v = headerRow[i];
    if (typeof v === 'number') {
      const d = XLSX.SSF.parse_date_code(v, { date1904 });
      if (!d) { warnings.push(`${sheetName}: header col ${i} (serial ${v}) did not parse as a date — skipped`); continue; }
      const iso = `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
      dayCols.push({ idx: i, iso });
    } else if (typeof v === 'string' && v.trim().toLowerCase().startsWith('total')) {
      break;
    }
    // else: blank/label cell before the first date column — keep scanning
  }
  if (!dayCols.length) {
    warnings.push(`${sheetName}: no date columns found in the header row — sheet skipped`);
    return { facts: [] };
  }

  const facts = [];
  let categoryCount = 0;
  let curCause = 'ignore'; // rows before the first category header (shouldn't exist, but stay safe)

  for (let r = 4; r < grid.length; r++) {
    const row = grid[r] || [];
    const label = row[0];
    if (label === null || label === undefined || String(label).trim() === '') continue;
    const labelStr = String(label).trim();

    const dataVals = dayCols.map(c => row[c.idx]);
    const allBlank = dataVals.every(v => v === null || v === undefined);

    if (allBlank) {
      // category header row
      categoryCount++;
      if (categoryCount <= CATEGORY_ORDER.length) {
        curCause = CATEGORY_ORDER[categoryCount - 1]; // null for "Common"
        const kw = CATEGORY_KEYWORD[curCause];
        if (kw && !labelStr.toLowerCase().includes(kw)) {
          warnings.push(`${sheetName}: category #${categoryCount} expected to contain "${kw}" but is labeled "${labelStr}" — trusting position, not text (see file header comment)`);
        }
      } else {
        curCause = 'ignore'; // CRITICAL/MEDIUM/Under Control bands — not a cause bucket
      }
      continue;
    }

    if (labelStr.toLowerCase() === 'total') continue; // never trust the cached SUM()

    if (curCause === 'ignore') {
      const anyNonzero = dataVals.some(v => typeof v === 'number' && v > 0);
      if (anyNonzero) {
        warnings.push(`${sheetName}: row "${labelStr}" has nonzero hours outside the 5 recognized cause categories (under a severity-band or pre-category header) — DROPPED, needs a human look`);
      }
      continue;
    }

    let cause = curCause;
    if (cause === null) { // inside "Common" — split by keyword
      const low = labelStr.toLowerCase();
      if (low.includes('planned')) cause = 'planned';
      else if (low.includes('power')) cause = 'power';
      else {
        const anyNonzero = dataVals.some(v => typeof v === 'number' && v > 0);
        warnings.push(`${sheetName}: "Common" row "${labelStr}" matches neither "planned" nor "power"${anyNonzero ? ' AND HAS NONZERO HOURS' : ''} — DROPPED`);
        continue;
      }
    }

    dayCols.forEach((c, i) => {
      const h = num(dataVals[i]);
      if (h === null || h <= 0) return; // no event that equipment/cause/fault/day
      facts.push({ equipment: equip, cause, faultDescription: labelStr, recordDate: c.iso, hours: h });
    });
  }

  return { facts, warnings };
}

/* Reads the "Summary " sheet: { equip: { cause: hours } } totals for the
   whole month, used only to validate what we loaded — never written. */
function extractSummary(sheet) {
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true, range: sheet['!ref'] });
  const headerRowIdx = grid.findIndex(r => (r || []).some(c => typeof c === 'string' && c.trim().toLowerCase() === 'mech'));
  if (headerRowIdx < 0) return null;
  const head = grid[headerRowIdx].map(c => (c === null ? '' : String(c).trim().toLowerCase()));
  const colFor = names => head.findIndex(h => names.includes(h));
  const cols = {
    mech: colFor(['mech']),
    ei: colFor(['e&i']),
    prod: colFor(['prod']),
    planned: colFor(['planned maint']),
    power: colFor(['power rest - cpp', 'power rest-cpp']),
    other: colFor(['others']),
  };

  const out = {};
  for (let r = headerRowIdx + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const label = row[0];
    if (label === null || label === undefined || String(label).trim() === '') continue;
    if (String(label).trim().toLowerCase() === 'total') continue; // grand total row — not per-equipment
    const equip = SUMMARY_NORM_TO_EQUIP[norm(label)];
    if (!equip) continue;
    out[equip] = out[equip] || {};
    for (const [cause, colIdx] of Object.entries(cols)) {
      if (colIdx < 0) continue;
      const v = num(row[colIdx]);
      out[equip][cause] = v === null ? 0 : v;
    }
  }
  return out;
}

async function main() {
  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fileIdx = args.indexOf('--file');
  const file   = fileIdx >= 0 ? args[fileIdx + 1] : null;

  if (!file) {
    console.error('Usage: node scripts/import-stoppage-facts.js --file "<path to Stoppage report.xlsx>" [--dry-run]');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  console.log(`Reading ${file}\n`);
  const wb = XLSX.readFile(file, { cellDates: false });
  const date1904 = !!(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904);

  const warnings = [];
  const allFacts = [];
  const sheetsSeen = [];
  const equipsSeen = new Set();

  for (const sheetName of wb.SheetNames) {
    const key = norm(sheetName);
    if (key === 'SUMMARY') continue;
    const equip = SHEET_NORM_TO_EQUIP[key];
    if (!equip) { warnings.push(`Unrecognized sheet "${sheetName}" — not one of the 7 known equipment sections, skipped.`); continue; }
    if (equipsSeen.has(equip)) { warnings.push(`Sheet "${sheetName}" maps to equipment "${equip}" which another sheet already covered — skipped to avoid double-import.`); continue; }
    equipsSeen.add(equip);
    sheetsSeen.push(sheetName);

    const { facts } = extractSheet(sheetName, wb.Sheets[sheetName], equip, date1904, warnings);
    allFacts.push(...facts);
  }

  const missingEquip = Object.keys(EQUIPMENT_LABEL).filter(k => !equipsSeen.has(k));
  if (missingEquip.length) {
    warnings.push(`Workbook has no sheet for: ${missingEquip.map(k => EQUIPMENT_LABEL[k]).join(', ')} — those sections will show no data for this period.`);
  }

  const months = [...new Set(allFacts.map(f => f.recordDate.slice(0, 7)))].sort();
  const dates = [...new Set(allFacts.map(f => f.recordDate))].sort();
  console.log(`Sheets read: ${sheetsSeen.join(', ')}`);
  console.log(`${allFacts.length} fact rows (nonzero hours) · ${dates.length} distinct dates · month(s): ${months.join(', ') || '(none)'}\n`);

  if (warnings.length) {
    console.log(`${warnings.length} warning(s):`);
    warnings.forEach(w => console.log('  ! ' + w));
    console.log('');
  }

  // per equipment x cause totals, recomputed from the fact rows we're about
  // to write — never from the sheet's own "Total" cells (see file header).
  const totals = {}; // equip -> cause -> hours
  for (const f of allFacts) {
    totals[f.equipment] = totals[f.equipment] || {};
    totals[f.equipment][f.cause] = (totals[f.equipment][f.cause] || 0) + f.hours;
  }

  console.log('Recomputed totals (hours) by equipment x cause:');
  const causeKeys = ['mech', 'ei', 'prod', 'planned', 'power', 'other'];
  console.log('  ' + 'equipment'.padEnd(14) + causeKeys.map(c => c.padStart(8)).join('') + '   total');
  for (const equip of Object.keys(EQUIPMENT_LABEL)) {
    const row = totals[equip] || {};
    const vals = causeKeys.map(c => row[c] || 0);
    const sum = vals.reduce((a, b) => a + b, 0);
    console.log('  ' + EQUIPMENT_LABEL[equip].padEnd(14) + vals.map(v => v.toFixed(1).padStart(8)).join('') + '   ' + sum.toFixed(1));
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written, no validation performed.');
    process.exit(0);
  }

  // ── Write (upsert) ──────────────────────────────────────────────
  const sourceFile = path.basename(file);
  let inserted = 0, updated = 0, failed = 0;
  for (const f of allFacts) {
    try {
      const r = await db.query(
        `INSERT INTO stoppage_facts (equipment, cause, fault_description, record_date, hours, source_file, imported_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (equipment, cause, fault_description, record_date)
         DO UPDATE SET hours = EXCLUDED.hours, source_file = EXCLUDED.source_file, imported_at = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [f.equipment, f.cause, f.faultDescription, f.recordDate, f.hours, sourceFile]
      );
      if (r.rows[0].inserted) inserted++; else updated++;
    } catch (e) {
      failed++;
      console.error(`  x ${f.equipment}/${f.cause}/${f.recordDate} "${f.faultDescription}": ${e.message}`);
    }
  }
  console.log(`\nWrote ${inserted + updated} rows (${inserted} new, ${updated} updated), ${failed} failed.`);

  // ── Validate against the workbook's own Summary sheet ────────────
  const summarySheetName = wb.SheetNames.find(n => norm(n) === 'SUMMARY');
  if (!summarySheetName) {
    console.log('\nNo "Summary" sheet found in this workbook — skipping cross-check.');
    process.exit(failed ? 1 : 0);
  }
  const summary = extractSummary(wb.Sheets[summarySheetName]);
  if (!summary) {
    console.log('\nCould not parse the "Summary" sheet header — skipping cross-check.');
    process.exit(failed ? 1 : 0);
  }

  console.log(`\nValidating against "${summarySheetName}" sheet (rounding tolerance 0.05h):`);
  let mismatches = 0;
  for (const equip of Object.keys(EQUIPMENT_LABEL)) {
    const summaryRow = summary[equip];
    if (!summaryRow) {
      if (equipsSeen.has(equip)) console.log(`  ? ${EQUIPMENT_LABEL[equip]}: no row on Summary sheet to compare against`);
      continue;
    }
    const ours = totals[equip] || {};
    for (const cause of causeKeys) {
      const mine = ours[cause] || 0;
      const theirs = summaryRow[cause] || 0;
      if (Math.abs(mine - theirs) > 0.05) {
        mismatches++;
        console.log(`  x ${EQUIPMENT_LABEL[equip]} / ${CAUSE_LABEL[cause]}: imported ${mine.toFixed(2)}h vs Summary sheet ${theirs.toFixed(2)}h`);
      }
    }
  }
  if (!mismatches) {
    console.log('  OK — every equipment x cause total matches the Summary sheet exactly (within rounding).');
  } else {
    console.log(`\n${mismatches} mismatch(es) found — see above.`);
    console.log(`  Most likely cause: the Summary sheet's own cells are formulas that read each equipment`);
    console.log(`  sheet's per-category "Total" row (e.g. Summary!D8 = Kiln!AH64), and that Total row is`);
    console.log(`  itself a cached SUM() that can go stale relative to the fault rows above it (the same`);
    console.log(`  caching problem this importer was told never to trust — see the file header comment).`);
    console.log(`  This importer sums the individual named-fault rows directly, so ITS number is the one`);
    console.log(`  to trust when the two disagree — but every mismatch above is worth a human glance at`);
    console.log(`  the source workbook to rule out an unrecognized/dropped row instead.`);
  }

  process.exit(failed || mismatches ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
