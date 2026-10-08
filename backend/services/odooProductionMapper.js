/*
  services/odooProductionMapper.js — the pure half of the production_report
  integration: turns Odoo's response into rows the mirror table can store, and
  turns stored rows into one day's daily-report facts.

  No database and no network in here, on purpose: every rule is unit-testable
  against a literal. The tables it applies live in config/odooProductionMap.js;
  the transport is odooProductionClient.js; the storage is odooProductionSync.js.
*/

const crypto = require('crypto');
const MAP = require('../config/odooProductionMap');

const r2 = (n) => Math.round(n * 100) / 100;

/* Odoo sends production_date as 'DD/MM/YYYY' text. ISO is also accepted in
   case the format is ever corrected. Anything else, or a date that does not
   exist (31/02), is rejected rather than guessed: a day filed under the wrong
   date corrupts two days at once. */
function parseEntryDate(value) {
  const s = String(value ?? '').trim();
  let y, m, d;
  let hit = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (hit) { d = +hit[1]; m = +hit[2]; y = +hit[3]; }
  else if ((hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) { y = +hit[1]; m = +hit[2]; d = +hit[3]; }
  else return null;

  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// '[WIP003] CLINKER' -> 'WIP003'. A name with no bracket code is kept whole.
function codeOf(product) {
  const s = String(product ?? '').trim();
  const hit = /^\[([^\]]+)\]/.exec(s);
  return (hit ? hit[1] : s).trim();
}

function nameOf(product) {
  return String(product ?? '').replace(/^\s*\[[^\]]+\]\s*/, '').trim();
}

// Odoo's JSON can carry false for an empty field; '' and null are empty too.
function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* First non-null of several possible source keys.

   On 2026-10-08 the Odoo team shipped the fields we had asked for (coal_ncv,
   running_hours, tph, state/approval_status, write_date) and renamed almost
   everything else in the same deploy: produced_qty -> production_qty,
   consumed_items -> line_items, and every line key (input_quantity ->
   quantity, final_qty_after_moisture -> final_qty, stock_available ->
   qty_available, moisture -> moisture_percent, product -> product_id, uom ->
   uom_id, cost -> standard_price).

   The old names are kept as fallbacks rather than replaced. The endpoint has
   now changed shape under us once with no notice; reading both costs nothing
   and means a rollback on their side, or one stage still serving the old
   shape, does not stop production data again. */
function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function normalizeItem(c) {
  if (!c || typeof c !== 'object') return { reject: 'a consumed item is not an object' };
  const product = pick(c, 'product', 'product_id');
  const qty = num(pick(c, 'input_quantity', 'quantity'));
  if (qty === null) return { reject: `consumed item ${JSON.stringify(product)} has no numeric input_quantity/quantity` };
  return {
    item: {
      product:                  String(product ?? '').trim(),
      code:                     codeOf(product),
      uom:                      pick(c, 'uom', 'uom_id') ? String(pick(c, 'uom', 'uom_id')) : null,
      input_quantity:           qty,
      final_qty_after_moisture: num(pick(c, 'final_qty_after_moisture', 'final_qty')),
      moisture:                 num(pick(c, 'moisture', 'moisture_percent')),
      stock_available:          num(pick(c, 'stock_available', 'qty_available')),
      cost:                     num(pick(c, 'cost', 'standard_price')),
    },
  };
}

/* Detects an amended entry. All fields are covered: on 2026-09-20 a fresh pull
   of Aug and Sep 2026 (589 entries) came back byte-identical, including
   stock_available and cost, so nothing in an entry drifts by itself and any
   change here is a real edit in Odoo. */
