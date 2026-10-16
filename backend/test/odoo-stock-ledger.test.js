/*
  test/odoo-stock-ledger.test.js — the pure half of the Production Report
  stock ledger (services/odooStockLedger.js): the roll-forward itself and
  every guard that decides whether a figure may be written. No database,
  no Odoo.

  The properties under test are the ones that make the ledger safe to run
  unattended against the plant's report:

    1. open(D) = close(D−1), exactly as the plant's own sheet carries it,
       with consumption read from the stored report row.
    2. A closing below zero is never published or carried as an opening —
       but the arithmetic continues, so the chain resumes when it recovers.
    3. A day Odoo has not finished (open entries, or no later entry yet)
       publishes no closing, and nothing after it carries an opening.
    4. A figure a person typed is never overwritten; a typed opening
       re-anchors the roll.
    5. No fabricated zeros: no receipt means no receipt field.
    6. Coal: the whole pile on the Kiln row, the CPP opening left to the
       officer, the total exact either way.

  Usage: node --test test/odoo-stock-ledger.test.js   (from backend/)
*/
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isHumanValue, settledFor, rollLedger, closingFromRow, compareWithOnHand, flowPlan, dayRange,
} = require('../services/odooStockLedger');
const { LEDGERS, DEPENDENCY_TYPES } = require('../config/odooStockLedger');

const IRON = {
  key: 'iron_ore', label: 'Iron Ore', unit: 'MT',
  open: ['rmm_ironore_open'],
  inflows: [{ field: 'rmm_ironore_recv', write: true, flows: ['recv:RM000004'] }],
  outflows: [{ field: 'rmm_ironore_cons', write: false, flows: ['line:raw_meal:RM000004'] }],
  dependsOn: ['raw_meal'],
  onhand: { codes: ['RM000004'], scope: 'internal' },
  publish: true,
};
const COAL = LEDGERS.find(l => l.key === 'coal');

const always = () => ({ ok: true, reason: null });
const start = (balance) => ({ balance, valid: true, reason: null });
const rows = (byDay) => Object.fromEntries(Object.entries(byDay).map(([d, data]) => [d, { data }]));

// ── 1. the roll ─────────────────────────────────────────────────────────

test('roll: opening(D) = closing(D-1); receipts written, consumption read from the row', () => {
  const days = ['2026-07-01', '2026-07-02', '2026-07-03'];
  const out = rollLedger(IRON, {
    days, start: start(1148.32), settled: always,
    flows: { '2026-07-01': { 'recv:RM000004': 100 }, '2026-07-03': { 'recv:RM000004': 30.5 } },
    rows: rows({ '2026-07-01': { rmm_ironore_cons: 43 }, '2026-07-02': { rmm_ironore_cons: 50 }, '2026-07-03': { rmm_ironore_cons: 0 } }),
  });
  assert.deepEqual(out.map(r => r.opening), [1148.32, 1205.32, 1155.32]);
  assert.deepEqual(out.map(r => r.closing), [1205.32, 1155.32, 1185.82]);
  assert.deepEqual(out[0].writes, { rmm_ironore_open: 1148.32, rmm_ironore_recv: 100 });
  // 2 Jul: no receipt -> NO receipt field (not a fabricated 0)
  assert.deepEqual(out[1].writes, { rmm_ironore_open: 1205.32 });
  // consumption is never written by the ledger
  for (const r of out) assert.equal('rmm_ironore_cons' in r.writes, false);
});

test('roll: stored consumption wins over Odoo\'s figure, Odoo fills a missing one', () => {
  const out = rollLedger(IRON, {
    days: ['2026-07-01', '2026-07-02'], start: start(100), settled: always,
    flows: { '2026-07-01': { 'line:raw_meal:RM000004': 99 }, '2026-07-02': { 'line:raw_meal:RM000004': 20 } },
    rows: rows({ '2026-07-01': { rmm_ironore_cons: 10 }, '2026-07-02': {} }),
  });
  assert.equal(out[0].closing, 90);              // stored 10, not Odoo's 99
  assert.equal(out[1].closing, 70);              // row lacks it -> Odoo's 20
  assert.deepEqual(out[1].fallbacks, ['rmm_ironore_cons']);
  assert.equal(out[1].odooBalance, 100 - 99 - 20);   // the Odoo-only roll ignores the row
});

// ── 2. negative guard ───────────────────────────────────────────────────

