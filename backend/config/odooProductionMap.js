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

// Odoo's picking type (the group key in the response) -> our stage name.
const STAGE_BY_PICKING_TYPE = Object.freeze({
  'CEMENT: Raw Meal Production':     'raw_meal',
  'CEMENT: Clinker Production':      'clinker',
  'CEMENT: Fine Coal Production':    'fine_coal',
  'CEMENT: Cement Production (CM1)': 'cm1',
  'CEMENT: Cement Production (CM2)': 'cm2',
});

const ALL_STAGES = Object.freeze(['raw_meal', 'clinker', 'fine_coal', 'cm1', 'cm2']);
const CEMENT_STAGES = Object.freeze(['cm1', 'cm2']);

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
  STAGE_BY_PICKING_TYPE, ALL_STAGES, CEMENT_STAGES,
  GRADE_BY_PRODUCT, GRADE_SUFFIXES,
  PRODUCED_BY_STAGE, EXTRA_PRODUCED_BY_STAGE,
  CONSUMPTION_RULES, DERIVED_FACTS, IGNORED_ITEMS,
};