function contentHash(e) {
  const canon = JSON.stringify([
    e.stage, e.picking_type, e.production_date, e.product_name, e.product_code, e.uom,
    e.produced_qty, e.total_input_qty,
    /* Added 2026-10-08 with the fields themselves. These MUST be in the hash:
       a corrected NCV or run-hours figure with an unchanged tonnage would
       otherwise look like an unchanged entry and never be re-read. */
    e.coal_ncv, e.running_hours, e.tph, e.kiln_feed_value,
    e.state, e.approval_status, e.mill_type,
    e.consumed_items.map(i => [i.product, i.uom, i.input_quantity, i.final_qty_after_moisture,
      i.moisture, i.stock_available, i.cost]),
  ]);
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

/* One raw Odoo entry (under its picking-type key) -> a storable row, or a
   reject reason. A reject is never coerced: the caller reports it, because a
   silently dropped entry is tonnage missing from a day. */
function normalizeEntry(pickingType, raw) {
  if (!raw || typeof raw !== 'object') return { reject: 'entry is not an object' };

  const ref = String(raw.name ?? '').trim();
  if (!ref) return { reject: 'no name (reference)' };

  const date = parseEntryDate(raw.production_date);
  if (!date) return { reject: `unparseable production_date ${JSON.stringify(raw.production_date)}` };

  const rawProduced = pick(raw, 'produced_qty', 'production_qty');
  const produced = num(rawProduced);
  if (produced === null || produced < 0) return { reject: `produced_qty/production_qty is not a non-negative number (${JSON.stringify(rawProduced)})` };

  /* An entry carrying BOTH keys as empty lists is legitimate (a day with no
     consumption booked yet); only a non-list is a shape error. */
  const rawLines = raw.line_items !== undefined ? raw.line_items : raw.consumed_items;
  if (rawLines !== undefined && !Array.isArray(rawLines)) {
    return { reject: 'consumed_items/line_items is not a list' };
  }

  /* Crusher's lines are NOT consumption lines. The group arrived 2026-10-08
     (we had asked for it) and its line_items are weighbridge tickets —
     ticket_no, vehicle_no, gross_wt/tare_wt, product_uom_qty — one per truck
     into the crusher, with no `quantity` key at all. Running them through
     normalizeItem() rejects the whole entry, which is how the first pull
     after the change lost CRU/2026/00191 while its header still carried a
     real production_qty of 2,806.2 MT.

     So: keep the header (crusher output IS the number we want) and drop the
     ticket lines rather than mis-read them as consumption. The quarry
     weighbridge pipeline already models those tickets properly
     (odooMiningSync.js); duplicating them here as fake consumed items would
     double-count limestone. If a crusher consumption figure is ever needed,
     it needs its own mapping, not this one. */
  const isCrusher = /crusher/i.test(String(pickingType ?? ''));

  const items = [];
  for (const c of (isCrusher ? [] : rawLines) || []) {
    const { item, reject } = normalizeItem(c);
    if (reject) return { reject };
    items.push(item);
  }

  /* Prefer the entry's OWN picking_type over the response group key. Since
     2026-10-08 the group key is a short label ('Cement') that cannot tell CM1
     from CM2, while the entry still carries the long form that can. Crusher
     entries have no picking_type at all, so the group key remains the
     fallback — see config/odooProductionMap.js. */
  const picking = String(pick(raw, 'picking_type') ?? pickingType ?? '').trim()
               || String(pickingType ?? '').trim();
  const product = pick(raw, 'product', 'product_id');
  const uom     = pick(raw, 'uom', 'uom_id');
  const row = {
    entry_ref:       ref,
    production_date: date,
    picking_type:    picking,
    stage:           MAP.STAGE_BY_PICKING_TYPE[picking] || null,
    product_code:    codeOf(product) || null,
    product_name:    nameOf(product) || null,
    uom:             uom ? String(uom) : null,
    produced_qty:    produced,
    total_input_qty: num(raw.total_input_qty),
    consumed_items:  items,

    /* Delivered 2026-10-08, after being asked for in
       docs/email-drafts/03-odoo-production-missing-fields.md. Captured here
       so the mirror holds them; which ones reach daily_reports is
       config/odooProductionMap.js's decision, not this function's.

       running_hours arrives as decimal hours (23.833…), not the 'HH:MM' the
       form view shows — they answered that question in the payload. */
    coal_ncv:        num(raw.coal_ncv),
    running_hours:   num(raw.running_hours),
    tph:             num(raw.tph),
    kiln_feed_value: num(raw.kiln_feed_value),
    state:           raw.state ? String(raw.state).trim() : null,
    approval_status: raw.approval_status ? String(raw.approval_status).trim() : null,
    mill_type:       raw.mill_type ? String(raw.mill_type).trim() : null,
  };
  row.content_hash = contentHash(row);
  return { row };
}

/* The whole response `data` object ({ pickingType: [entry, ...] }) -> rows.
   A reference that appears twice in one response keeps the later copy and is
   counted, since references are unique in every pull so far (0 duplicates in
   8,730 entries) and a repeat means something upstream changed. */
function flattenReport(data) {
  const byRef = new Map();
  const rejects = [];
  let duplicateRefs = 0;

  for (const [pickingType, list] of Object.entries(data || {})) {
    if (!Array.isArray(list)) { rejects.push({ reason: 'group is not a list', pickingType }); continue; }
    for (const raw of list) {
      const { row, reject } = normalizeEntry(pickingType, raw);
      if (reject) { rejects.push({ reason: reject, pickingType, ref: raw && raw.name }); continue; }
      if (byRef.has(row.entry_ref)) duplicateRefs++;
      byRef.set(row.entry_ref, row);
    }
  }
  return { rows: [...byRef.values()], rejects, duplicateRefs };
}

/* [from, to] inclusive -> consecutive windows of at most maxDays. The endpoint
   has no pagination, and the sibling Odoo endpoints truncate large ranges, so
   pulls go a month at a time. */
function splitRange(from, to, maxDays = 31) {
  const out = [];
  const end = Date.parse(to + 'T00:00:00Z');
  for (let start = Date.parse(from + 'T00:00:00Z'); start <= end; ) {
    const last = Math.min(start + (maxDays - 1) * 86400000, end);
    out.push({ from: new Date(start).toISOString().slice(0, 10), to: new Date(last).toISOString().slice(0, 10) });
    start = last + 86400000;
  }
  return out;
}

/* One day's stored entries -> daily-report facts.

   entries: [{ ref, stage, product_code, produced_qty, consumed_items:[{code, input_quantity}] }]
   Returns:
     facts        mapped and verified; safe to prefill
     provisional  mapped but held back pending a decision (see the map)
     extras       Odoo figures with no report field yet
     stagesPresent / missingStages   which of the five stages had an entry
     unmapped     anything Odoo sent that no rule covers, so it is visible
     refs         every entry that fed the day, for tracing a number to Odoo

   A stage with at least one entry emits ALL the facts it owns, at 0 when no
   line matched (a mill that ran other grades made 0 of this one). A stage with
   no entry emits none of its facts: that is "Odoo has nothing", not "zero". */
function mapDay(entries) {
  const facts = {};
  const provisional = {};
  const extras = {};
  const unmapped = [];
  const present = new Set(entries.map(e => e.stage).filter(Boolean));

  const bucketFor = (rule) => (rule.provisional ? provisional : facts);
  const add = (bucket, key, qty) => { bucket[key] = (bucket[key] || 0) + qty; };

  // Every fact a present stage owns starts at 0.
  for (const stage of present) {
    if (MAP.PRODUCED_BY_STAGE[stage]) facts[MAP.PRODUCED_BY_STAGE[stage]] = 0;
    if (MAP.EXTRA_PRODUCED_BY_STAGE[stage]) extras[MAP.EXTRA_PRODUCED_BY_STAGE[stage]] = 0;
    if (MAP.CEMENT_STAGES.includes(stage)) for (const g of MAP.GRADE_SUFFIXES) facts[`${stage}_${g}_mt`] = 0;
  }
  for (const rule of MAP.CONSUMPTION_RULES) {
    if (rule.stages.some(s => present.has(s))) bucketFor(rule)[rule.fact] = 0;
  }

  /* Header-level fields (NCV, run hours, crusher output), added 2026-10-08.
     Accumulated separately because a 'mean' rule needs the weights kept until
     every entry is seen; a sum could go straight into `facts`. */
  const headerAcc = new Map(); // fact -> { sum, weight, agg }
  for (const rule of MAP.HEADER_FACTS) {
    if (present.has(rule.stage)) headerAcc.set(rule.fact, { sum: 0, weight: 0, agg: rule.agg });
  }

  for (const e of entries) {
    if (!e.stage) { unmapped.push({ kind: 'stage', ref: e.ref, qty: e.produced_qty }); continue; }

    for (const rule of MAP.HEADER_FACTS) {
      if (rule.stage !== e.stage) continue;
      const v = e[rule.field];
      if (v === null || v === undefined) continue;

      /* Odoo sends 0 as a PLACEHOLDER for a measured property it has no
         reading for: coal_ncv is 0 on every Raw Meal, Cement and Coal Mill
         entry (verified 2026-10-08), and a clinker entry can carry 0 too
         before the lab figure is keyed in. Zero is not a calorific value —
         taking it literally would make Specific Thermal Energy Consumption
         read 0 kcal/kg, a fabricated number on a plant head's screen, which
         is the exact failure mode logged in project-data-integrity-audit.

         Only 'mean' facts get this treatment: a genuine 0 for a SUM (a mill
         that ran 0 hours) is real information and must be kept. */
      if (rule.agg === 'mean' && Number(v) === 0) continue;

      const acc = headerAcc.get(rule.fact);
      if (!acc) continue;
      if (rule.agg === 'mean') {
        /* Weight by the entry's own tonnage. A zero-tonnage entry would
           contribute nothing and make the mean undefined, so it is skipped
           rather than counted as weight 0 against a real reading. */
        const w = Number(e.produced_qty) || 0;
        if (w <= 0) continue;
        acc.sum += v * w;
        acc.weight += w;
      } else {
        acc.sum += v;
        acc.weight += 1;
      }
    }

    if (MAP.PRODUCED_BY_STAGE[e.stage]) add(facts, MAP.PRODUCED_BY_STAGE[e.stage], e.produced_qty);
    if (MAP.EXTRA_PRODUCED_BY_STAGE[e.stage]) add(extras, MAP.EXTRA_PRODUCED_BY_STAGE[e.stage], e.produced_qty);
    if (MAP.CEMENT_STAGES.includes(e.stage)) {
      const grade = MAP.GRADE_BY_PRODUCT[e.product_code];
      if (grade) add(facts, `${e.stage}_${grade}_mt`, e.produced_qty);
      else unmapped.push({ kind: 'product', stage: e.stage, code: e.product_code, ref: e.ref, qty: e.produced_qty });
    }

    for (const item of e.consumed_items || []) {
      const rule = MAP.CONSUMPTION_RULES.find(r => r.item === item.code && r.stages.includes(e.stage));
      if (rule) { add(bucketFor(rule), rule.fact, item.input_quantity); continue; }
      if (MAP.IGNORED_ITEMS[item.code]) continue;
      if (item.input_quantity) unmapped.push({ kind: 'consumed', stage: e.stage, code: item.code, ref: e.ref, qty: item.input_quantity });
    }
  }

  for (const d of MAP.DERIVED_FACTS) {
    if (d.stages.some(s => present.has(s))) facts[d.fact] = d.sumOf.reduce((sum, k) => sum + (facts[k] || 0), 0);
  }

  /* Resolve the header accumulators. A fact whose stage was present but whose
     entries carried no value (weight 0) is dropped rather than emitted as 0:
     "Odoo reported no NCV today" is not "the coal had no calorific value",
     and a fabricated zero in a divisor is the bug class this codebase has
     already been bitten by. */
  for (const [fact, acc] of headerAcc) {
    if (acc.weight <= 0) continue;
    facts[fact] = acc.agg === 'mean' ? acc.sum / acc.weight : acc.sum;
  }

  for (const bucket of [facts, provisional, extras]) for (const k of Object.keys(bucket)) bucket[k] = r2(bucket[k]);

  return {
    facts, provisional, extras,
    stagesPresent: MAP.ALL_STAGES.filter(s => present.has(s)),
    missingStages: MAP.ALL_STAGES.filter(s => !present.has(s)),
    unmapped,
    entryCount: entries.length,
    refs: entries.map(e => e.ref).sort(),
  };
}

/* Every fact key mapDay can emit — the test uses this to prove each one is a
   real data-field in daily-report.html, so a typo here cannot ship silently. */
function emittableFactKeys() {
  const keys = new Set();
  for (const k of Object.values(MAP.PRODUCED_BY_STAGE)) keys.add(k);
  for (const s of MAP.CEMENT_STAGES) for (const g of MAP.GRADE_SUFFIXES) keys.add(`${s}_${g}_mt`);
  for (const r of MAP.CONSUMPTION_RULES) keys.add(r.fact);
  for (const d of MAP.DERIVED_FACTS) keys.add(d.fact);
  for (const h of MAP.HEADER_FACTS) keys.add(h.fact);
  return [...keys].sort();
}

module.exports = {
  parseEntryDate, codeOf, nameOf, normalizeEntry, flattenReport, splitRange,
  contentHash, mapDay, emittableFactKeys,
};
