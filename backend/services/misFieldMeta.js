/*
  services/misFieldMeta.js — turns a raw fact/field key into something a
  plant manager recognises: a readable label, a unit, and a sensible number
  of decimals.

  WHY THIS EXISTS
  ---------------
  misReport.prettifyField() title-cases the database column and stops there,
  so an exported MIS sheet read "Coal Kiln | 204" and "Spc Rm1 Kwh | 52317".
  Those are storage keys, not the plant's own words, and — worse — they carry
  no unit, so 204 could be MT, kWh or hours. The HTML print view had the same
  gap. The MD and Plant Head read these exports beside the Excel workbooks the
  departments still email, where every column is captioned and dimensioned.

  AUTHORITY / HONESTY RULES
  -------------------------
  * forms/formula-registry.js FACTS is the single source of truth for the
    units of the 171 declared facts, and wins over anything inferred here.
    docs/KPI_REFERENCE.md is generated from that same registry, so a unit
    printed in an export matches the unit documented for the KPI.
  * Everything else is resolved from the key's own naming convention
    (verified against every key the daily and monthly reports actually
    emit: *_mt, *_kwh, *_hrs, *_min, *_ncv/_gcv, *_m3, *_ltr, *_pct ...).
  * If neither source knows the unit, this module returns an EMPTY unit.
    It never guesses a dimension onto a number — a wrong unit in a
    management pack is worse than a missing one.
  * Nothing here invents, defaults or rounds a VALUE. Decimals only affect
    how Excel displays a number that is already there; a missing value stays
    missing (see misExcel/misRender, which render it blank / "—").
*/

let FACTS;
try {
  /* The registry is a browser-first IIFE that also exports for Node. */
  FACTS = require('../../forms/formula-registry.js').FACTS || {};
} catch {
  FACTS = {};
}

/* fact.field (the form's column name) → declared unit. Several FACTS keys
   can point at one form field; the unit is the same, so last wins safely. */
const FACT_UNIT_BY_FIELD = Object.create(null);
for (const fact of Object.values(FACTS)) {
  if (fact && fact.field && fact.unit) FACT_UNIT_BY_FIELD[fact.field] = fact.unit;
}

/* Stores ledger: backend/config/storeMaterials.js already carries the real
   material name AND its category unit, and warns in its own comments that
   these are NOT all tonnes (packing bags are counts, diesel is litres).
   That config is authoritative for every materials-form stock field, so it
   is consulted before any naming-convention guess — otherwise a bag count
   exports as "MT" and a 800,000-bag re-order level reads as 800,000 tonnes. */
const STOCK_META_BY_FIELD = Object.create(null);
try {
  const { CATEGORIES, ROWS } = require('../config/storeMaterials.js');
  /* The materials form stores one field per material per measure. */
  const MEASURES = {
    open:  'opening stock',
    rcvd:  'received',
    recv:  'received',
    cons:  'consumption',
    grn:   'GRN',
    clos:  'closing stock',
    min:   'minimum level',
    max:   'maximum level',
  };
  for (const row of ROWS) {
    const cat  = CATEGORIES[row.category] || {};
    const unit = cat.unit === 'No.' ? 'bags' : cat.unit === 'Ltr' ? 'Litres' : cat.unit || '';
    const name = row.sectionLabel && !row.label.startsWith(row.sectionLabel)
      ? row.sectionLabel + ' — ' + row.label
      : row.label;
    for (const [suffix, measure] of Object.entries(MEASURES)) {
      STOCK_META_BY_FIELD[row.f + '_' + suffix] = { label: name + ' ' + measure, unit };
      /* MTD / YTD running totals of the same measure. */
      for (const period of ['mtd', 'ytd']) {
        STOCK_META_BY_FIELD[row.f + '_' + suffix + '_' + period] =
          { label: name + ' ' + measure + ' (' + period.toUpperCase() + ')', unit };
      }
    }
    STOCK_META_BY_FIELD[row.f] = { label: name, unit };
  }
} catch {
  /* config unavailable — fall through to the convention rules below */
}

/* ── Word-level expansions ────────────────────────────────────────────
   Plant abbreviations, in the spelling the departments use on their own
   workbooks and on the entry forms. Keys are single underscore-segments. */
