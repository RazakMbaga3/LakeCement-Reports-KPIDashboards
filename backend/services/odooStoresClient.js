/*
  services/odooStoresClient.js — client for the Odoo team's three Stores
  endpoints, delivered 2026-10-01 (Ankita / Teckzilla):

      POST <base>/gate_entry_report       one row per truck visit
      POST <base>/grn_register_report     one row per GRN line
      POST <base>/material_request_report one row per material issue line

  Same SyncOdooDataController family as dispatch/mining/production, so
  odooMiningClient.js's transport notes apply verbatim: form-encoded POST
  (NOT JSON — the controller is type='http'), and the response is
  { message, status, code, data: [...] }.

  ── Verified against production on 2026-10-01 ──────────────────────────
  Every claim below was measured, not assumed, by replaying the same
  windows our officers had already exported by hand on 2026-09-16:

    - GRN register, 14-15 Sep, COAL: 67 rows — the SAME 67 the manual
      .xls export produced, totalling 2,135.48 MT. Row CM/GRN/2026/03402
      matched the spreadsheet field for field (challan 32.14, variance
      -0.36, freight 170000, LC 5,463,800, weighbridge 31,780).
    - Material issue, 15 Sep, FUEL DIESEL + warehouse CEMENT: 10 rows,
      4,425 LTR — the same 10 the manual export produced.
    - Gate entry, 14-15 Sep: 86 rows, 76 fields.

  ── Three behaviours that differ from the older endpoints ──────────────

  1. BOTH date formats work. The Odoo team's example used DD-MM-YYYY
     ('01-02-2026'); the five older endpoints reject anything but ISO and
     production answers them with a Postgres datestyle error. These three
     accept either and return identical results (1,869 rows over the same
     Feb window for both spellings). We still send ISO only — one spelling
     everywhere is worth more than exercising a tolerance that may not
     survive the next deploy.

  2. The payload is a FLAT ARRAY under `data`, not the named-arrays bundle
     that purchase_dashboard_report returns. Nothing to merge or cross-
     reference; one row is one record.

  3. Single-day windows include that day (2026-09-15..2026-09-15 returned
     51 GRN rows, all dated 15/09). The gate_entry_report's UI export had
     an off-by-one that dropped the start day; the API does not.

  ── Timeouts: measured, and the reason they differ ────────────────────
  Cold production timings on 2026-10-01:
      material_request  2 days  2.4s / 245 KB
      grn_register      2 days  4.4s / 242 KB
      gate_entry        2 days 15.0s / 220 KB
      grn_register      1 month 40-55s / 2.5 MB
      gate_entry        1 month TIMED OUT at 180s

  Gate entry is by far the slowest per row (76 wide fields), so it gets the
  longest ceiling. None of this is fast enough to serve a page load, which
  is why everything here lands in Postgres via odooStoresSync.js and the
  reports read the tables, never this client.
*/

const DEFAULT_TIMEOUT_MS = 120000;
const GATE_TIMEOUT_MS = 180000;

/* One endpoint per dataset. `env` names the override pair; all three fall
   back to the production pair the other bespoke endpoints already use, since
   they are confirmed on the same host under the same key — but stay
   independently overridable, for the reason odooMiningClient.js spells out:
   nothing should assume a shared host just because it is shared today. */
const ENDPOINTS = {
  gate: { path: 'gate_entry_report', env: 'ODOO_GATE_ENTRY', timeout: GATE_TIMEOUT_MS },
  grn: { path: 'grn_register_report', env: 'ODOO_GRN_REGISTER', timeout: DEFAULT_TIMEOUT_MS },
  issues: { path: 'material_request_report', env: 'ODOO_MATERIAL_ISSUE', timeout: DEFAULT_TIMEOUT_MS },
};

/* Derive a sibling endpoint URL from any configured bespoke endpoint that
   ends in a known /<name>_report, the same guarded swap odooMiningClient
   does. Guarded so a URL that does NOT end in a recognised report name is
   left alone rather than silently calling the wrong endpoint. */
