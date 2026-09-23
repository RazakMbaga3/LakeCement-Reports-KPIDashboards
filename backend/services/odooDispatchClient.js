/*
  services/odooDispatchClient.js — client for the Odoo team's custom
  Dispatch Report endpoint. This is NOT the generic Odoo External API
  (see odooClient.js for that) — it's a bespoke controller
  (SyncOdooDataController.dispatch_report) that takes a single opaque
  api_key rather than a full Odoo user login.

  Confirmed by direct testing against the Odoo team's test instance
  (2026-08-04/05, no written API doc exists):
    - Must be sent as a regular form-encoded POST body, NOT JSON — the
      controller is declared type='http' in Odoo; a JSON content-type
      trips "Function declared as capable of handling request of type
      'http' but called with a request of type 'json'".
    - from_date/to_date MUST be strict ISO 'YYYY-MM-DD'. Other formats
      (dashed DD-MM-YYYY or MM-DD-YYYY, as the Odoo team's own example
      used) don't error — they silently return either zero rows or, in
      one observed case, the ENTIRE dataset instead of the requested
      range. Always send ISO; never assume another format is safe.
    - Response: { message, status: true|false, code, data: [...] },
      each row { dispatch_date, product_grade, dispatch_channel,
      quantity_dispatched_mt } — one row per (date, grade, channel),
      already summed server-side (verified: 3,101 raw line-items
      collapsed to 196 aggregated rows with zero duplicate
      (date,grade,channel) triples after the Odoo team's 2026-08-05 fix).

  Configured from ODOO_DISPATCH_URL (full endpoint URL) + ODOO_DISPATCH_API_KEY
  — deliberately separate from ODOO_URL/ODOO_DB/ODOO_USERNAME/ODOO_API_KEY
  (odooClient.js's config), since this endpoint has nothing to do with
  Odoo's generic XML-RPC login flow.

  Moved from the Odoo team's test instance (46.101.75.211) to the
  PRODUCTION ERP 2026-09-23 (https://erp.lakecement.co.tz/dispatch_report),
  per Ankita (Teckzilla) — same key as ODOO_PRODUCTION_API_KEY
  (odooProductionClient.js). Confirmed by direct testing the same day:
  same transport contract (form-encoded POST, ISO dates, response shape),
  live data through 2026-09-22, product_grade/dispatch_channel values
  unchanged from the mapping below.
*/

function config() {
  const { ODOO_DISPATCH_URL, ODOO_DISPATCH_API_KEY } = process.env;
  if (!ODOO_DISPATCH_URL || !ODOO_DISPATCH_API_KEY) {
    throw new Error('Odoo dispatch report is not configured — set ODOO_DISPATCH_URL, ODOO_DISPATCH_API_KEY in .env');
  }
  return { url: ODOO_DISPATCH_URL, apiKey: ODOO_DISPATCH_API_KEY };
}

// See odooClient.js's ODOO_TIMEOUT_MS for why: no timeout here means a
// stalled connection to the Odoo team's endpoint hangs the caller forever.
const DISPATCH_TIMEOUT_MS = 15000;

/* Fetch already-aggregated dispatch rows for [from, to] inclusive.
   from/to: 'YYYY-MM-DD' strings — callers own date-range logic, this
   client just enforces the transport contract. */
async function fetchDispatchReport(from, to) {
  const { url, apiKey } = config();
  const body = new URLSearchParams({ api_key: apiKey, from_date: from, to_date: to });

  let res;
  try {
    res = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS) });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Odoo dispatch report request timed out after ${DISPATCH_TIMEOUT_MS}ms`, { cause: err });
    }
    throw err;
  }
  if (!res.ok) throw new Error(`Odoo dispatch report HTTP ${res.status}`);

  const json = await res.json();
  if (json.status !== true) {
    throw new Error(`Odoo dispatch report error: ${json.message || 'unknown error'}`);
  }
  return json.data || [];
}

module.exports = { fetchDispatchReport };