const WORDS = {
  cm1: 'CM-1', cm2: 'CM-2', cm: 'Cement Mill',
  rm1: 'RM-1', rm2: 'RM-2', rm: 'Raw Mill',
  cpp: 'CPP', dg: 'DG', tg: 'TG', ct: 'Cooling Tower',
  kf: 'Kiln Feed', ck: 'Clinker', rmm: 'Raw Material',
  ncv: 'NCV', gcv: 'GCV', adb: 'ADB', arb: 'ARB',
  lsf: 'LSF', sm: 'SM', am: 'AM', im: 'IM', vm: 'VM',
  c2s: 'C2S', c3s: 'C3S', c3a: 'C3A', c4af: 'C4AF',
  cao: 'CaO', mgo: 'MgO', so3: 'SO3', loi: 'LOI',
  iuc: 'Internal Use Cement', so: 'SO', grn: 'GRN',
  ei: 'E&I', mech: 'Mechanical', prod: 'Production',
  spc: 'Power', pwr: 'Power', dsl: 'Diesel', pmh: 'PMH',
  lce: 'L/C Expansion', blaine: 'Blaine',
  bmill: 'B/Mill', ld: 'Loading', cem: 'Cement',
  opc: 'OPC', mt: 'MT', kwh: 'kWh', m3: 'm3', ltr: 'Litres',
  nos: 'Nos', pct: '%', hrs: 'Hours', min: 'Minutes',
  /* Unit spellings follow forms/formula-registry.js (the source
     docs/KPI_REFERENCE.md is generated from) so one measure is never
     captioned two ways across the app: 'Hrs', not 'hours'. */
  cons: 'Consumption', open: 'Opening Stock', recv: 'Received',
  rcvd: 'Received', clos: 'Closing Stock', mtd: 'MTD', ytd: 'YTD',
  run: 'Running', prodn: 'Production', gen: 'Generation',
  aux: 'Auxiliary', feed: 'Feed', makeup: 'Make-up',
  '425r': '42.5R', '425n': '42.5N', '325n': '32.5N',
  '425nbm': '42.5N B-M', 'opc425n': 'OPC 42.5N',
  r45: 'R45', r90: 'R90', r212: 'R212',
};

/* Whole-key labels, where the convention-built name would still read badly.
   Deliberately short: the generic builder handles the large majority. */
const KEY_LABELS = {
  kiln_prod_mt: 'Kiln Production',
  kiln_run_hrs: 'Kiln Running Hours',
  coal_kiln: 'Coal to Kiln',
  coal_cpp: 'Coal to CPP',
  coal_ncv: 'Coal NCV',
  free_lime: 'Clinker Free Lime (F.CaO)',
  strength_28d: '28-Day Compressive Strength',
  blaine_425r: 'Blaine — 42.5R',
  c3s_ck: 'Clinker C3S (Bogue)',
};

/* ── Unit resolution by naming convention ─────────────────────────────
   Ordered: the first matching rule wins. Every pattern here was checked
   against the real key set emitted by gatherDaily/gatherMonthly. */
const UNIT_RULES = [
  [/^stop_/, 'min'],                        // stoppage form is minutes throughout
  /* Diesel is metered in litres, so it must beat the generic _cons → MT
     rule below (dsl_pmh_cons read as MT otherwise). */
  [/^dsl_/, 'Litres'],
  [/_(ltr|litres|diesel)$/, 'Litres'],
  /* Lab chemistry: residues are %, strengths MPa, moduli dimensionless.
     These come before the _cons/_open family so a key like `liquid_ck`
     is not swept into tonnes. */
  [/_blaine$/, 'm²/kg'],
  [/_(cs1|cs2|cs3|cs7|cs28)$/, 'MPa'],
  [/_lce$/, 'mm'],
  [/^(r45|r90|r212)_/, '%'], [/_(r45|r90|r212)$/, '%'],
  [/^(c2s|c3s|c3a|c4af)_/, '%'], [/_(c2s|c3s|c3a|c4af)$/, '%'],
  [/^cao_h\d+$/, '%'],
  [/^coal_(im|vm|ash)$/, '%'],
  /* Moduli / saturation factors are ratios — explicitly dimensionless, so
     the lookup stops here instead of falling through to a guess. */
  [/^(lsf|sm|am)_/, ''],
  [/_(ncv|gcv)(_adb|_arb)?$/, 'kcal/kg'],
  [/_m3$/, 'm3'],
  [/_(mt|cons|rcvd|recv|open|clos|grn)$/, 'MT'],
  [/_(mt|cons|rcvd|recv|open|clos|grn)_(mtd|ytd)$/, 'MT'],
  [/_kwh$/, 'kWh'], [/_kwh_(mtd|ytd)$/, 'kWh'],
  [/_hrs$/, 'Hrs'],
  [/_min$/, 'min'],
  [/_pct$/, '%'],
  [/_nos$/, 'Nos'],
  [/_bags$/, 'bags'],
  /* Internal-use cement is booked in tonnes like every other cement line. */
  [/^iuc_/, 'MT'],
  [/^coal_(cpp|kiln)$/, 'MT'],
  [/^coal_(moisture|residue)$/, '%'],
  [/^ncv$/, 'kcal/kg'],
  [/^cpp_heat_rate_tg$/, 'kcal/kWh'],
  [/^ltrwt_/, 'g/l'],                        // clinker litre weight
  [/^liquid_/, '%'],
  /* Stores min/max re-order levels are in the stock item's own unit. Bag
     counts are bags; everything else on the materials form is tonnes. */
  [/^bag_[a-z0-9]+_(min|max)$/, 'bags'],
  [/_(min|max)$/, 'MT'],
];

