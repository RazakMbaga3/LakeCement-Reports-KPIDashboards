/*
  services/odooStockLedger.js — rolls the Production Report's stock ledgers
  forward from the plant's own 30-Jun-2026 closing using Odoo's daily flows,
  writes the openings and receipts into daily_reports (form_type
  'production'), and compares the result with Odoo's live on-hand.

  Which ledgers, from which flows, and how each was verified against the
  plant's own reports: config/odooStockLedger.js. Read that first; this file
  is the machinery.

  ── Why the opening stock needed a writer at all ───────────────────────
  Since 1 Jul the production rows have been written by the production
  autofill (odooProductionAutofill.js) with tonnages and consumption only.
  Odoo's production_report API has no receipts and no opening stock, so
  every row from 1 Jul to today carried consumption against a blank opening:
  the report's closing (open + recv − cons) read as minus a day's burn, and
  the plant's stock lines in the Daily MIS had nothing true to read. Before
  this file, the only "opening" anywhere for Jul–Oct was the Raw Material
  chain, which starts from ZERO on 2026-08-31 (odooMaterialsAutofill.js
  carryForwardOpening) — so its 14-Oct clinker opening read 4,898 t and its
  coal supplier rows ~19,300 t against a real pile of ~8,991 t.

  ── The rules, in the order they bite ──────────────────────────────────
  1. Anchor. The roll starts from the plant's own closing on 2026-06-30 —
     a human-approved Excel day — never from Odoo's movement history (which
     carries large constant offsets before July; see the config header).
  2. Settled days only. A day's closing is published only once Odoo has
     closed that day for every process the ledger depends on: no entry of
     that type still draft/confirm, AND a complete entry already dated one
     day after it (two for cement and mining transfers, which keep arriving
     for a day after the next one starts — measured, see DEPENDENCY_TYPES in
     the config). Entries are booked the next morning, so without the second
     test the early-morning run would carry a day with no consumption yet
     into tomorrow's opening — an overstated number that is "corrected" an
     hour later, which is exactly the provisional figure this codebase
     refuses to print. A blank with a reason is honest; a number that is
     going to change is not.
  3. Never negative. A closing below zero is never published and never
     carried as an opening. The internal arithmetic does continue through
     it, because the cause measured so far (fine coal, 2026-08-09) is an
     entry dated a day off — the cumulative is right again the next day and
     matches the plant on 30 Aug and Odoo today. The day itself shows blank
     with its reason.
  4. People win. A figure in a field this robot writes that is NOT the
     figure it wrote last time (odoo_stock_ledger.written) was typed by a
     person and is never overwritten. A typed OPENING re-anchors the roll
     from that day — exactly what the plant's own sheet does when a stock
     count is entered. A stored 0 counts as blank (the form's inputs are
     seeded with 0), the same rule odooMaterialsAutofill.reconcileDay uses.
  5. Consumption is not ours. The *_cons / coal_kiln / production fields
     belong to the production autofill. The roll reads the STORED value, so
     the page's own closing is exactly the next day's opening; only when a
     row lacks the field does it fall back to Odoo's figure for the same
     day (measured 2026-10-15: stored == Odoo on every field, 1 Jul–13 Oct).
  6. No fabricated zeros. A day with no receipt writes no receipt field; a
     withheld opening writes nothing (and removes this robot's own stale
     value if it wrote one earlier). The only zero ever written is a
     complete CPP entry that reported 0 t burned — a positive statement.
  7. Rows. A day that has no production row yet gets one created as
     'approved' with approved_by NULL — decision B″ (DEC-012), the same
     shape as the production/materials/dispatch writers: counts in every
     report, sits in nobody's approval queue, and claims no human signed.
     An existing row's status/approval is never touched. Every change is
     recorded in report_revisions as ODOO_AUTOFILL by 'odoo-sync'.

  ── Load on the live ERP ───────────────────────────────────────────────
  Measured 2026-10-15 for the whole 1 Jul–15 Oct window: receipts 2.5 s,
  production lines 1.0 s, entries 0.9 s, transfers 0.6 s, CPP 0.2 s,
  on-hand 0.2 s — ~5.5 s, all aggregate queries, run one after another.
  The live job therefore runs an INCREMENTAL window (LIVE_WINDOW_DAYS,
  anchored on this table's own settled closing) and rebuilds from the
  30-Jun anchor at most once every FULL_REBUILD_HOURS, which is what picks
  up an Odoo entry edited weeks after the fact.
*/

const db = require('../db');
const logger = require('./logger');
const odooDb = require('./odooDb');
const { recordRevision } = require('./reportRevisions');
const { LEDGERS, DEPENDENCY_TYPES, KILN_COAL_VENDORS, ANCHOR } = require('../config/odooStockLedger');
const { COAL_VENDORS } = require('../config/odooMaterialMap');

const FORM_TYPE = 'production';
const SHIFT = 'day';
const TZ = 'Africa/Dar_es_Salaam';
const EAT_OFFSET_MS = 3 * 3600 * 1000;   // Tanzania has no daylight saving

/* Written values are rounded to 3 dp; below half a thousandth is float
   noise, not a different figure — same role as odooMaterialsAutofill's
   EQUAL_TOLERANCE. */
const TOL = 0.0005;

/* Comparison with Odoo's on-hand: a difference under a tonne is rounding in
   Odoo's own weighbridge figures, not something anyone would act on. */
const ONHAND_TOLERANCE_MT = 1;

const LIVE_WINDOW_DAYS = 14;
const FULL_REBUILD_HOURS = 20;

/* The plant's WIP pile location — where crushed limestone, clay, the clinker
   yard and the fine-coal bin live in Odoo. Matched by name prefix rather
   than id so the rule is readable; measured 2026-10-15 as id 19,
   'CM/WIP Stock(Pile/Raw Meal/CSP/Coal Mill)'. */
