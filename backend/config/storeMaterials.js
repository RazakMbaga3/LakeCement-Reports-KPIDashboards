/*
  config/storeMaterials.js — server-side mirror of the material taxonomy in
  forms/materials-form.html (`MATERIALS_SECTIONS`).

  KEEP IN SYNC. The form owns data entry; this owns reporting. They are
  separate files only because the form's copy lives inline in HTML and can't
  be required from Node. If a material is added/renamed in the form, mirror
  it here or it silently drops out of the Stores dashboard.
  `npm run test:stores` asserts the two lists still match.

  Row flags carry the same meaning as the form (see its header comment):
    consOnly — CPP draw off the same supplier's KILN pile; holds no stock
               of its own, so it contributes consumption but never closing.
    pair     — on a KILN row, the field prefix of its CPP draw row, whose
               on-date consumption also depletes this pile.
    tank     — the diesel Plant main tank: its closing absorbs the WHOLE
               diesel section's on-date issues.

  `category` groups rows into the buckets the Stores dashboard reports on
  (the form groups by data-entry section, which is nearly but not exactly
  the same: Coal Kiln + Coal CPP are two entry sections but one stock
  category, since CPP draws off the kiln piles).
*/

/* Reporting categories — the Stores dashboard's top-level breakdown.
   `unit` matters: these are NOT all metric tonnes, so a single "total
   inventory" figure across all of them would be meaningless. */
const CATEGORIES = {
  raw_material: { label: 'Raw Material',  unit: 'MT',  order: 1 },
  coal:         { label: 'Coal',          unit: 'MT',  order: 2 },
  packing_bag:  { label: 'Packing Bags',  unit: 'No.', order: 3 },
  grinding_aid: { label: 'Grinding Aid',  unit: 'MT',  order: 4 },
  diesel:       { label: 'Diesel',        unit: 'Ltr', order: 5 },
};

