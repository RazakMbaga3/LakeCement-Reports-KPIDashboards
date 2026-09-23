/*
  services/odooDashboardClient.js — client for the Odoo team's two custom
  dashboard endpoints (delivered 2026-09-03):

      POST <base>/sale_dashboard_report
      POST <base>/purchase_dashboard_report

  These are siblings of the dispatch_report endpoint (same server, same
  SyncOdooDataController) — see odooDispatchClient.js, whose transport
  notes apply here verbatim and were re-confirmed by testing these two:

    - Form-encoded POST, NOT JSON. The Odoo team's email documents a JSON
      body, but the controller is declared type='http', so a JSON
      content-type fails with "Function declared as capable of handling
      request of type 'http' but called with a request of type 'json'".
    - from_date/to_date must be strict ISO 'YYYY-MM-DD'. On the TEST server
      other formats silently returned zero rows or the whole dataset. On
      PRODUCTION they fail loudly instead — the Odoo team's own example
      request ("30-07-2026") returns HTTP 400 with a Postgres "date/time
      field value out of range ... datestyle" error — so that example is
      wrong, and this client is right to always send ISO.

  ── Two servers, 2026-09-19 ─────────────────────────────────────────────
  These two endpoints now live on the PRODUCTION ERP (erp.lakecement.co.tz,
  database `parallel`, its own API key), current to yesterday. The test host
  (46.101.75.211, database lcl_test_28_3, a 28-Mar-2026 snapshot) is what the
  earlier findings below were measured on. As of 2026-09-23, dispatch_report
  and mining_report ALSO moved to this same production host (see
  odooDispatchClient.js / odooMiningClient.js) — the test host may still
  serve them too, but nothing here reads it any more. Production data
  has the same shape as test — same field names, products and units — so
  nothing here is server-specific. Defects re-measured on production the
  same day are noted per item.

  Unlike the generic External API (odooClient.js), there is no model/field
  access here at all: each endpoint returns one fixed bundle of parallel
  arrays for a date range. Callers cannot ask for anything else, so the
  per-metric services on top of this are shaped around what the bundle
  happens to contain.

  ── Known server-side defects (reported 2026-09-03, NOT yet fixed) ──────
  Callers must not paper over these; each is handled explicitly here or
  called out in the service that consumes the data:

    1. Large ranges return TRUNCATED, unparseable JSON with HTTP 200 — a
       full year came back cut off mid-record at ~7.9 MB. Anything under
       ~4.5 MB parsed fine. There is no pagination. `parse_error` below
       exists specifically for this, so a truncated bundle can never be
       mistaken for an empty one.
       PRODUCTION: not reproduced up to a full month (Aug 2026: 2,934
       orders, 8.8 MB, parsed fine). Still no pagination, so keep asking
       for a month at a time.
    2. Responses are slow — ~5 s/month for purchase, ~30 s/month for sales
       (the latter is dominated by defect 3). Hence CACHE_* below and a
       timeout far longer than the other Odoo clients use.
       PRODUCTION: ~1 s/month purchase, ~8-15 s/month sales.
    3. sale_dashboard_report's `customer_receipts` ignores the date filter
       entirely (95% of rows came back outside the requested range).
       Consumers must filter it client-side — see salesOdoo.js.
       PRODUCTION: STILL BROKEN — a 2-day window returned 15,826 receipts
       dating back to 2024-04-01 (99% out of range) and that one array is
       ~3 of the response's 3.8 MB; a month returns ~30,700.
    4. Master data and on-hand stock (`stock_quants`, `products`,
       `product_categories`, `stock_locations`) are wrongly date-filtered,
       so they are INCOMPLETE, not snapshots. Only safe for classifying
       records that are themselves inside the requested range.
       PRODUCTION: STILL BROKEN — products 241 (Aug) vs 291 (Jul),
       stock_quants 342 vs 521.
*/

const CACHE_TTL_OPEN_MS  = 5 * 60 * 1000;        // range includes today — may still change
const CACHE_TTL_CLOSED_MS = 12 * 60 * 60 * 1000; // range fully in the past — effectively immutable

