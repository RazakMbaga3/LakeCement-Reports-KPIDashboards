/*
  config/odooMaterialMap.js — maps Odoo's item codes and vendor codes onto
  the rows the Raw Material Report actually prints.

  ── Why a config file and not a lookup table in the database ───────────
  This is business policy, not data. "Which supplier's coal is Kiln coal"
  is a decision Purchase & Stores owns and changes rarely; putting it in
  code means it is reviewed, diffed and deployed like the rest of the
  report's rules, instead of being edited invisibly in a table nobody
  audits. The same reasoning as config/materialRates.js.

  ── The Kiln vs CPP problem, stated honestly ───────────────────────────
  The Raw Material Report splits coal into COAL-KILN and COAL-CPP, each
  broken down by supplier. Odoo cannot tell us which: measured 2026-10-01
  over the whole 14-15 Sep GRN set, ALL 67 coal lines carry the same
  `location_and_bin` — 'COAL YARD-OPEN YARD'. There is no destination
  field, because the split does not happen at receipt; it happens later
  when coal is drawn from the yard to the kiln or the power plant.

  So a received tonne of coal CANNOT be attributed to Kiln or CPP from
  receipt data alone, and this file does not pretend otherwise. What it
  does is map each vendor to the report row that vendor's coal is known to
  feed, which is a real standing arrangement at the plant (a supplier
  contracted for CPP coal delivers CPP coal). Where that arrangement is
  not known, the vendor maps to nothing and the report shows the tonnage
  under "Unassigned" — visible, not silently folded into Kiln.

  NEVER guess a vendor into a row to make a total look complete. An
  unassigned tonne that an officer can see and correct is worth more than
  an assigned tonne that is wrong, and the 2026-09-30 data-integrity audit
  exists because of exactly this class of mistake.
*/

/* Odoo item code -> the report's material key. Codes confirmed against
   production GRN data 2026-10-01. */
const ITEM_TO_MATERIAL = Object.freeze({
  RM000001: 'coal',
  RM000003: 'gypsum',
  RM000004: 'iron_ore',
  RM000009: 'industrial_clay',
  RM000005: 'mill_scale',
});

/* Materials the report prints as a single row (no supplier breakdown). */
const SIMPLE_MATERIALS = Object.freeze({
  gypsum: 'GYPSUM',
  iron_ore: 'IRON ORE',
  industrial_clay: 'INDUSTRIAL CLAY',
  mill_scale: 'MILL SCALE IRON DUST',
});

/* Coal vendor code -> { destination, row }.

   `destination` is 'kiln' | 'cpp'. `row` is the form field key the Raw
   Material Report already uses (ck_* for kiln, cc_* for CPP — see
   forms/materials-form.html), so a mapped vendor lands directly on the
   row the officer already reads.

   Vendor CODES, not names: names change spelling in Odoo (the same
   supplier appears as 'Jitegemee Holdings Company Limited' here and
   'Jitegemee coal' on the form), codes do not.

   Only the three coal vendors actually seen in production data so far are
   listed. The form has ~24 coal rows, most of them dormant; adding a
   mapping for a vendor that has never delivered would be inventing a fact.
   A new supplier shows up as Unassigned on the report, with their code
   printed, which is the prompt to add them here. */
const COAL_VENDORS = Object.freeze({
  CMLT0357: { destination: 'kiln', row: 'ck_market', label: 'Market Insight Limited' },
  CMLT0265: { destination: 'kiln', row: 'ck_jitegemee', label: 'Jitegemee Holdings Company Limited' },
  CMLT0559: { destination: 'cpp', row: 'cc_stamico', label: 'State Mining Corporation' },
});

/* Pull the bracketed code out of Odoo's '[CODE] Name'. GRN lines carry
   vendor_code separately, but gate entries only have the joined string. */
function codeOf(vendorField, explicitCode) {
  if (explicitCode) return String(explicitCode).trim();
  const m = String(vendorField || '').match(/\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

/* Resolve one GRN/gate row to a report row.
   Returns { material, destination, row, vendorCode, label, assigned }.
   `assigned:false` means we know the material but NOT where it belongs —
   the caller must surface it, never drop it. */
function resolveRow({ itemCode, vendorName, vendorCode: vc }) {
  const material = ITEM_TO_MATERIAL[String(itemCode || '').trim()] || null;
  if (!material) {
    return { material: null, destination: null, row: null, vendorCode: codeOf(vendorName, vc), label: null, assigned: false };
  }
  if (material !== 'coal') {
    return { material, destination: null, row: material, vendorCode: codeOf(vendorName, vc), label: SIMPLE_MATERIALS[material], assigned: true };
  }
  const code = codeOf(vendorName, vc);
  const hit = code ? COAL_VENDORS[code] : null;
  if (!hit) {
    return { material: 'coal', destination: null, row: null, vendorCode: code, label: null, assigned: false };
  }
  return { material: 'coal', destination: hit.destination, row: hit.row, vendorCode: code, label: hit.label, assigned: true };
}

module.exports = {
  ITEM_TO_MATERIAL,
  SIMPLE_MATERIALS,
  COAL_VENDORS,
  resolveRow,
  codeOf,
};
