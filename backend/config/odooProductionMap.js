/*
  config/odooProductionMap.js — how Odoo's production_report entries map onto
  daily-report.html's facts (form_type 'production').

  Every rule below was measured, not assumed. On 2026-09-20 Odoo entries were
  summed per day and compared with the plant's own Master Production Report
  for 1 Apr - 30 Jun 2026 (91 days). The match count is beside each rule.

  Two conventions that matter:

  - WET basis. Consumption uses Odoo's `input_quantity` (as received), which
    is what the plant records. `final_qty_after_moisture` (dry) matched the
    report on almost no days (e.g. limestone 4 of 91) and is not mapped.
  - A stage with no entry for a day contributes no facts at all (see mapDay
    in services/odooProductionMapper.js). "Odoo has nothing yet" and "Odoo
    says zero" are different things, and the caller decides which it is.

  Not mapped on purpose, because Odoo cannot supply them: run hours, crusher
  output, receipts, CPP coal, grinding aid / fly ash, finished-cement
  dispatch, specific power, opening stocks. See the "Odoo Production
  Autofill" doc for why each one is out.
*/

/* Odoo's picking type -> our stage name.

   Both spellings are listed because the 2026-10-08 Odoo deploy changed the
   RESPONSE GROUP KEYS from the long form ('CEMENT: Cement Production (CM1)')
   to short labels ('Cement', 'Clinker', 'Raw Meal', 'Coal Mill', 'Crusher'),
   while each ENTRY kept the long form in its own `picking_type` field.

   The long form is the one that matters and normalizeEntry() prefers it,
   because the short 'Cement' group does NOT distinguish CM1 from CM2 — both
   mills are in one bucket, and mapping on the group key alone would merge
   two mills into one stage and silently halve the per-mill tonnage.

   `mill_type` looks like it would separate them but must NOT be used for it:
   it reads 'CM1' on Clinker, Raw Meal and Coal Mill entries too, where it
   means nothing.

   Crusher arrived in the same deploy (we had asked for it) and has NO
   picking_type on its entries — only the group key 'Crusher' identifies it,
   which is exactly why the group-key fallback is kept. */
const STAGE_BY_PICKING_TYPE = Object.freeze({
  // Long form — the entry's own picking_type field (preferred).
  'CEMENT: Raw Meal Production':     'raw_meal',
  'CEMENT: Clinker Production':      'clinker',
  'CEMENT: Fine Coal Production':    'fine_coal',
  'CEMENT: Cement Production (CM1)': 'cm1',
  'CEMENT: Cement Production (CM2)': 'cm2',

  // Short form — the response group key, 2026-10-08 onward. 'Cement' is
  // deliberately absent: it cannot name a stage on its own (CM1 vs CM2).
  'Raw Meal':  'raw_meal',
  'Clinker':   'clinker',
  'Coal Mill': 'fine_coal',
  'Crusher':   'crusher',
});

/* 'crusher' joined 2026-10-08, when Odoo added the group we had asked for.
   Listing it here means a day with no crusher entry is reported in
   missingStages rather than passing unnoticed. */
const ALL_STAGES = Object.freeze(['raw_meal', 'clinker', 'fine_coal', 'cm1', 'cm2', 'crusher']);
const CEMENT_STAGES = Object.freeze(['cm1', 'cm2']);

/* Header fields that arrived in the 2026-10-08 deploy -> report facts.

   `agg` says how several entries on one day combine:
     'mean'  — a measured property, averaged weighted by produced_qty. NCV is
               the calorific value of the coal burned, so two kiln entries on
               one day must not have their NCVs added together.
     'sum'   — a quantity. Run hours over two entries on the same mill add up.

   Crusher output is here rather than in PRODUCED_BY_STAGE because its stage
   was added at the same time and its entries carry no consumption lines (see
   normalizeEntry) — it contributes a header number only. */
const HEADER_FACTS = Object.freeze([
  /* Mean, not sum: NCV is a property of the coal, not a quantity — two kiln
     entries on one day must not have their calorific values added. Weighted
     by produced_qty so a 1,800 t run counts for more than a 200 t one.

     The fact `kiln_coal_ncv` was repointed from the limestone form to the
     production report in the same change (forms/formula-registry.js) — the
     formula engine resolves a fact only from the form named there, so
     writing it here without that move would store a number nothing reads. */
  { stage: 'clinker',   field: 'coal_ncv',      fact: 'coal_ncv',           agg: 'mean' },

  { stage: 'clinker',   field: 'running_hours', fact: 'kiln_run_hrs',       agg: 'sum'  },
  { stage: 'fine_coal', field: 'running_hours', fact: 'coalmill_run_hrs',   agg: 'sum'  },
  { stage: 'crusher',   field: 'running_hours', fact: 'ls_crusher_run_hrs', agg: 'sum'  },
  { stage: 'crusher',   field: 'produced_qty',  fact: 'ls_crusher_prod_mt', agg: 'sum'  },

  /* Deliberately NOT mapped: cement-mill run hours. Odoo reports one
     running_hours per production entry, but the report splits mill hours by
     GRADE (cm1_425r_run_hrs, cm1_325n_run_hrs, …, ten fields). One entry can
     cover a grade the mill ran for part of the day, and there is no key in
     the payload saying how its hours divide between grades. Summing an
     entry's hours into every grade it touched would multiply the mill's day;
     picking one grade would be a guess. Left to the officer until Odoo
     reports hours per grade, or the report gains a per-mill total field.

     Also not mapped: raw-meal running_hours. Odoo has one raw-meal stream and
     the report has rm1_run_hrs/rm2_run_hrs per mill — the same decision-C
     split that keeps raw_meal_prod_mt out of rm1_prod_mt. */
]);