test('negative guard: a closing below zero is never published nor carried, and the chain resumes', () => {
  const days = ['2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11'];
  const out = rollLedger(IRON, {
    days, start: start(11.21), settled: always,
    flows: { '2026-08-10': { 'recv:RM000004': 555 } },
    rows: rows({ '2026-08-08': { rmm_ironore_cons: 0 }, '2026-08-09': { rmm_ironore_cons: 274 },
      '2026-08-10': { rmm_ironore_cons: 277 }, '2026-08-11': { rmm_ironore_cons: 0 } }),
  });
  assert.equal(out[1].status, 'negative');
  assert.equal(out[1].closing, null);
  assert.equal(out[1].balance, -262.79);
  // the next day's opening is NOT written (it would be negative) ...
  assert.equal(out[2].opening, null);
  assert.equal('rmm_ironore_open' in out[2].writes, false);
  assert.match(out[2].reason, /-262\.79/);
  // ... but its receipt still is, and the arithmetic carries on
  assert.equal(out[2].writes.rmm_ironore_recv, 555);
  assert.equal(out[2].balance, 15.21);
  // and the chain is published again once it is back above zero
  assert.equal(out[3].opening, 15.21);
  assert.equal(out[3].closing, 15.21);
  assert.equal(out[3].status, 'ok');
});

test('negative guard: an anchor that is already negative publishes nothing until it recovers', () => {
  const out = rollLedger(IRON, {
    days: ['2026-07-01'], start: start(-5), settled: always,
    flows: {}, rows: rows({ '2026-07-01': { rmm_ironore_cons: 0 } }),
  });
  assert.equal(out[0].opening, null);
  assert.equal(out[0].closing, null);
  assert.deepEqual(out[0].writes, {});
});

// ── 3. unsettled days ───────────────────────────────────────────────────

test('unsettled: no closing for the day, and nothing after it carries an opening', () => {
  const days = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'];
  const settled = (l, d) => (d >= '2026-10-13' ? { ok: false, reason: 'raw meal entry RML/2026/00188 is still confirm' } : { ok: true });
  const out = rollLedger(IRON, {
    days, start: start(100), settled,
    flows: { '2026-10-14': { 'recv:RM000004': 40 } },
    rows: rows({ '2026-10-12': { rmm_ironore_cons: 10 }, '2026-10-13': { rmm_ironore_cons: 10 }, '2026-10-14': {}, '2026-10-15': {} }),
  });
  assert.equal(out[0].closing, 90);
  // 13th: its own opening is known (depends only on the 12th) ...
  assert.equal(out[1].opening, 90);
  assert.equal(out[1].writes.rmm_ironore_open, 90);
  // ... but its closing is not
  assert.equal(out[1].closing, null);
  assert.equal(out[1].status, 'unsettled');
  // 14th and 15th: opening withheld with the reason that blocked it
  for (const r of out.slice(2)) {
    assert.equal(r.opening, null);
    assert.equal('rmm_ironore_open' in r.writes, false);
    assert.equal(r.status, 'broken');
    assert.match(r.reason, /RML\/2026\/00188/);
  }
  // receipts on an unsettled day are still facts and are still written
  assert.equal(out[2].writes.rmm_ironore_recv, 40);
});

test('settledFor: today, open entries, and the per-process frontier (cement needs two days)', () => {
  const ctx = { today: '2026-10-16', pending: {}, lastComplete: { raw_meal: '2026-10-15', cement: '2026-10-16' } };
  assert.equal(settledFor(IRON, '2026-10-16', ctx).ok, false);              // today is never settled
  assert.equal(settledFor(IRON, '2026-10-14', ctx).ok, true);               // a raw-meal entry dated the 15th exists
  assert.equal(settledFor(IRON, '2026-10-15', ctx).ok, false);              // ... but none after the 15th
  const gyp = LEDGERS.find(l => l.key === 'gypsum');
  assert.equal(DEPENDENCY_TYPES.cement.frontierDays, 2);
  assert.equal(settledFor(gyp, '2026-10-14', ctx).ok, true);                // cement entry dated the 16th = D+2
  assert.equal(settledFor(gyp, '2026-10-15', ctx).ok, false);               // D+1 is not enough for cement
  const open = { ...ctx, pending: { raw_meal: { '2026-10-14': [{ name: 'RML/2026/00188', state: 'confirm', qty: 3404.94 }] } } };
  const s = settledFor(IRON, '2026-10-14', open);
  assert.equal(s.ok, false);
  assert.match(s.reason, /RML\/2026\/00188 \(confirm, 3404\.94 t\)/);
});

