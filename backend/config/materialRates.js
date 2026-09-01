/*
  config/materialRates.js — TZS valuation rates for the Stores dashboard.

  WHY THIS FILE IS EMPTY BY DEFAULT
  ---------------------------------
  The MIS `materials` daily report records quantities only — opening,
  received, consumed, pending GRN, min/max. It holds no price, rate or
  cost field of any kind (verified 2026-08-27 across every form_type and
  every table: the only "rate" in the database is cpp_heat_rate, which is
  thermal efficiency, not money). So valuing stock movement in TZS needs a
  rate per material from somewhere else, and there is no honest way to
  derive one from what the plant already enters.

  Until rates exist, the Stores dashboard's value view reports
  {ok:false, status:'not_mapped'} and the quantity view carries on
  working — deliberately, rather than showing a plausible-looking TZS
  figure built on a guessed price. A wrong financial number is worse than
  a missing one.

  TWO WAYS TO FILL IT
  -------------------
  1. Odoo (preferred, once the API key lands): the real purchase price per
     material — `purchase.order.line.price_unit` for a weighted actual, or
     `product.product.standard_price` for standard cost. That path belongs
     in services/purchasesOdoo.js as a fetchMaterialRates(), keyed by the
     same field prefixes used here; this file then stays empty and acts
     only as a manual override for anything Odoo doesn't carry.

  2. A rate list from Finance/Stores: fill RATES below. One entry per
     material field prefix (the same keys as config/storeMaterials.js),
     valued in TZS per that material's own reporting unit — per MT for
     raw material / coal / grinding aid, per bag for packing bags, per
     litre for diesel. Partial is fine: materials without a rate are
     excluded from the value view and counted in `unrated`, so the page
     can say exactly how much of the movement it could not value rather
     than silently under-reporting.

  Rates are a point-in-time simplification either way — a single rate per
  material applied across all months. If Finance needs month-accurate
  valuation (prices move, especially for imported coal and diesel), that
  is a dated rate table, not this file, and worth saying so before anyone
  reads the TZS trend as an accounting figure.
*/

/* material field prefix -> TZS per reporting unit. Empty until sourced. */
const RATES = {
  // Example of the shape expected, commented out so nothing is fabricated:
  // gypsum:   120000,   // TZS per MT
  // clinker:  180000,   // TZS per MT
  // bag_425r:    850,   // TZS per bag
  // dsl_plant:  3200,   // TZS per litre
};

/* Where the numbers came from — surfaced in the UI so a reader always
   knows whether they are looking at actual purchase prices or a manual
   standard-cost list. Set alongside RATES when filling this in. */
const RATE_SOURCE = {
  label: null,        // e.g. 'Finance standard cost list, Jul 2026'
  as_of: null,        // e.g. '2026-07-01'
  basis: null,        // 'standard_cost' | 'purchase_actual'
};

function hasRates() {
  return Object.keys(RATES).length > 0;
}

module.exports = { RATES, RATE_SOURCE, hasRates };