const PILE_LOCATION_LIKE = 'CM/WIP Stock%';

const CPP_COAL_VENDORS = Object.freeze(Object.keys(COAL_VENDORS).filter(c => COAL_VENDORS[c].destination === 'cpp'));

/* ── small pure helpers ─────────────────────────────────────────────── */

function todayEAT(now = new Date()) {
  return new Date(now.getTime() + EAT_OFFSET_MS).toISOString().slice(0, 10);
}
function addDays(date, n) {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function dayRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function r3(v) { return v === null || v === undefined ? null : Math.round(v * 1000) / 1000; }

/* Was this stored value typed by a person? `mine` is what this robot last
   wrote to the field (undefined if it never did). See rule 4 above. */
function isHumanValue(stored, mine) {
  const v = num(stored);
  if (v === null || Math.abs(v) <= TOL) return false;
  if (mine === undefined || mine === null) return true;
  return Math.abs(v - Number(mine)) > TOL;
}

/* Every flow key a ledger reads, so fetchFlows asks Odoo for nothing else. */
function flowPlan(ledgers = LEDGERS) {
  const recv = new Set(), transfer = new Set(), line = new Set(), lineTypes = new Set(), prodTypes = new Set();
  for (const l of ledgers) {
    for (const spec of [...l.inflows, ...l.outflows]) {
      for (const k of spec.flows) {
        const [kind, a, b] = k.split(':');
        if (kind === 'recv' || kind === 'recvkiln' || kind === 'recvcpp') recv.add(a);
        else if (kind === 'transfer') transfer.add(a);
        else if (kind === 'line') { lineTypes.add(a); line.add(b); }
        else if (kind === 'prod') prodTypes.add(a);
      }
    }
  }
  const depProd = new Set();
  for (const l of ledgers) for (const t of l.dependsOn) if (DEPENDENCY_TYPES[t].source === 'prod') depProd.add(t);
  return {
    recvCodes: [...recv], transferCodes: [...transfer], lineCodes: [...line],
    lineTypes: [...lineTypes], prodTypes: [...new Set([...prodTypes, ...depProd])],
  };
}

/* ── Odoo reads ──────────────────────────────────────────────────────── */

/* EAT day of a UTC timestamp column (Odoo stores naive UTC). */
const eatDay = col => `((${col} AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')::date::text`;

/* All the Odoo flows for [from, to] (EAT days), plus what is needed to say
   whether each day is settled. Sequential queries — see the header on load.

   Timestamped tables are bounded on [from − 1 day, to + 1 day) in UTC,
   which covers EAT days from..to completely (EAT = UTC+3), and the EAT day
   is then filtered exactly in JS. */
async function fetchFlows(from, to, { ledgers = LEDGERS, query = odooDb.query, catchUpAnchor = null } = {}) {
  const plan = flowPlan(ledgers);
  const byDay = {};
  const add = (d, key, q) => {
    if (d < from || d > to) return;
    const day = (byDay[d] = byDay[d] || {});
    day[key] = (day[key] || 0) + (Number(q) || 0);
  };
  const cppDays = new Set();
  const pending = {};          // type -> day -> [{ name, state, qty, code? }]
  const addPending = (type, d, entry) => {
    if (d < from || d > to) return;
    ((pending[type] = pending[type] || {})[d] = pending[type][d] || []).push(entry);
  };
  const unknownCoalVendors = {};
  const kilnVendors = new Set(Object.keys(KILN_COAL_VENDORS));
  const cppVendors = new Set(CPP_COAL_VENDORS);

  /* 1. Validated receipts, with the supplier for the coal split. */
  if (plan.recvCodes.length) {
    const rows = await query(`
      SELECT ${eatDay('m.date')} AS d, pp.default_code AS code,
             COALESCE(rp.partner_code, cp.partner_code) AS vendor,
             COALESCE(cp.name, rp.name) AS vendor_name,
             SUM(m.product_uom_qty)::float AS q
        FROM stock_move m
        JOIN stock_picking_type spt ON spt.id = m.picking_type_id
        JOIN product_product pp     ON pp.id = m.product_id
        LEFT JOIN stock_picking p   ON p.id = m.picking_id
        LEFT JOIN res_partner rp    ON rp.id = p.partner_id
        LEFT JOIN res_partner cp    ON cp.id = rp.commercial_partner_id
       WHERE m.state = 'done' AND spt.code = 'incoming'
         AND pp.default_code = ANY($3)
         AND m.date >= ($1::date - 1) AND m.date < ($2::date + 1)
       GROUP BY 1, 2, 3, 4`, [from, to, plan.recvCodes]);
    for (const r of rows) {
      add(r.d, `recv:${r.code}`, r.q);
      if (r.code === 'RM000001') {
        if (r.vendor && cppVendors.has(r.vendor)) add(r.d, `recvcpp:${r.code}`, r.q);
        else {
          add(r.d, `recvkiln:${r.code}`, r.q);
          if (r.d >= from && r.d <= to && !(r.vendor && kilnVendors.has(r.vendor))) {
            const k = `${r.vendor || '(no code)'} ${r.vendor_name || ''}`.trim();
            unknownCoalVendors[k] = r3((unknownCoalVendors[k] || 0) + r.q);
          }
        }
      }
    }
  }

  /* 2. Mining transfers INTO the plant pile, on the day the truck was
        WEIGHED (gross_date — the plant's own day; config/odooStockLedger.js),
        plus the not-yet-complete ones, which hold their day open. */
  const transferRows = await query(`
    SELECT ${eatDay('t.gross_date')} AS d, pp.default_code AS code, t.state,
           SUM(t.product_uom_qty)::float AS q, COUNT(*)::int AS n
      FROM custom_mining_transfer t
      JOIN product_product pp ON pp.id = t.product_id
      JOIN stock_location dl  ON dl.id = t.dest_location_id
     WHERE t.state <> 'cancel'
       AND dl.complete_name ILIKE $3
       AND t.gross_date >= ($1::date - 1) AND t.gross_date < ($2::date + 1)
     GROUP BY 1, 2, 3`, [from, to, PILE_LOCATION_LIKE]);
  for (const r of transferRows) {
    if (r.state === 'complete') {
      if (plan.transferCodes.includes(r.code)) add(r.d, `transfer:${r.code}`, r.q);
    } else if (r.q > 0) {
      addPending('mining', r.d, { name: `${r.n} ${r.code} transfer(s)`, state: r.state, qty: r3(r.q), code: r.code });
    }
  }

  /* 2b. Anchor catch-up (full rebuild only). The plant's anchor book can
        only contain tickets Odoo had IMPORTED when the plant closed it;
        tickets weighed on or before the anchor day but imported after it
        are in the pile and not in the book, so they join the first day.
        Measured 2026-10-16: 50 WIP001 tickets, 934.40 t, weighed 30 Jun
        15:01–23:58 and imported 2 Jul 18:09 — the Excel's 30-Jun limestone
        receipt is 2,257.86 t against 3,192.26 t weighed. With them the roll
        lands on the plant's own 30-Aug closing (3,335.22) and on Odoo's live
        pile to the tonne; without them both are short by exactly 934.4 t.
        No clay or ID-clay ticket straddles the anchor. */
  const anchorCatchUp = {};
  if (catchUpAnchor && from === addDays(catchUpAnchor, 1) && plan.transferCodes.length) {
    const rows = await query(`
      SELECT pp.default_code AS code, SUM(t.product_uom_qty)::float AS q, COUNT(*)::int AS n
        FROM custom_mining_transfer t
        JOIN product_product pp ON pp.id = t.product_id
        JOIN stock_location dl  ON dl.id = t.dest_location_id
       WHERE t.state = 'complete' AND dl.complete_name ILIKE $2 AND pp.default_code = ANY($3)
         AND t.gross_date >= ($1::date - 10)
         AND ((t.gross_date AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')::date <= $1::date
         AND ((t.creation_date AT TIME ZONE 'UTC') AT TIME ZONE '${TZ}')::date > $1::date
       GROUP BY 1`, [catchUpAnchor, PILE_LOCATION_LIKE, plan.transferCodes]);
    for (const r of rows) {
      add(from, `transfer:${r.code}`, r.q);
      anchorCatchUp[r.code] = { qty: r3(r.q), tickets: r.n };
    }
  }

  /* 3. Production-entry consumption (complete entries only). */
  if (plan.lineCodes.length) {
    const rows = await query(`
      SELECT e.date::text AS d, e.type, pp.default_code AS code, SUM(l.quantity)::float AS q
        FROM custom_production_entry e
        JOIN custom_production_entry_line l ON l.production_id = e.id
        JOIN product_product pp ON pp.id = l.product_id
       WHERE e.state = 'complete' AND e.date BETWEEN $1 AND $2
         AND e.type = ANY($3) AND pp.default_code = ANY($4)
       GROUP BY 1, 2, 3`, [from, to, plan.lineTypes, plan.lineCodes]);
    for (const r of rows) add(r.d, `line:${r.type}:${r.code}`, r.q);
  }

  /* 4. Production entries: output of complete ones, and the open ones that
        keep a day unsettled. An entry with no quantity at all is an empty
        form, not a day's production, and does not block anything. */
  const entryRows = await query(`
    SELECT e.date::text AS d, e.type, e.state, e.name,
           COALESCE(e.production_qty, 0)::float AS p,
           COALESCE(e.total_input_qty, 0)::float AS i
      FROM custom_production_entry e
     WHERE e.date BETWEEN $1 AND $2 AND e.state <> 'cancel' AND e.type = ANY($3)`,
    [from, to, plan.prodTypes]);
  for (const r of entryRows) {
    if (r.state === 'complete') add(r.d, `prod:${r.type}`, r.p);
    else if (r.p > 0 || r.i > 0) addPending(r.type, r.d, { name: r.name, state: r.state, qty: r3(r.p) });
  }

  /* 5. CPP coal burn. */
  const cppRows = await query(`
    SELECT date::text AS d, state, SUM(COALESCE(coal_consumption, 0))::float AS q, COUNT(*)::int AS n
      FROM cpp_entry
     WHERE date BETWEEN $1 AND $2 AND state <> 'cancel'
     GROUP BY 1, 2`, [from, to]);
  for (const r of cppRows) {
    if (r.state === 'complete') { add(r.d, 'cpp_burn', r.q); cppDays.add(r.d); }
    else if (r.q > 0) addPending('cpp', r.d, { name: `${r.n} CPP entr${r.n > 1 ? 'ies' : 'y'}`, state: r.state, qty: r3(r.q) });
  }

  /* 6. The frontier: the latest day each process has a COMPLETE entry for,
        not bounded above — a day is only settled once a later one exists. */
  const lastComplete = {};
  const prodLast = await query(`
    SELECT type, MAX(date)::text AS d FROM custom_production_entry
     WHERE state = 'complete' AND date >= $1 AND type = ANY($2) GROUP BY type`, [from, plan.prodTypes]);
  for (const r of prodLast) lastComplete[r.type] = r.d;
  const [cppLast] = await query(`SELECT MAX(date)::text AS d FROM cpp_entry WHERE state = 'complete' AND date >= $1`, [from]);
  if (cppLast && cppLast.d) lastComplete.cpp = cppLast.d;
  const [mineLast] = await query(`
    SELECT ${eatDay('MAX(t.gross_date)')} AS d
      FROM custom_mining_transfer t JOIN stock_location dl ON dl.id = t.dest_location_id
     WHERE t.state = 'complete' AND dl.complete_name ILIKE $2 AND t.gross_date >= ($1::date - 1)`,
    [from, PILE_LOCATION_LIKE]);
  if (mineLast && mineLast.d) lastComplete.mining = mineLast.d;

  return { byDay, cppDays, pending, lastComplete, unknownCoalVendors, anchorCatchUp };
}

/* ── the roll (pure — unit-tested in test/odoo-stock-ledger.test.js) ── */

function flowValue(spec, flows, cppDays, d) {
  const day = flows[d] || {};
  let has = false, total = 0;
  for (const k of spec.flows) {
    if (k === 'cpp_burn') {
      if (cppDays && cppDays.has(d)) has = true;
    } else if (k in day) has = true;
    total += Number(day[k]) || 0;
  }
  return { has, total: r3(total) };
}

/* Is day `d` settled in Odoo for this ledger? See rule 2 in the header. */
function settledFor(ledger, d, { today, pending = {}, lastComplete = {} }) {
  if (d >= today) return { ok: false, reason: `${d} is today — it is not over yet` };
  const transferCodes = new Set(ledger.inflows.flatMap(s => s.flows)
    .filter(k => k.startsWith('transfer:')).map(k => k.split(':')[1]));
  for (const t of ledger.dependsOn) {
    const dep = DEPENDENCY_TYPES[t];
    let open = (pending[t] && pending[t][d]) || [];
    if (t === 'mining') open = open.filter(e => transferCodes.has(e.code));
    if (open.length) {
      const what = open.map(e => `${e.name} (${e.state}${e.qty ? `, ${e.qty} t` : ''})`).join(', ');
      return { ok: false, reason: `Odoo ${dep.label} entries for ${d} are not approved yet: ${what} — approve or cancel them in Odoo` };
    }
    /* A complete entry must already exist `frontierDays` later — see
       DEPENDENCY_TYPES for why cement needs two days and the rest one. */
    const last = lastComplete[t];
    const needed = addDays(d, dep.frontierDays || 1);
    if (!last || last < needed) {
      return { ok: false, reason: `waiting for Odoo's ${dep.label} entries up to ${needed} (approved so far: up to ${last || 'none'}) — Odoo books each day after it ends` };
    }
  }
  return { ok: true, reason: null };
}

/* Opening for one day. `carry` is the published carry-in (null = unknown);
   returns the internal opening, what to write, and whether a person's typed
   figure re-anchored the roll. */
function openingFor(ledger, { carry, data, mine }) {
  const [primary, ...rest] = ledger.open;
  const writes = {}, removes = [], kept = [];
  const human = f => isHumanValue(data && data[f], mine[f]);

  if (human(primary)) {
    /* A typed opening re-anchors the pile at the person's total. */
    let total = num(data[primary]);
    kept.push(primary);
    for (const f of rest) if (human(f)) { total += num(data[f]); kept.push(f); }
    return { opening: total, writes, removes, kept, humanAnchor: true };
  }

  const humanRest = rest.filter(human);
  kept.push(...humanRest);
  const restTotal = humanRest.reduce((s, f) => s + num(data[f]), 0);
  /* this robot's own stale values in the secondary fields: never ours to keep */
  for (const f of rest) if (!humanRest.includes(f) && mine[f] !== undefined && data && f in data) removes.push(f);

  if (carry === null || carry === undefined) {
    if (mine[primary] !== undefined && data && primary in data) removes.push(primary);
    return { opening: null, writes, removes, kept, humanAnchor: false };
  }
  const value = r3(carry - restTotal);
  if (value < -TOL) {
    /* The officer's split leaves less than nothing for the primary row —
       their figure and the carried pile disagree; leave it for them. */
    if (mine[primary] !== undefined && data && primary in data) removes.push(primary);
    return { opening: null, writes, removes, kept, humanAnchor: false,
      reason: `the typed ${humanRest.join(', ')} (${r3(restTotal)} t) exceeds the carried pile (${r3(carry)} t)` };
  }
  writes[primary] = value;
  return { opening: carry, writes, removes, kept, humanAnchor: false };
}

/* One flow field (an inflow or outflow) for one day -> its value in the
   roll, plus what to write/remove for it. `odoo` is Odoo's own figure for
   the same field, whatever the row says — the basis the on-hand comparison
   uses (see compareWithOnHand). */
function fieldFor(spec, { data, mine, flows, cppDays, d }) {
  const stored = data ? data[spec.field] : undefined;
  const odoo = flowValue(spec, flows, cppDays, d);
  const o = odoo.total || 0;
  if (!spec.write) {
    /* Owned by the production autofill: read, never write. */
    const v = num(stored);
    if (v !== null) return { value: v, odoo: o, fallback: false };
    return { value: o, odoo: o, fallback: odoo.has && o !== 0 };
  }
  if (isHumanValue(stored, mine[spec.field])) return { value: num(stored), odoo: o, kept: spec.field };
  const want = odoo.has && (o > TOL || spec.positiveZero) ? o : null;
  if (want === null) {
    const remove = mine[spec.field] !== undefined && data && spec.field in data;
    return { value: 0, odoo: o, remove: remove ? spec.field : null };
  }
  const same = num(stored) !== null && Math.abs(num(stored) - want) <= TOL;
  return { value: want, odoo: o, write: same && mine[spec.field] !== undefined ? null : { [spec.field]: want } };
}

/* Roll ONE ledger across `days`. Pure.
   start: { balance, valid, reason } — the carry-in for the first day
          (the anchor closing, or this table's stored state the day before).
   rows:  day -> { data } (the production row, or absent)
   mine:  day -> { field: value } this robot wrote last time for this ledger */
function rollLedger(ledger, { days, start, flows = {}, cppDays = new Set(), rows = {}, mine = {}, settled }) {
  const out = [];
  let bal = start.balance;
  let valid = !!start.valid && bal !== null && bal !== undefined;
  let chainReason = start.reason || (valid ? null : 'no opening stock to start from');
  let prevClosing = valid && bal >= -TOL ? bal : null;
  let prevNegReason = valid && bal < -TOL ? `the roll put this pile below zero (${r3(bal)} t) at the end of the previous day` : null;
  /* The same roll on Odoo's figures alone — no stored values, no typed
     anchors — so "the plant's 30-Jun book + everything Odoo has approved
     since" can be compared with Odoo's live stock (compareWithOnHand). */
  let odooBal = bal === null || bal === undefined ? null : bal;

  for (const d of days) {
    const data = rows[d] ? rows[d].data || {} : null;
    const m = mine[d] || {};
    const res = { date: d, ledger: ledger.key, writes: {}, removes: [], kept: [], fallbacks: [] };

    /* Opening: published carry-in only while the chain is sound. */
    const carry = ledger.publish && valid ? prevClosing : null;
    const op = openingFor(ledger, { carry, data, mine: m });
    Object.assign(res.writes, op.writes);
    res.removes.push(...op.removes);
    res.kept.push(...op.kept);
    if (op.humanAnchor) {
      bal = op.opening; valid = true; chainReason = null;
    }
    const openingInternal = bal;
    res.opening = op.opening === null || op.opening === undefined ? null : r3(op.opening);

    let inflow = 0, outflow = 0, odooNet = 0;
    for (const [list, sign] of [[ledger.inflows, 1], [ledger.outflows, -1]]) {
      for (const spec of list) {
        const f = fieldFor(spec, { data, mine: m, flows, cppDays, d });
        if (ledger.publish) {
          if (f.write) Object.assign(res.writes, f.write);
          if (f.remove) res.removes.push(f.remove);
        }
        if (f.kept) res.kept.push(f.kept);
        if (f.fallback) res.fallbacks.push(spec.field);
        if (sign > 0) inflow += f.value; else outflow += f.value;
        odooNet += sign * f.odoo;
      }
    }
    res.inflow = r3(inflow);
    res.outflow = r3(outflow);
    if (odooBal !== null) odooBal += odooNet;
    res.odooBalance = r3(odooBal);
    bal = (openingInternal === null || openingInternal === undefined ? 0 : openingInternal) + inflow - outflow;
    res.balance = r3(bal);

    const st = settled(ledger, d);
    res.settled = st.ok;
    if (!ledger.publish) {
      res.status = 'held'; res.reason = ledger.heldReason || 'not published'; res.closing = null;
    } else if (!valid) {
      res.status = op.humanAnchor ? 'human_anchor' : 'broken';
      res.reason = `opening not known: ${chainReason}`; res.closing = null;
    } else if (res.opening === null) {
      /* chain is sound but today's opening is withheld (carry negative, or
         an officer's split that does not fit) */
      res.status = 'broken';
      res.reason = `opening not written: ${op.reason || prevNegReason || chainReason || 'carry unavailable'}`;
      res.closing = null;
    } else if (!st.ok) {
      res.status = 'unsettled'; res.reason = st.reason; res.closing = null;
    } else if (bal < -TOL) {
      res.status = 'negative';
      res.reason = `Odoo's flows put this pile at ${r3(bal)} t at the end of ${d} — an entry is probably dated on the wrong day; left blank rather than published negative`;
      res.closing = null;
    } else {
      res.status = op.humanAnchor ? 'human_anchor' : 'ok';
      res.reason = null;
      res.closing = r3(bal);
    }
    if (ledger.publish && ledger.splitNote && res.status === 'ok') res.note = ledger.splitNote;

    /* Carry into tomorrow. An unsettled day poisons everything after it
       until Odoo settles it (or a person types an opening); a negative day
       does not — see rule 3. */
    if (!st.ok && valid) { valid = false; chainReason = `${d} is not settled — ${st.reason}`; }
    prevClosing = valid && bal >= -TOL ? bal : null;
    prevNegReason = valid && bal < -TOL ? `Odoo's flows put this pile at ${r3(bal)} t at the end of ${d}` : null;
    out.push(res);
  }
  return out;
}

/* Closing of a ledger from a stored report row, by the page's own formula. */
function closingFromRow(ledger, data) {
  if (!data) return null;
  let total = 0, seen = false;
  for (const f of ledger.open) { const v = num(data[f]); if (v !== null) { total += v; seen = true; } }
  if (!seen) return null;
  for (const s of ledger.inflows) total += num(data[s.field]) || 0;
  for (const s of ledger.outflows) total -= num(data[s.field]) || 0;
  return r3(total);
}

/* ── local reads/writes ──────────────────────────────────────────────── */

async function loadRows(from, to) {
  const { rows } = await db.query(
    `SELECT record_date::text AS d, data, submitted_by, updated_by
       FROM daily_reports
      WHERE form_type = $1 AND shift = $2 AND record_date BETWEEN $3 AND $4`,
    [FORM_TYPE, SHIFT, from, to]);
  return Object.fromEntries(rows.map(r => [r.d, r]));
}

async function loadMine(from, to) {
  const { rows } = await db.query(
    `SELECT record_date::text AS d, ledger_key, written FROM odoo_stock_ledger
      WHERE record_date BETWEEN $1 AND $2`, [from, to]);
  const out = {};
  for (const r of rows) ((out[r.ledger_key] = out[r.ledger_key] || {})[r.d] = r.written || {});
  return out;
}

async function anchorStarts(ledgers) {
  const { rows } = await db.query(
    `SELECT data FROM daily_reports WHERE form_type = $1 AND record_date = $2 AND shift = $3`,
    [ANCHOR.formType, ANCHOR.date, ANCHOR.shift]);
  const data = rows[0] ? rows[0].data : null;
  const out = {};
  for (const l of ledgers) {
    const c = closingFromRow(l, data);
    out[l.key] = c === null
      ? { balance: null, valid: false, reason: `the ${ANCHOR.date} report has no ${l.label} stock to start from` }
      : { balance: c, valid: true, reason: null };
  }
  return out;
}

/* The incremental live window starts from this table's own state the day
   before. Returns null when any published ledger cannot be continued from
   there (no row, or its chain was not sound) — the caller then rebuilds. */
async function storedStarts(ledgers, dayBefore) {
  const { rows } = await db.query(
    `SELECT ledger_key, balance, status, reason FROM odoo_stock_ledger WHERE record_date = $1`, [dayBefore]);
  const byKey = Object.fromEntries(rows.map(r => [r.ledger_key, r]));
  const out = {};
  for (const l of ledgers) {
    const r = byKey[l.key];
    const sound = r && ['ok', 'negative', 'human_anchor'].includes(r.status);
    if (l.publish && !sound) return null;
    out[l.key] = r && r.balance !== null
      ? { balance: Number(r.balance), valid: !!sound, reason: sound ? null : r.reason }
      : { balance: null, valid: false, reason: 'no stored state' };
  }
  return out;
}

/* Write one day: every ledger's field changes in ONE transaction, with the
   row re-read under FOR UPDATE so a person saving the same day between our
   read and this write is never overwritten (rule 4 is re-checked here, on
   the fresh row). The data change is an atomic jsonb merge — other writers'
   fields (production autofill, power copy, crusher hours) are untouched. */
async function writeDay(date, dayResults, { client: given } = {}) {
  const client = given || await db.connect();
  const summary = { created: false, updated: false, fieldsWritten: 0, fieldsRemoved: 0, keptOnRecheck: 0 };
  try {
    await client.query('BEGIN');
    const ex = await client.query(
      `SELECT data, status, approved_by, approved_at FROM daily_reports
        WHERE form_type = $1 AND record_date = $2 AND shift = $3 FOR UPDATE`,
      [FORM_TYPE, date, SHIFT]);
    const row = ex.rows[0] || null;
    const data = row ? row.data || {} : {};

    const patch = {}, remove = [];
    for (const res of dayResults) {
      const mine = res.mineBefore || {};
      for (const [f, v] of Object.entries(res.writes)) {
        if (isHumanValue(data[f], mine[f])) { summary.keptOnRecheck++; res.kept.push(f); delete res.writes[f]; continue; }
        if (num(data[f]) !== null && Math.abs(num(data[f]) - v) <= TOL && f in data) continue;
        patch[f] = v;
      }
      for (const f of res.removes) {
        if (f in data && mine[f] !== undefined && !isHumanValue(data[f], mine[f])) remove.push(f);
      }
    }

    const changed = Object.keys(patch).length + remove.length > 0;
    if (changed) {
      if (!row) {
        await client.query(
          `INSERT INTO daily_reports (form_type, record_date, shift, data, status)
           VALUES ($1, $2, $3, $4::jsonb, 'approved')
           ON CONFLICT (form_type, record_date, shift)
           DO UPDATE SET data = daily_reports.data || EXCLUDED.data, updated_at = NOW()`,
          [FORM_TYPE, date, SHIFT, JSON.stringify(patch)]);
        summary.created = true;
      } else {
        await client.query(
          `UPDATE daily_reports SET data = (data - $4::text[]) || $5::jsonb, updated_at = NOW()
            WHERE form_type = $1 AND record_date = $2 AND shift = $3`,
          [FORM_TYPE, date, SHIFT, remove, JSON.stringify(patch)]);
        summary.updated = true;
      }
      await recordRevision(client, {
        formType: FORM_TYPE, recordDate: date, shift: SHIFT, action: 'ODOO_AUTOFILL',
        priorData: row ? row.data : null,
        priorStatus: row ? row.status : null,
        priorApprovedBy: row ? row.approved_by : null,
        priorApprovedAt: row ? row.approved_at : null,
        changedFields: [...Object.keys(patch), ...remove].sort(),
        actorId: null,
        actorName: 'odoo-sync',
        reason: `Stock ledger from Odoo (opening carried from the plant's ${ANCHOR.date} closing)`,
      });
      summary.fieldsWritten = Object.keys(patch).length;
      summary.fieldsRemoved = remove.length;
    }

    /* What this robot now owns per ledger: what it just wrote, plus what it
       wrote before and still stands untouched. A field a person changed
       drops out, and from then on is theirs. */
    const finalData = { ...data, ...patch };
    for (const f of remove) delete finalData[f];
    const values = [], tuples = [];
    for (const res of dayResults) {
      const owned = {};
      const candidates = new Set([...Object.keys(res.mineBefore || {}), ...Object.keys(res.writes)]);
      for (const f of candidates) {
        if (res.kept.includes(f)) continue;
        const v = num(finalData[f]);
        if (v === null) continue;
        const ours = f in res.writes ? res.writes[f] : (res.mineBefore || {})[f];
        if (ours !== undefined && Math.abs(v - Number(ours)) <= TOL) owned[f] = v;
      }
      const b = values.length;
      values.push(date, res.ledger, res.opening, res.inflow, res.outflow, res.balance, res.closing,
        res.settled, res.status, res.reason, JSON.stringify(owned));
      tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11}::jsonb, NOW())`);
    }
    if (tuples.length) {
      await client.query(`
        INSERT INTO odoo_stock_ledger
          (record_date, ledger_key, opening, inflow, outflow, balance, closing, settled, status, reason, written, computed_at)
        VALUES ${tuples.join(',')}
        ON CONFLICT (record_date, ledger_key) DO UPDATE SET
          opening = EXCLUDED.opening, inflow = EXCLUDED.inflow, outflow = EXCLUDED.outflow,
          balance = EXCLUDED.balance, closing = EXCLUDED.closing, settled = EXCLUDED.settled,
          status = EXCLUDED.status, reason = EXCLUDED.reason, written = EXCLUDED.written,
          computed_at = NOW()`, values);
    }
    await client.query('COMMIT');
    return summary;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* the original error is what matters */ });
    throw err;
  } finally {
    if (!given) client.release();
  }
}

/* ── comparison with Odoo's live on-hand ─────────────────────────────── */

/* Odoo's live on-hand per product: every internal location, and the plant's
   WIP pile location alone. */
async function fetchOnHand(codes, { query = odooDb.query } = {}) {
  const rows = await query(`
    SELECT pp.default_code AS code, (sl.complete_name ILIKE $2) AS pile, SUM(q.quantity)::float AS qty
      FROM stock_quant q
      JOIN stock_location sl  ON sl.id = q.location_id
      JOIN product_product pp ON pp.id = q.product_id
     WHERE sl.usage = 'internal' AND pp.default_code = ANY($1)
     GROUP BY 1, 2`, [codes, PILE_LOCATION_LIKE]);
  const live = {};
  for (const r of rows) {
    const e = (live[r.code] = live[r.code] || { internal: 0, pile: 0 });
    e.internal += r.qty;
    if (r.pile) e.pile += r.qty;
  }
  return { live };
}

/* Pure. Two comparisons per ledger, on purpose:

     odooRoll vs odooLive   the plant's anchor + every flow Odoo has APPROVED
                            to this moment, against Odoo's live stock. Same
                            basis on both sides (an approved entry is a
                            validated stock move), so any difference is a
                            movement this ledger does not model — a manual
                            quantity update, a stores issue, a return to the
                            supplier — and config/odooStockLedger.js names the
                            known ones.
     ledger vs odooRoll     the report's own running balance (stored values,
                            typed figures) against the same roll on Odoo's
                            figures — non-zero when a person changed a figure
                            or the production autofill has not caught up.

   An earlier version rolled Odoo's live stock BACK to the end of the last
   published day by move date. That compared two different calendars: an
   entry counts on its entry date, but its stock moves are validated the
   next morning — clay read 1.4 t against 1.4 t live yet showed a 25 t
   "difference". Comparing "everything approved so far" on both sides
   removes the calendar from the question. */
function compareWithOnHand(ledgers, finals, { live }) {
  const out = [];
  for (const l of ledgers) {
    const f = finals[l.key];
    const scope = l.onhand.scope;
    let liveQty = 0;
    for (const c of l.onhand.codes) {
      const e = live[c] || { internal: 0, pile: 0 };
      liveQty += scope === 'pile' ? e.pile : e.internal;
    }
    if (!f || f.odooRoll === null || f.odooRoll === undefined) {
      out.push({ ledger: l.key, label: l.label, published: l.publish, odooLive: r3(liveQty), odooRoll: null, diff: null, matches: null,
        note: 'no anchor to roll from' });
      continue;
    }
    const diff = r3(f.odooRoll - liveQty);
    out.push({
      ledger: l.key, label: l.label, published: l.publish, scope,
      odooRoll: f.odooRoll, odooLive: r3(liveQty), diff,
      matches: Math.abs(diff) <= ONHAND_TOLERANCE_MT,
      ledgerBalance: f.ledgerBalance,
      ledgerVsOdoo: f.ledgerBalance === null || f.ledgerBalance === undefined ? null : r3(f.ledgerBalance - f.odooRoll),
      lastClosingDate: f.lastClosingDate, lastClosing: f.lastClosing,
    });
  }
  return out;
}

/* ── the pull ────────────────────────────────────────────────────────── */

async function lastFullRunAt() {
  const { rows } = await db.query(
    `SELECT started_at FROM odoo_stock_ledger_runs WHERE mode = 'full' ORDER BY started_at DESC LIMIT 1`);
  return rows[0] ? new Date(rows[0].started_at).getTime() : null;
}

/* opts:
     mode    'auto' (live default) | 'full' | 'incremental'
     to      last day (default: today EAT; never later)
     dryRun  compute and compare, write nothing
     detail  include every day's result per ledger in the return value  */
async function pullStockLedger({ mode = 'auto', to, dryRun = false, detail = false, now = new Date() } = {}) {
  if (!odooDb.isConfigured()) return { skipped: 'odoo db not configured' };

  const today = todayEAT(now);
  const end = to && to < today ? to : today;
  const firstDay = addDays(ANCHOR.date, 1);
  const ledgers = LEDGERS;

  let runMode = mode;
  if (mode === 'auto') {
    const last = await lastFullRunAt();
    runMode = !last || (now.getTime() - last) / 3600000 >= FULL_REBUILD_HOURS ? 'full' : 'incremental';
  }
  let from = firstDay, starts;
  if (runMode === 'incremental') {
    from = addDays(end, -(LIVE_WINDOW_DAYS - 1));
    if (from <= firstDay) { runMode = 'full'; from = firstDay; }
    else {
      starts = await storedStarts(ledgers, addDays(from, -1));
      if (!starts) { runMode = 'full'; from = firstDay; }
    }
  }
  if (runMode === 'full') starts = await anchorStarts(ledgers);

  const days = dayRange(from, end);
  const flows = await fetchFlows(from, end, { ledgers, catchUpAnchor: runMode === 'full' ? ANCHOR.date : null });
  const rows = await loadRows(from, end);
  const mineAll = await loadMine(from, end);
  const ctx = { today, pending: flows.pending, lastComplete: flows.lastComplete };
  const settled = (ledger, d) => settledFor(ledger, d, ctx);

  const perLedger = {};
  for (const l of ledgers) {
    perLedger[l.key] = rollLedger(l, {
      days, start: starts[l.key], flows: flows.byDay, cppDays: flows.cppDays,
      rows, mine: mineAll[l.key] || {}, settled,
    });
  }

  const summary = {
    mode: dryRun ? `${runMode} (dry run)` : runMode, from, to: end, days: days.length,
    rowsCreated: 0, rowsUpdated: 0, fieldsWritten: 0, fieldsRemoved: 0,
    humanValuesKept: 0, consumptionFallbacks: 0,
    unknownCoalVendors: flows.unknownCoalVendors,
    anchorCatchUp: flows.anchorCatchUp,
    ledgers: {},
  };

  for (const d of days) {
    const dayResults = ledgers.map(l => {
      const res = perLedger[l.key].find(r => r.date === d);
      res.mineBefore = (mineAll[l.key] || {})[d] || {};
      return res;
    });
    summary.humanValuesKept += dayResults.reduce((s, r) => s + r.kept.length, 0);
    summary.consumptionFallbacks += dayResults.reduce((s, r) => s + r.fallbacks.length, 0);
    if (dryRun) {
      summary.fieldsWritten += dayResults.reduce((s, r) => s + Object.keys(r.writes).length, 0);
      continue;
    }
    const w = await writeDay(d, dayResults);
    if (w.created) summary.rowsCreated++;
    if (w.updated) summary.rowsUpdated++;
    summary.fieldsWritten += w.fieldsWritten;
    summary.fieldsRemoved += w.fieldsRemoved;
  }

  /* Latest published closing per ledger, and the reason the days after it
     are blank — what an officer or the MIS reader needs to know. */
  const finals = {};
  for (const l of ledgers) {
    const list = perLedger[l.key];
    const lastPub = [...list].reverse().find(r => r.closing !== null);
    const tail = list[list.length - 1];
    finals[l.key] = {
      odooRoll: tail ? tail.odooBalance : null,
      ledgerBalance: tail ? tail.balance : null,
      lastClosingDate: lastPub ? lastPub.date : null,
      lastClosing: lastPub ? lastPub.closing : null,
    };
    summary.ledgers[l.key] = {
      published: l.publish,
      lastClosingDate: lastPub ? lastPub.date : null,
      lastClosing: lastPub ? lastPub.closing : null,
      latestStatus: tail ? tail.status : null,
      latestReason: tail ? tail.reason : null,
      wouldBe: l.publish ? undefined : (tail ? tail.balance : null),
      negativeDays: list.filter(r => r.status === 'negative').map(r => r.date),
    };
  }

  /* Odoo's live stock, recorded every run, compared with the roll. */
  const codes = [...new Set(ledgers.flatMap(l => l.onhand.codes))];
  const onhand = await fetchOnHand(codes);
  const comparison = compareWithOnHand(ledgers, finals, onhand);
  summary.comparison = comparison;
  summary.mismatches = comparison.filter(c => c.published && c.diff !== null && !c.matches)
    .map(c => ({ ledger: c.ledger, odooRoll: c.odooRoll, odooLive: c.odooLive, diff: c.diff }));

  if (!dryRun) {
    const values = [], tuples = [];
    for (const [code, e] of Object.entries(onhand.live)) {
      for (const scope of ['internal', 'pile']) {
        const b = values.length;
        values.push(code, scope, r3(e[scope]));
        tuples.push(`($${b + 1},$${b + 2},$${b + 3})`);
      }
    }
    if (tuples.length) {
      await db.query(`INSERT INTO odoo_stock_onhand (product_code, scope, qty) VALUES ${tuples.join(',')}`, values);
    }
    const prev = await db.query(
      `SELECT result->'mismatches' AS m FROM odoo_stock_ledger_runs WHERE mode <> 'dry_run' ORDER BY started_at DESC LIMIT 1`);
    const key = ms => JSON.stringify((ms || []).map(x => [x.ledger, Math.round(x.diff)]));
    if (summary.mismatches.length && (!prev.rows[0] || key(prev.rows[0].m) !== key(summary.mismatches))) {
      logger.warn({ mismatches: summary.mismatches },
        'odoo stock ledger: ledger closing differs from Odoo on-hand — see config/odooStockLedger.js for the known reconciling items');
    }
    await db.query(
      `INSERT INTO odoo_stock_ledger_runs (mode, from_date, to_date, result) VALUES ($1, $2, $3, $4::jsonb)`,
      [runMode, from, end, JSON.stringify(summary)]);
  }

  if (detail) summary.detail = perLedger;
  return summary;
}

/* ── readers for other services (MIS) ────────────────────────────────── */

/* date -> { <ledger_key>: { closing, opening, status, reason, settled, label } }
   or null when there is nothing computed for that date (table missing,
   pull never run here, or a date before the roll begins). */
async function closingsFor(date) {
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT ledger_key, opening, closing, status, reason, settled FROM odoo_stock_ledger WHERE record_date = $1`,
      [date]));
  } catch (err) {
    logger.warn({ err: err.message }, 'odoo stock ledger: closingsFor unavailable (is migration 043 applied?)');
    return null;
  }
  if (!rows.length) return null;
  const labels = Object.fromEntries(LEDGERS.map(l => [l.key, l.label]));
  return Object.fromEntries(rows.map(r => [r.ledger_key, {
    label: labels[r.ledger_key] || r.ledger_key,
    opening: num(r.opening), closing: num(r.closing),
    status: r.status, reason: r.reason, settled: r.settled,
  }]));
}

module.exports = {
  LIVE_WINDOW_DAYS, FULL_REBUILD_HOURS, ONHAND_TOLERANCE_MT,
  todayEAT, addDays, dayRange, isHumanValue, flowPlan,
  settledFor, openingFor, fieldFor, rollLedger, closingFromRow, compareWithOnHand,
  fetchFlows, fetchOnHand, writeDay, pullStockLedger, closingsFor,
};