test('settledFor: an open mining transfer only holds the ledgers whose material it carries', () => {
  const clay = LEDGERS.find(l => l.key === 'clay');
  const ctx = { today: '2026-10-16', lastComplete: { raw_meal: '2026-10-15', mining: '2026-10-15' },
    pending: { mining: { '2026-10-13': [{ name: '150 WIP001 transfer(s)', state: 'confirm', qty: 3000, code: 'WIP001' }] } } };
  assert.equal(settledFor(clay, '2026-10-13', ctx).ok, true);
  const lime = LEDGERS.find(l => l.key === 'limestone');
  assert.equal(settledFor(lime, '2026-10-13', { ...ctx, lastComplete: { ...ctx.lastComplete, cement: '2026-10-15' } }).ok, false);
});

// ── 4. people win ───────────────────────────────────────────────────────

test('isHumanValue: blank and 0 are not typed; our own last value is not typed; anything else is', () => {
  assert.equal(isHumanValue(undefined, undefined), false);
  assert.equal(isHumanValue('', undefined), false);
  assert.equal(isHumanValue(0, undefined), false);          // the form's inputs are seeded with 0
  assert.equal(isHumanValue(120.5, 120.5), false);          // what we wrote
  assert.equal(isHumanValue(120.5, undefined), true);       // never ours
  assert.equal(isHumanValue(121, 120.5), true);             // ours, changed by a person
});

test('people win: a typed receipt is kept (not overwritten) and used in the roll', () => {
  const out = rollLedger(IRON, {
    days: ['2026-07-01'], start: start(100), settled: always,
    flows: { '2026-07-01': { 'recv:RM000004': 60 } },
    rows: rows({ '2026-07-01': { rmm_ironore_recv: 64, rmm_ironore_cons: 0 } }),
  });
  assert.equal('rmm_ironore_recv' in out[0].writes, false);
  assert.deepEqual(out[0].kept, ['rmm_ironore_recv']);
  assert.equal(out[0].closing, 164);
});

test('people win: a typed opening re-anchors the roll from that day', () => {
  const out = rollLedger(IRON, {
    days: ['2026-07-01', '2026-07-02', '2026-07-03'], start: start(100), settled: always,
    flows: {},
    rows: rows({ '2026-07-01': { rmm_ironore_cons: 0 }, '2026-07-02': { rmm_ironore_open: 250, rmm_ironore_cons: 10 }, '2026-07-03': {} }),
    mine: { '2026-07-02': { rmm_ironore_open: 100 } },    // we wrote 100, a person changed it to 250
  });
  assert.equal(out[1].status, 'human_anchor');
  assert.equal(out[1].opening, 250);
  assert.equal('rmm_ironore_open' in out[1].writes, false);
  assert.equal(out[2].opening, 240);
  assert.equal(out[2].writes.rmm_ironore_open, 240);
});

test('people win: a typed opening also restarts a chain an unsettled day had broken', () => {
  const settled = (l, d) => (d === '2026-07-01' ? { ok: false, reason: 'pending' } : { ok: true });
  const out = rollLedger(IRON, {
    days: ['2026-07-01', '2026-07-02', '2026-07-03'], start: start(100), settled, flows: {},
    rows: rows({ '2026-07-02': { rmm_ironore_open: 500 } }),
  });
  assert.equal(out[1].opening, 500);
  assert.equal(out[1].closing, 500);
  assert.equal(out[2].writes.rmm_ironore_open, 500);
});

test('our own stale value is removed when the figure becomes unknown, a typed one is not', () => {
  const settled = (l, d) => (d === '2026-07-01' ? { ok: false, reason: 'pending' } : { ok: true });
  const out = rollLedger(IRON, {
    days: ['2026-07-01', '2026-07-02'], start: start(100), settled, flows: {},
    rows: rows({ '2026-07-02': { rmm_ironore_open: 90, rmm_ironore_recv: 12 } }),
    mine: { '2026-07-02': { rmm_ironore_open: 90, rmm_ironore_recv: 12 } },
  });
  // opening unknown now (the 1st is unsettled) and the receipt vanished from Odoo:
  assert.deepEqual(out[1].removes.sort(), ['rmm_ironore_open', 'rmm_ironore_recv']);
});

// ── 6. coal ─────────────────────────────────────────────────────────────