const SECTIONS = [
  {
    id: 'main', category: 'raw_material', rows: [
      { f: 'iron_ore', label: 'Iron Ore' },
      { f: 'gypsum',   label: 'Gypsum' },
      { f: 'clinker',  label: 'Clinker' },
    ],
  },
  {
    id: 'ck', category: 'coal', label: 'Coal — Kiln', rows: [
      { f: 'ck_tancoal',   label: 'Tancoal Energy Limited',  pair: 'cc_tancoal' },
      { f: 'ck_ruvuma',    label: 'Ruvuma Coal Limited',     pair: 'cc_ruvuma' },
      { f: 'ck_market',    label: 'Market Insight Limited' },
      { f: 'ck_ariim',     label: 'Ariim Coal',              pair: 'cc_ariim' },
      { f: 'ck_coalash',   label: 'Coal Ash' },
      { f: 'ck_stamico',   label: 'State Mining Corporation' },
      { f: 'ck_jitegemee', label: 'Jitegemee coal',          pair: 'cc_jitegemee' },
      { f: 'ck_maxcoal',   label: 'Max coal',                pair: 'cc_maxcoal' },
      { f: 'ck_melt',      label: 'MELT coal',               pair: 'cc_melt' },
      { f: 'ck_ibrico',    label: 'IBRICO coal',             pair: 'cc_ibrico' },
      { f: 'ck_megacj',    label: 'Mega CJ',                 pair: 'cc_megacj' },
      { f: 'ck_mabenga',   label: 'Mabenga coal' },
      { f: 'ck_yongda',    label: 'Yongda',                  pair: 'cc_yongda' },
      { f: 'ck_kindaini',  label: 'Kindaini coal',           pair: 'cc_kindaini' },
      { f: 'ck_montreal',  label: 'Montreal',                pair: 'cc_montreal' },
      { f: 'ck_ludewa',    label: 'Ludewa coal',             pair: 'cc_ludewa' },
      { f: 'ck_mchekane',  label: 'Mchekane',                pair: 'cc_mchekane' },
      { f: 'ck_siaas',     label: 'SIAAS' },
    ],
  },
  {
    id: 'cc', category: 'coal', label: 'Coal — CPP', rows: [
      { f: 'cc_edenville',  label: 'Edenville International Limited' },
      { f: 'cc_mathayo',    label: "Mathayo Sons's Enterprises Limited" },
      { f: 'cc_elita',      label: 'Elita Company' },
      { f: 'cc_market',     label: 'Market Insight Limited' },
      { f: 'cc_mbuyu',      label: 'Mbuyu Investement Limited' },
      { f: 'cc_ruvuma',     label: 'Ruvuma Coal Limited',      consOnly: true },
      { f: 'cc_tancoal',    label: 'Tancoal Energy Limited',   consOnly: true },
      { f: 'cc_ariim',      label: 'Ariim Coal',               consOnly: true },
      { f: 'cc_lik',        label: 'Lik & Lambert coal',       consOnly: true },
      { f: 'cc_jitegemee',  label: 'Jitegemee coal',           consOnly: true },
      { f: 'cc_maxcoal',    label: 'Max coal',                 consOnly: true },
      { f: 'cc_melt',       label: 'MELT coal',                consOnly: true },
      { f: 'cc_ibrico',     label: 'IBRICO coal',              consOnly: true },
      { f: 'cc_megacj',     label: 'Mega CJ',                  consOnly: true },
      { f: 'cc_yongda',     label: 'Yongda',                   consOnly: true },
      { f: 'cc_kindaini',   label: 'Kindaini',                 consOnly: true },
      { f: 'cc_montreal',   label: 'Montreal',                 consOnly: true },
      { f: 'cc_ludewa',     label: 'Ludewa',                   consOnly: true },
      { f: 'cc_mchekane',   label: 'Mchekane',                 consOnly: true },
      { f: 'cc_rutanza',    label: 'Rutanza' },
      { f: 'cc_tenco',      label: 'TENCO' },
      { f: 'cc_scolastica', label: 'Scolastica' },
      { f: 'cc_stamico',    label: 'State Mining Corporation' },
      { f: 'cc_godmwanga',  label: 'God Mwanga Gems Limited' },
    ],
  },
  {
    id: 'bag', category: 'packing_bag', rows: [
      { f: 'bag_425r',    label: '42.5 R' },
      { f: 'bag_325n',    label: '32.5 N' },
      { f: 'bag_425n',    label: '42.5 N' },
      { f: 'bag_425nopc', label: '42.5 N OPC' },
      { f: 'bag_j425r',   label: 'Jumbo 42.5 R' },
      { f: 'bag_j325n',   label: 'Jumbo 32.5 N' },
    ],
  },
  {
    id: 'ga', category: 'grinding_aid', rows: [
      { f: 'ga_starex', label: 'Starex' },
      { f: 'ga_mapie',  label: 'Mapie' },
    ],
  },
  {
    /* The only section already broken out by consuming department — every
       row but the Plant tank is an issue point, not a stock point. This is
       the one real department dimension the MIS holds today; the wider
       "department-wise stock" question is still open with Stores (see the
       Stores/Inventory follow-ups). */
    id: 'dsl', category: 'diesel', rows: [
      { f: 'dsl_plant',     label: 'Plant (Main Tank)', tank: true, dept: 'Plant' },
      { f: 'dsl_kiln',      label: 'Kiln',                          dept: 'Kiln' },
      { f: 'dsl_genset',    label: 'Genset',                        dept: 'Power Plant' },
      { f: 'dsl_mining',    label: 'Mining Vehicles',               dept: 'Mines' },
      { f: 'dsl_pmh',       label: 'Plant Material Handling',       dept: 'Plant' },
      { f: 'dsl_admin',     label: 'Admin Vehicles',                dept: 'Admin' },
      { f: 'dsl_logistics', label: 'Logistics Division',            dept: 'Logistics' },
      { f: 'dsl_others',    label: 'Others (Crane, Tanker, Bouser..etc)', dept: 'Other' },
    ],
  },
];

/* Flat row list with section/category denormalised onto each row. */
const ROWS = SECTIONS.flatMap(sec =>
  sec.rows.map(r => ({ ...r, section: sec.id, category: sec.category, sectionLabel: sec.label || null })));

module.exports = { CATEGORIES, SECTIONS, ROWS };