/* Decimals Excel should display. Chosen to match how the plant writes the
   number on its own reports: tonnes and kWh to whole/one place, lab
   chemistry to two, ratios to two. Display only — never changes a value. */
function decimalsFor(unit) {
  switch (unit) {
    case 'MT':        return 2;
    case 'kWh':       return 0;
    case 'min':       return 0;
    case 'Hrs':       return 1;
    case 'kcal/kg':   return 0;
    case 'kcal/kWh':  return 0;
    case '%':         return 2;
    case 'MPa':       return 1;
    case 'm²/kg':     return 0;
    case 'mm':        return 1;
    case 'Litres':    return 0;
    case 'bags':      return 0;
    case 'Nos':       return 0;
    case 'm3':        return 1;
    default:          return 2;
  }
}

/* Excel number format for a unit, with a thousands separator so a six-figure
   kWh reading is legible. Returns undefined for non-numeric cells. */
function numFmtFor(unit) {
  const dp = decimalsFor(unit);
  return dp === 0 ? '#,##0' : '#,##0.' + '0'.repeat(dp);
}

function unitFor(key) {
  if (!key) return '';
  /* Declared facts win — this is the documented unit for the KPI. */
  if (FACT_UNIT_BY_FIELD[key] !== undefined) return FACT_UNIT_BY_FIELD[key];
  /* Then the stores config, which knows bags ≠ tonnes. */
  if (STOCK_META_BY_FIELD[key]) return STOCK_META_BY_FIELD[key].unit;
  for (const [re, unit] of UNIT_RULES) if (re.test(key)) return unit;
  return '';   // unknown — say nothing rather than guess a dimension
}

/* Stoppage keys are a section × cause matrix (stop_<section>_<cause>).
   Read as "Stop Cm1 Other" they are near-meaningless; the plant says
   "CM-1 stoppage — Other". */
const STOP_SECTIONS = {
  rm: 'Raw Mill', cm1: 'CM-1', cm2: 'CM-2', kiln: 'Kiln',
  crusher: 'Crusher', packing: 'Packing Plant', cm_coal: 'Coal Mill',
};
const STOP_CAUSES = {
  mech: 'Mechanical', ei: 'E&I', prod: 'Production', power: 'Power',
  planned: 'Planned', other: 'Other',
};

function stoppageLabel(key) {
  const rest = key.slice('stop_'.length);
  /* Longest section name first so cm_coal is not read as section "cm". */
  for (const sec of Object.keys(STOP_SECTIONS).sort((a, b) => b.length - a.length)) {
    if (rest === sec || rest.startsWith(sec + '_')) {
      const cause = rest.slice(sec.length).replace(/^_/, '');
      const secName = STOP_SECTIONS[sec];
      if (!cause) return secName + ' stoppage';
      return secName + ' stoppage — ' + (STOP_CAUSES[cause] || cause);
    }
  }
  return null;
}

function labelFor(key) {
  if (!key) return '';
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  if (STOCK_META_BY_FIELD[key]) return STOCK_META_BY_FIELD[key].label;
  if (String(key).startsWith('stop_')) {
    const s = stoppageLabel(String(key));
    if (s) return s;
  }

  const parts = String(key).split('_');
  /* A trailing period marker is shown as a suffix, not buried mid-label. */
  let period = '';
  const last = parts[parts.length - 1];
  if (last === 'mtd' || last === 'ytd') { period = last.toUpperCase(); parts.pop(); }

  /* A trailing unit word is dropped from the label — the Unit column
     carries it, so "Kiln Prod Mt / MT" does not say MT twice.
     `hrs` is deliberately NOT dropped: the plant's own reports call this
     "running hours", and "RM-2 Running / hours" reads like a truncation. */
  const UNIT_WORDS = new Set(['mt', 'kwh', 'min', 'm3', 'ltr', 'pct', 'nos']);
  if (parts.length > 1 && UNIT_WORDS.has(parts[parts.length - 1])) parts.pop();
  if (parts.length > 1 && parts[parts.length - 1] === 'hrs') parts[parts.length - 1] = 'Hours';

  const words = parts.map(p => WORDS[p] || (p.charAt(0).toUpperCase() + p.slice(1)));
  let label = words.join(' ');
  if (period) label += ' (' + period + ')';
  return label;
}

/* One call per field: everything an exporter needs to render the row. */
function fieldMeta(key) {
  const unit = unitFor(key);
  return { key, label: labelFor(key), unit, dp: decimalsFor(unit), numFmt: numFmtFor(unit) };
}

/* Is this key a running total rather than a value for the day? The daily
   sheet mixes them, and an MTD figure read as a day figure is a real
   misreading risk, so exports label the column. */
function isPeriodAggregate(key) {
  return /_(mtd|ytd)$/.test(String(key || ''));
}

module.exports = {
  fieldMeta, labelFor, unitFor, decimalsFor, numFmtFor, isPeriodAggregate,
  FACT_UNIT_BY_FIELD,
};