const SIBLING_RE = /\/(dispatch_report|mining_report|production_report|gate_entry_report|grn_register_report|material_request_report)\/*$/;

function deriveFrom(url, path) {
  if (!url || !SIBLING_RE.test(url)) return null;
  return url.replace(SIBLING_RE, `/${path}`);
}

function config(kind) {
  const ep = ENDPOINTS[kind];
  if (!ep) throw new Error(`Unknown Odoo stores endpoint '${kind}'`);

  const explicitUrl = process.env[`${ep.env}_URL`];
  const explicitKey = process.env[`${ep.env}_API_KEY`];

  const url = explicitUrl
    || deriveFrom(process.env.ODOO_PRODUCTION_URL, ep.path)
    || deriveFrom(process.env.ODOO_MINING_URL, ep.path)
    || deriveFrom(process.env.ODOO_DISPATCH_URL, ep.path);

  const apiKey = explicitKey
    || process.env.ODOO_PRODUCTION_API_KEY
    || process.env.ODOO_MINING_API_KEY
    || process.env.ODOO_DISPATCH_API_KEY;

  if (!url || !apiKey) {
    throw new Error(
      `Odoo ${ep.path} is not configured — set ${ep.env}_URL + ${ep.env}_API_KEY in .env `
      + '(or any of ODOO_PRODUCTION_URL / ODOO_MINING_URL / ODOO_DISPATCH_URL ending in a '
      + '*_report path, plus its API key, which it derives from)');
  }
  return { url, apiKey, timeout: ep.timeout, path: ep.path };
}

function isConfigured(kind) {
  try { config(kind); return true; } catch { return false; }
}

/* ISO only. See note 1 in the header: the endpoint tolerates DD-MM-YYYY but
   we never send it, and a caller passing one is a bug worth naming here
   rather than letting Odoo reinterpret it. */
function assertIso(label, value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    throw new Error(`Odoo stores pull needs an ISO YYYY-MM-DD ${label}, got '${value}'`);
  }
}

async function fetchReport(kind, from, to) {
  assertIso('from_date', from);
  assertIso('to_date', to);
  const { url, apiKey, timeout, path } = config(kind);
  const body = new URLSearchParams({ api_key: apiKey, from_date: from, to_date: to });

  let res;
  try {
    res = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(
        `Odoo ${path} timed out after ${timeout}ms for ${from}..${to}. This endpoint has no `
        + 'pagination; pull a shorter window.', { cause: err });
    }
    /* Same large-range truncation the other bespoke endpoints show: HTTP 200,
       then the body is cut mid-record and fetch reports a bare "terminated".
       Name it, so a half-delivered window is never read as a short one. */
    throw new Error(
      `Odoo ${path} response was cut off for ${from}..${to} — no pagination is available, `
      + `so pull a shorter period. [${err.message}]`, { cause: err });
  }

  if (!res.ok) throw new Error(`Odoo ${path} HTTP ${res.status}`);

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* A truncated body still arrives as HTTP 200 (defect 1 on the dashboard
       endpoints). Treating a parse failure as "no rows" would silently
       under-report, so it gets named. */
    throw new Error(
      `Odoo ${path} returned an incomplete response for ${from}..${to} `
      + `(${Math.round(text.length / 1024)} KB, cut off mid-record) — pull a shorter period.`);
  }

  if (json.status !== true) {
    throw new Error(`Odoo ${path} error: ${json.message || 'unknown error'}`);
  }
  return Array.isArray(json.data) ? json.data : [];
}

const fetchGateEntries = (from, to) => fetchReport('gate', from, to);
const fetchGrnRegister = (from, to) => fetchReport('grn', from, to);
const fetchMaterialIssues = (from, to) => fetchReport('issues', from, to);

module.exports = {
  fetchGateEntries,
  fetchGrnRegister,
  fetchMaterialIssues,
  isConfigured,
  ENDPOINTS,
  GATE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
};
