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

  Row shape (confirmed against March 2026 data, 3,990 rows):
    { vendor, vehicle_no, transfer_type, movement_type, input_product,
      uom, gross_date, net_qt, reader }
  Observed values: 2 vendors, 11 vehicles, transfer_type ∈ {Production
  Transfers, Internal Transfers}, input_product ∈ {QRM001, QRM003, QRM007,
  QRM008}, uom always 'MT', reader always 'RFID', and the six movement_type
  values the Quarry dashboard already models.

  ── The missing field, and why it shapes everything downstream ──────────
  There is NO ticket_no in the response. weighbridge_tickets dedupes on a
  UNIQUE ticket_no (migration 005), so odooMiningSync.js has to synthesise
  a deterministic surrogate key from the row's own content. That works, but
  it is strictly worse than the real thing — see that file's header. Adding
  ticket_no to this endpoint is an open request with the Odoo team.

  Configured from ODOO_MINING_URL + ODOO_MINING_API_KEY. Those default to
  the dispatch connector's host/key when unset, because in practice the Odoo
  team has issued exactly one key for all four bespoke controllers — but
  they stay separately overridable so a future production endpoint or a
  rotated per-endpoint key needs no code change.
*/

function config() {
  const {
    ODOO_MINING_URL, ODOO_MINING_API_KEY,
    ODOO_DASHBOARD_URL, ODOO_DASHBOARD_API_KEY,
    ODOO_DISPATCH_API_KEY,
  } = process.env;

  const url = ODOO_MINING_URL
    || (ODOO_DASHBOARD_URL ? ODOO_DASHBOARD_URL.replace(/\/+$/, '') + '/mining_report' : null);
  const apiKey = ODOO_MINING_API_KEY || ODOO_DASHBOARD_API_KEY || ODOO_DISPATCH_API_KEY;

  if (!url || !apiKey) {
    throw new Error(
      'Odoo mining report is not configured — set ODOO_MINING_URL + ODOO_MINING_API_KEY in .env '
      + '(or ODOO_DASHBOARD_URL + ODOO_DASHBOARD_API_KEY, which it falls back to)');
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