test('coal: whole pile on the Kiln row, CPP opening untouched, receipts split, CPP burn written', () => {
  const out = rollLedger(COAL, {
    days: ['2026-07-01', '2026-07-02'], start: start(6841.23), settled: always,
    cppDays: new Set(['2026-07-01', '2026-07-02']),
    flows: {
      '2026-07-01': { 'recvkiln:RM000001': 215.22, 'recvcpp:RM000001': 30, cpp_burn: 122 },
      '2026-07-02': { cpp_burn: 0 },
    },
    rows: rows({ '2026-07-01': { coal_kiln: 170 }, '2026-07-02': { coal_kiln: 160 } }),
  });
  assert.deepEqual(out[0].writes, { coal_kiln_open: 6841.23, coal_kiln_recv: 215.22, coal_cpp_recv: 30, coal_cpp: 122 });
  assert.equal('coal_cpp_open' in out[0].writes, false);
  assert.equal(out[0].closing, 6841.23 + 245.22 - 292);
  // a complete CPP entry reporting 0 t IS written — a positive statement
  assert.equal(out[1].writes.coal_cpp, 0);
  assert.equal(out[1].writes.coal_kiln_open, out[0].closing);
});

test('coal: an officer\'s CPP opening is honoured and the Kiln row takes the rest — total stays exact', () => {
  const out = rollLedger(COAL, {
    days: ['2026-07-01'], start: start(4000), settled: always, cppDays: new Set(),
    flows: {}, rows: rows({ '2026-07-01': { coal_cpp_open: 535.77, coal_kiln: 0 } }),
  });
  assert.equal(out[0].writes.coal_kiln_open, 3464.23);
  assert.deepEqual(out[0].kept, ['coal_cpp_open']);
  assert.equal(out[0].opening, 4000);
  assert.equal(out[0].closing, 4000);
});

test('coal: no complete CPP entry -> coal_cpp is not written at all', () => {
  const out = rollLedger(COAL, {
    days: ['2026-09-14'], start: start(4000), settled: always, cppDays: new Set(),
    flows: {}, rows: rows({ '2026-09-14': {} }),
  });
  assert.equal('coal_cpp' in out[0].writes, false);
});

// ── held ledgers, anchor, comparison ────────────────────────────────────

test('a held (publish:false) ledger computes but writes nothing and publishes nothing', () => {
  const held = { ...IRON, key: 'held', publish: false, heldReason: 'not confirmed' };
  const out = rollLedger(held, {
    days: ['2026-07-01'], start: start(100), settled: always,
    flows: { '2026-07-01': { 'recv:RM000004': 5 } }, rows: rows({ '2026-07-01': { rmm_ironore_cons: 1 } }),
  });
  assert.deepEqual(out[0].writes, {});
  assert.equal(out[0].closing, null);
  assert.equal(out[0].balance, 104);
  assert.equal(out[0].reason, 'not confirmed');
});

test('closingFromRow: the page\'s own formula, null when the row has no opening at all', () => {
  const lime = LEDGERS.find(l => l.key === 'limestone');
  const anchor = { rmm_limestone_open: 24475.49, rmm_limestone_recv: 2257.86, rmm_limestone_cons: 1628, cm_limestone_cons: 407.85 };
  assert.equal(closingFromRow(lime, anchor), 24697.5);
  assert.equal(closingFromRow(lime, { rmm_limestone_cons: 10 }), null);
  const coalAnchor = { coal_kiln_open: 3229.99, coal_cpp_open: 3656.02, coal_kiln_recv: 247.22, coal_cpp_recv: 0, coal_kiln: 170, coal_cpp: 122 };
  assert.equal(closingFromRow(COAL, coalAnchor), 6841.23);
});

test('compareWithOnHand: pile scope reads only the pile location; a difference is flagged', () => {
  const clay = LEDGERS.find(l => l.key === 'clay');
  const finals = { clay: { odooRoll: 1.4, ledgerBalance: 1.4 }, iron_ore: { odooRoll: 7548.59, ledgerBalance: 7548.59 } };
  const live = { QRM007: { internal: 1450.08, pile: 1.4 }, RM000004: { internal: 7600, pile: 6633.91 } };
  const [c, i] = compareWithOnHand([clay, IRON], finals, { live });
  assert.equal(c.odooLive, 1.4);
  assert.equal(c.matches, true);            // the 1,448.68 t stockyard is NOT the plant pile
  assert.equal(i.odooLive, 7600);
  assert.equal(i.matches, false);
  assert.equal(i.diff, -51.41);
});

test('config: every flow names a real dependency, and only the receipt-like fields are written', () => {
  const plan = flowPlan();
  assert.ok(plan.recvCodes.includes('RM000001'));
  for (const l of LEDGERS) {
    for (const t of l.dependsOn) assert.ok(DEPENDENCY_TYPES[t], `${l.key}: unknown dependency ${t}`);
    for (const s of l.outflows) {
      if (s.write) assert.equal(s.field, 'coal_cpp', `${l.key}: only CPP burn may be written as an outflow`);
    }
  }
  assert.deepEqual(dayRange('2026-06-29', '2026-07-01'), ['2026-06-29', '2026-06-30', '2026-07-01']);
});
