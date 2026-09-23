/*
  services/odooMiningClient.js — client for the Odoo team's bespoke Mining
  Report endpoint (POST <base>/mining_report). Sibling of dispatch_report,
  same SyncOdooDataController, same opaque api_key — so
  odooDispatchClient.js's transport notes apply here verbatim:
  form-encoded POST (NOT JSON — the controller is type='http'), strict ISO
  'YYYY-MM-DD' dates, response { message, status, code, data: [...] }.

  Delivered 2026-08-05 but returned zero rows on every test that day, so it
  was never wired up. Re-tested 2026-09-08: it now returns real weighbridge
  traffic — 5,211 rows for Feb 2026, 3,990 for Mar 2026.

  Moved from the test instance to the PRODUCTION ERP 2026-09-23
  (https://erp.lakecement.co.tz/mining_report), per Ankita (Teckzilla) —
  same key as ODOO_PRODUCTION_API_KEY. Confirmed live through 2026-09-22.

  Row shape (confirmed against production data, Jan–Sep 2026):
    { vendor, ticket_no, vehicle_no, transfer_type, movement_type,
      input_product, uom, gross_date, net_qt, reader }
  Observed values: transfer_type ∈ {Production Transfers, Internal
  Transfers}, input_product ∈ {QRM001, QRM003, QRM005, QRM007, QRM008,
  RM000003, RM000005}, uom always 'MT', reader always 'RFID', and the six
  movement_type values the Quarry dashboard already models.

  ── ticket_no now exists — the test host's one real gap is closed ───────
  The test instance never returned a ticket number, which is why
  odooMiningSync.js synthesises a deterministic surrogate key (see that
  file's header for the full story). PRODUCTION DOES return ticket_no —
  confirmed 2026-09-23, format varies by period ('56731' in Jul data,
  'MN21092605' in Sep data, both plain strings, never empty in any row
  sampled). odooMiningSync.js now prefers this real value and only falls
  back to the content-hash surrogate when a row is missing it, so this
  client still returns rows without ticket_no untouched rather than
  inventing one — that decision belongs to the sync layer, not here.

  Configured from ODOO_MINING_URL + ODOO_MINING_API_KEY. When unset they are
  derived from the DISPATCH pair (same controller, same host, same key — the
  endpoint name is swapped), but stay separately overridable.

  It deliberately does NOT fall back to the sales/purchase DASHBOARD pair.
  An earlier version did, and that was a trap: on 2026-09-19 the dashboards
  moved to the production ERP ahead of dispatch/mining, so a shared
  fallback would have silently repointed mining at whatever the dashboard
  pair happened to point at that week. Now that all of dispatch_report,
  mining_report, production_report, sale_dashboard_report and
  purchase_dashboard_report are confirmed on the same production host under
  ODOO_PRODUCTION_API_KEY, this fallback restriction is no longer live
  ammunition — but it's left in place: ODOO_MINING_URL/ODOO_DISPATCH_URL
  are still their own independent settings, and nothing should assume
  every bespoke endpoint always shares a host just because it does today.
*/

function config() {
  const {
    ODOO_MINING_URL, ODOO_MINING_API_KEY,
    ODOO_DISPATCH_URL, ODOO_DISPATCH_API_KEY,
  } = process.env;

  // Only derive when the dispatch URL really ends in /dispatch_report —
  // otherwise the "swap" would leave the URL unchanged and mining would
  // quietly call the dispatch endpoint.
  const derivedUrl = ODOO_DISPATCH_URL && /\/dispatch_report\/*$/.test(ODOO_DISPATCH_URL)
    ? ODOO_DISPATCH_URL.replace(/\/dispatch_report\/*$/, '/mining_report')
    : null;

  const url = ODOO_MINING_URL || derivedUrl;
  const apiKey = ODOO_MINING_API_KEY || ODOO_DISPATCH_API_KEY;

  if (!url || !apiKey) {
    throw new Error(
      'Odoo mining report is not configured — set ODOO_MINING_URL + ODOO_MINING_API_KEY in .env '
      + '(or ODOO_DISPATCH_URL ending in /dispatch_report + ODOO_DISPATCH_API_KEY, which it derives from)');
  }
  return { url, apiKey };
}

function isConfigured() {
  try { config(); return true; } catch { return false; }
}

/* Mining pulls are an order of magnitude larger than dispatch's aggregated
   rows (a month is ~4-5k raw ticket rows, ~1.4 MB), so 15s — the dispatch
   client's timeout — is too tight. A month measured 9.7s cold. */
const MINING_TIMEOUT_MS = 60000;

/* Fetch raw weighbridge ticket rows for [from, to] inclusive.
   Unlike dispatch_report, nothing is aggregated server-side: this is one
   row per weighing, exactly as the Quarry ticket log wants it. */
async function fetchMiningReport(from, to) {
  const { url, apiKey } = config();
  const body = new URLSearchParams({ api_key: apiKey, from_date: from, to_date: to });

  let res;
  try {
    res = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(MINING_TIMEOUT_MS) });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Odoo mining report request timed out after ${MINING_TIMEOUT_MS}ms`, { cause: err });
    }
    /* The same large-range truncation that afflicts the dashboard endpoints
       (HTTP 200, then the connection dropped mid-body) surfaces here as a
       bare "terminated" from fetch. Name it, so a caller never reads a
       half-delivered month as a short one. */
    throw new Error(
      `Odoo mining report response was cut off for ${from}..${to} — this endpoint has no `
      + `pagination and truncates large ranges; pull a shorter period. [${err.message}]`,
      { cause: err });
  }
  if (!res.ok) throw new Error(`Odoo mining report HTTP ${res.status}`);

  const json = await res.json();
  if (json.status !== true) {
    throw new Error(`Odoo mining report error: ${json.message || 'unknown error'}`);
  }
  return json.data || [];
}

module.exports = { fetchMiningReport, isConfigured, MINING_TIMEOUT_MS };