// Odoo finished-good code -> the grade suffix daily-report.html uses.
// FG005 is "CEMENT B-M 42.5 N", the Duramax 42 marketing grade.
const GRADE_BY_PRODUCT = Object.freeze({
  FG001: '425r',
  FG002: '325n',
  FG003: '425n',
  FG004: 'opc',
  FG005: '425n_bm',
});
const GRADE_SUFFIXES = Object.freeze(Object.values(GRADE_BY_PRODUCT));

// A stage's whole produced quantity -> one fact.        Match (of 91 days)
const PRODUCED_BY_STAGE = Object.freeze({
  clinker:   'kiln_prod_mt',        // 91
  fine_coal: 'coalmill_prod_mt',    // 91
});
// cement: cm1_<grade>_mt / cm2_<grade>_mt by product   // 90-91 (8 of 10 comparable)

// Produced quantity with no fact to land in yet (decision C in the doc:
// Odoo has one raw-meal stream, the report has RM1 and RM2 fields).
const EXTRA_PRODUCED_BY_STAGE = Object.freeze({
  raw_meal: 'raw_meal_prod_mt',
});

/* Consumed-item lines, by item code, summed over every entry of the listed
   stages. `provisional` = mapped but held back from `facts` until a decision
   is made, so nothing prefills it by accident. */
const CONSUMPTION_RULES = Object.freeze([
  { stages: ['raw_meal'],  item: 'WIP001',   fact: 'rmm_limestone_cons' },       // 87  limestone to the raw mill
  { stages: ['raw_meal'],  item: 'QRM007',   fact: 'rmm_clay_cons' },            // 89  OB/CLAY
  { stages: ['raw_meal'],  item: 'QRM008',   fact: 'rmm_industrialclay_cons' },  // 91  ID Clay
  { stages: ['raw_meal'],  item: 'RM000004', fact: 'rmm_ironore_cons' },         // 89
  { stages: ['raw_meal'],  item: 'RM000007', fact: 'rmm_bauxite_cons' },         // 8 of the 10 days it was used
  { stages: ['fine_coal'], item: 'RM000001', fact: 'coal_kiln' },                // 89  raw coal into the coal mill
  { stages: ['clinker'],   item: 'WIP004',   fact: 'coalmill_cons_mt' },         // 91  fine coal into the kiln
  { stages: ['clinker'],   item: 'WIP002',   fact: 'rm1_cons_mt',                // 15 of 15 recorded days
    provisional: 'Kiln raw-meal feed. The report keeps it on the RM1 row only; RM2 has no consumption field (decision C).' },
  { stages: CEMENT_STAGES, item: 'WIP003',   fact: 'cm_clinker_own_cons' },      // 88
  { stages: CEMENT_STAGES, item: 'RM000014', fact: 'cm_clinker_purch_cons' },    // 91  CLINKER SPG = purchased clinker
  { stages: CEMENT_STAGES, item: 'RM000003', fact: 'cm_gypsum_cons' },           // 88
  { stages: CEMENT_STAGES, item: 'WIP001',   fact: 'cm_limestone_cons' },        // 89
]);

/* Facts that are a sum of other facts. ls_crusher_cons_mt is the limestone
   drawn from crusher stock: the raw mill plus the cement mills. 85 of 91 days
   exact, 99.9% of the quarter. Emitted when any listed stage has an entry. */
const DERIVED_FACTS = Object.freeze([
  { fact: 'ls_crusher_cons_mt', sumOf: ['rmm_limestone_cons', 'cm_limestone_cons'], stages: ['raw_meal', 'cm1', 'cm2'] },
]);

// Consumed items that are known and intentionally not facts.
const IGNORED_ITEMS = Object.freeze({
  RM000002: 'COAL ASH (0 on every entry seen)',
  SER004:   'Power Units CPP (no daily-report field; used only as a cross-check)',
  SER005:   'Power Units TANESCO (no daily-report field; used only as a cross-check)',
});

module.exports = {
  STAGE_BY_PICKING_TYPE, ALL_STAGES, CEMENT_STAGES, HEADER_FACTS,
  GRADE_BY_PRODUCT, GRADE_SUFFIXES,
  PRODUCED_BY_STAGE, EXTRA_PRODUCED_BY_STAGE,
  CONSUMPTION_RULES, DERIVED_FACTS, IGNORED_ITEMS,
};
