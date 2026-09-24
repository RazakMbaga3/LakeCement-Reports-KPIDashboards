/*
  test/dashboard-cache.test.js — odooDashboardClient's bundle cache must stay
  inside a byte budget.

  Why: on 2026-09-24 the production droplet was found crash-looping every
  30-60s. The cache held whole parsed Odoo bundles (up to ~9 MB of JSON per
  sales month) bounded only by TTL — 12 hours for a closed month — so the
  startup cache warmer, and equally a person browsing back through months,
  pushed the process past pm2's 300M max_memory_restart. It is now a
  byte-budgeted LRU. These pin: the total never exceeds the budget, the
  least-recently-USED entry goes first (a hit refreshes recency), and an
  entry that fits is served without another fetch.

  No database, no Odoo — fetch is stubbed.
  Usage: node --test test/dashboard-cache.test.js   (from backend/)
*/
process.env.ODOO_DASHBOARD_URL     = 'https://odoo.invalid';
process.env.ODOO_DASHBOARD_API_KEY = 'test-key';
process.env.DASHBOARD_CACHE_MAX_MB = '1';   // 1 MiB budget; read once at module load

const test   = require('node:test');
const assert = require('node:assert/strict');

const client = require('../services/odooDashboardClient');

let fetchCalls = 0;
const realFetch = global.fetch;
const PAD = 'x'.repeat(400 * 1024);           // ~400 KB of JSON text per bundle
global.fetch = async () => {
  fetchCalls++;
  return { ok: true, text: async () => JSON.stringify({ status: true, data: { pad: PAD } }) };
};
test.after(() => { global.fetch = realFetch; });

// Closed (past) ranges, so each gets the long 12h TTL — eviction, not expiry, must be what bounds it.
const month = (m) => [`2026-0${m}-01`, `2026-0${m}-28`];
const get = (m) => client.fetchPurchaseBundle(...month(m));

test('the total never exceeds the byte budget, however many months are requested', async () => {
  client._clearCache(); fetchCalls = 0;
  for (const m of [1, 2, 3, 4, 5, 6]) {
    await get(m);
    const { bytes, maxBytes } = client._cacheStats();
    assert.ok(bytes <= maxBytes, `cache holds ${bytes} bytes, over the ${maxBytes} budget after month ${m}`);
  }
  assert.ok(client._cacheStats().entries < 6, 'nothing was evicted — the cache is unbounded again');
});

test('a fitting entry is served from cache with no second fetch', async () => {
  client._clearCache(); fetchCalls = 0;
  await get(1);
  await get(1);
  assert.equal(fetchCalls, 1);
});

test('eviction is least-recently-USED: a hit protects an entry from being dropped', async () => {
  client._clearCache(); fetchCalls = 0;
  await get(1);                 // A
  await get(2);                 // B   (A + B ~ 0.8 MB, fits)
  await get(1);                 // hit A -> now B is the least recently used
  assert.equal(fetchCalls, 2);
  await get(3);                 // C overflows 1 MiB -> B must go, not A
  const before = fetchCalls;
  await get(1);                 // A still cached
  assert.equal(fetchCalls, before, 'A was evicted even though it was just used');
  await get(2);                 // B was evicted -> refetch
  assert.equal(fetchCalls, before + 1, 'B should have been the one evicted');
});
