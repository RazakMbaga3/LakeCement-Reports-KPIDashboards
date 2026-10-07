/*
  config/odooMaterialConsumption.js — which Raw Material Report rows can have
  their CONSUMPTION filled from Odoo's production_report, and from what.

  ── Why this is separate from odooMaterialMap.js ───────────────────────
  That file answers "whose coal arrived at the gate" (receipts, keyed on
  vendor). This one answers "what did the plant burn" (consumption, keyed on
  production stage). They read different Odoo feeds and are wrong in
  different ways, so they are reviewed separately.

  ── Why only three materials ───────────────────────────────────────────
  Measured 2026-10-07 over odoo_production_entries.consumed_items. The feed
  carries real daily MT for limestone, coal, fine coal, raw meal, clinker,
  gypsum, iron ore, OB/clay, ID clay and bauxite. Only three of those can be
  placed on a Raw Material Report row without inventing a number:

    gypsum, iron ore, clinker — ONE row each on the report, and one code in
    Odoo. A total is the whole truth; there is nothing to apportion.

  Coal is deliberately absent, for two independent reasons, either of which
  alone would be enough:

    1. No supplier split. Odoo reports a single COAL figure. The form has
       ~24 supplier-wise KILN rows and ~24 CPP rows, and the closing stock
       of each pile depends on which supplier's coal was drawn. Spreading
       one total across them needs an allocation rule (pro-rata by stock? by
       receipts?) that is Purchase & Stores' policy to set, not ours to
       infer. config/odooMaterialMap.js's header already refuses to guess a
       vendor into a row; this is the same refusal on the consumption side.

    2. No CPP burn at all. The production stages are raw_meal, clinker,
       fine_coal, cm1 and cm2. CPP appears only as 'SER004 Power Units CPP'
       — kWh produced, not coal consumed — so the CPP draw is absent from
       this feed and from stores_issues alike. config/odooProductionMap.js's
       own header lists "CPP coal" among the things Odoo cannot supply.

    A kiln total written with no CPP draw would UNDERSTATE the burn and
    OVERSTATE the pile, which is worse than the honest blank it replaces,
    because the "provisional" marking would disappear with it.

  Coal also has two legs in this feed — RM000001 raw coal into Fine Coal
  Production (~319 MT/day) and WIP004 fine coal into the kiln (~275 MT/day).
  They are measured at different points and must never be summed. Whoever
  resolves (1) and (2) has to pick one deliberately.

  ── WET basis ──────────────────────────────────────────────────────────
  `input_quantity` (as received), never `final_qty_after_moisture` (dry).
  This matches config/odooProductionMap.js, which measured the dry figure
  against the plant's own Master Production Report and found it matched on
  almost no days. Stock is held and drawn wet, so the stock ledger needs the
  wet number: gypsum over 2026-10-01..06 was 608.29 MT wet against 578.96
  dry, and the 29 MT difference is water, not a reconciliation error.
*/

/* report row field prefix -> { code, stages, label }

   `stages` is the set of production stages whose consumption of that code
   counts for this row. It is explicit rather than "all stages" so that a
   NEW stage appearing in Odoo does not silently start adding tonnage to a
   row nobody re-checked — it shows up as an unmapped stage instead. */
const CONSUMPTION_SOURCES = Object.freeze({
  gypsum: {
    code: 'RM000003',
    /* Gypsum is interground with clinker at the cement mills. */
    stages: Object.freeze(['cm1', 'cm2']),
    label: 'Gypsum',
  },
  iron_ore: {
    code: 'RM000004',
    /* Iron ore is a raw-meal corrective, consumed at the raw mill. */
    stages: Object.freeze(['raw_meal']),
    label: 'Iron Ore',
  },
  clinker: {
    code: 'WIP003',
    /* Clinker drawn from the silo into the cement mills. */
    stages: Object.freeze(['cm1', 'cm2']),
    label: 'Clinker',
    /* Clinker is the one material here the plant MAKES rather than buys, so
       its inflow is not a gate receipt. The report's own tile says so:
       "Own production + purchased receipts". Filling the draw (~1,950
       MT/day) without the kiln's output (~2,000 MT/day) drove the Clinker
       Stock tile to −1,947 MT on first run, because the ledger was all
       outflow and no inflow.

       `producedFrom` names the stage whose produced_qty is added to this
       row's RECEIVED column. Only clinker has one; gypsum and iron ore are
       bought, and their receipts come from the gate feed as usual. */
    producedFrom: 'clinker',
  },
});

/* row -> the production stage whose output counts as that row's receipt.
   Derived rather than restated, so the two can never drift. */
const PRODUCTION_SOURCES = Object.freeze(Object.fromEntries(
  Object.entries(CONSUMPTION_SOURCES)
    .filter(([, r]) => r.producedFrom)
    .map(([field, r]) => [field, r.producedFrom])));

const CONSUMPTION_ROWS = Object.freeze(Object.keys(CONSUMPTION_SOURCES));

/* Every stage any rule above draws from — used to spot a consumed line
   whose stage is not one we expect, so a new mill or kiln line is reported
   rather than silently ignored. */
const MAPPED_STAGES = Object.freeze([...new Set(
  Object.values(CONSUMPTION_SOURCES).flatMap(r => r.stages))]);

module.exports = {
  CONSUMPTION_SOURCES, CONSUMPTION_ROWS, MAPPED_STAGES, PRODUCTION_SOURCES,
};