/* These calls take tens of seconds (defect 2). The 15s used by the other
   Odoo clients would time out almost every sales request. */
const DASHBOARD_TIMEOUT_MS = 180000;

const _cache = new Map(); // 'endpoint|from|to' -> { at, ttl, result }

function config() {
  const { ODOO_DASHBOARD_URL, ODOO_DASHBOARD_API_KEY } = process.env;
  if (!ODOO_DASHBOARD_URL || !ODOO_DASHBOARD_API_KEY) return null;
  return { base: ODOO_DASHBOARD_URL.replace(/\/+$/, ''), apiKey: ODOO_DASHBOARD_API_KEY };
}

function isConfigured() { return config() !== null; }

/* Never throws — mirrors the {ok:false,status,message} contract the
   dashboard services already use, so one unreachable endpoint degrades a
   tile instead of the whole page. */
async function fetchBundle(endpoint, from, to) {
  const cfg = config();
  if (!cfg) {
    return { ok: false, status: 'not_configured', message: 'The Odoo dashboard API is not configured on this server yet.' };
  }

  const key = `${endpoint}|${from}|${to}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.result;

  const body = new URLSearchParams({ api_key: cfg.apiKey, from_date: from, to_date: to });
  const url = `${cfg.base}/${endpoint}`;

  let res;
  try {
    res = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(DASHBOARD_TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      ok: false,
      status: 'unreachable',
      message: timedOut
        ? `Odoo did not respond within ${Math.round(DASHBOARD_TIMEOUT_MS / 1000)}s for ${from}..${to}.`
        : `Odoo did not respond: ${err.message || 'unknown error'}`,
    };
  }

  if (!res.ok) {
    return { ok: false, status: 'unreachable', message: `Odoo returned HTTP ${res.status} for ${endpoint}.` };
  }

  /* Defect 1 usually surfaces HERE rather than as bad JSON: the response
     starts streaming with HTTP 200 and the connection is then dropped
     mid-body, which fetch reports as a bare "terminated". Reading the body
     separately lets that be named accurately instead of looking like the
     Odoo server being unreachable. */
  let text;
  try {
    text = await res.text();
  } catch (err) {
    return {
      ok: false,
      status: 'parse_error',
      message: `Odoo started responding for ${from}..${to} but cut the response off partway ` +
               '(known server-side limit on large date ranges — no pagination is available yet). ' +
               'Try a shorter period.' + (err && err.message ? ` [${err.message}]` : ''),
    };
  }

  /* Defect 1: a truncated body still arrives as HTTP 200. Treating a parse
     failure as "no data" would silently under-report, so it gets its own
     status and never reaches a caller as an empty bundle. */
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      status: 'parse_error',
      message: `Odoo returned an incomplete response for ${from}..${to} ` +
               `(${Math.round(text.length / 1024)} KB, cut off mid-record). ` +
               'This is a known server-side limit on large date ranges — try a shorter period.',
    };
  }

  if (json.status !== true) {
    return { ok: false, status: 'unreachable', message: `Odoo reported: ${json.message || 'unknown error'}` };
  }

  const result = { ok: true, data: json.data || {}, as_of: new Date().toISOString(), source: `odoo:${endpoint}` };

  /* A range wholly in the past can't change, so cache it far longer —
     this is what makes a 12-month trend viable at ~5s per uncached month. */
  const today = new Date().toISOString().slice(0, 10);
  const ttl = to < today ? CACHE_TTL_CLOSED_MS : CACHE_TTL_OPEN_MS;
  _cache.set(key, { at: Date.now(), ttl, result });
  return result;
}

const fetchPurchaseBundle = (from, to) => fetchBundle('purchase_dashboard_report', from, to);
const fetchSaleBundle     = (from, to) => fetchBundle('sale_dashboard_report', from, to);

function _clearCache() { _cache.clear(); } // tests only

module.exports = { isConfigured, fetchPurchaseBundle, fetchSaleBundle, _clearCache, DASHBOARD_TIMEOUT_MS };
