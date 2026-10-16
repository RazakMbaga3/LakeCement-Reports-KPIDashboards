/*
  services/odooProductionClient.js — client for the Odoo team's bespoke
  Production Report endpoint, POST <ODOO_PRODUCTION_URL> (…/production_report).
  Delivered 2026-09-20 on the PRODUCTION ERP (erp.lakecement.co.tz). Transport
  only: parsing and mapping live in odooProductionMapper.js.

  Same controller family as the dispatch, mining, sale and purchase endpoints,
  and the same transport rules apply — all re-confirmed against this endpoint
  on 2026-09-20:

    - Form-encoded POST, NOT JSON. The Odoo team's email documents a JSON
      body, but the controller is declared type='http' and answers a JSON body
      with an Odoo server error.
    - Send from_date / to_date as ISO 'YYYY-MM-DD'. This endpoint also reads
      DD-MM-YYYY, but its siblings reject 30-07-2026 with a hard 400 and read
      an ambiguous 10-09-2026 month-first (0 purchase orders, where ISO
      returned 2), so ISO is the only safe form.
    - A bad key is HTTP 401 ("Authentication failed…"); an empty key is 401
      ("API Key Is Not Passed"). An empty `data` therefore means "no entries in
      that window", never a silent auth failure.

  Response: { message, status, code, data } where data is an object keyed by
  picking type — 'CEMENT: Raw Meal Production', '… Clinker Production',
  '… Fine Coal Production', '… Cement Production (CM1)' / '(CM2)' — each an
  array of entries. As delivered on 2026-09-20 there was no Crusher group, no
  approval status, no run hours and no timestamps; the sync's design leans on
  those absences.

  The 2026-10-08 deploy shortened the group keys ('Raw Meal', 'Cement',
  'Clinker', 'Coal Mill', 'Crusher') and added state/approval_status,
  running_hours, coal_ncv, write_date and the Crusher group, whose entries
  also carry apron_feeder_hrs (stored since 2026-10-15, migration 040). Only
  'Approved' entries have been seen: a 2026-04-01..2026-10-15 pull returned
  198 Crusher entries, every one Approved, matching Odoo's own
  crusher_production_entry rows in state 'complete' one for one.

  Speed and size: 0.3-0.9 s and up to ~0.7 MB for a month, no truncation seen
  up to Jan 2024 - Sep 2026. There is still no pagination, so callers pull a
  month at a time.

  Configured from ODOO_PRODUCTION_URL (the full endpoint URL) and
  ODOO_PRODUCTION_API_KEY. There is deliberately NO fallback to the dashboard
  or dispatch pairs: those still point at the frozen test server on developer
  machines, and a silent fallback would read stale data without saying so
  (the mining client's fallback caused exactly that mix-up once).
*/

const PRODUCTION_TIMEOUT_MS = 60000;

function config() {
  const { ODOO_PRODUCTION_URL, ODOO_PRODUCTION_API_KEY } = process.env;
  if (!ODOO_PRODUCTION_URL || !ODOO_PRODUCTION_API_KEY) {
    throw new Error(
      'Odoo production report is not configured — set ODOO_PRODUCTION_URL '
      + '(e.g. https://erp.lakecement.co.tz/production_report) and ODOO_PRODUCTION_API_KEY in .env');
  }
  return { url: ODOO_PRODUCTION_URL.trim(), apiKey: ODOO_PRODUCTION_API_KEY.trim() };
}

function isConfigured() {
  try { config(); return true; } catch { return false; }
}

/* Fetch the production entries for [from, to] inclusive. Resolves to the
   response's `data` object ({} when the window holds none); throws, with a
   message an operator can act on, for anything else. */
async function fetchProductionReport(from, to) {
  const { url, apiKey } = config();
  const body = new URLSearchParams({ api_key: apiKey, from_date: from, to_date: to });

  let res;
  try {
    res = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(PRODUCTION_TIMEOUT_MS) });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Odoo production report request timed out after ${PRODUCTION_TIMEOUT_MS}ms`, { cause: err });
    }
    throw new Error(`Odoo production report is unreachable: ${err.message}`, { cause: err });
  }

  /* Read the body separately so a connection dropped mid-stream (HTTP 200,
     then "terminated") is named as a cut-off response, not as Odoo being down. */
  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw new Error(
      `Odoo production report response was cut off for ${from}..${to} — pull a shorter period. [${err.message}]`,
      { cause: err });
  }

  let json = null;
  try { json = JSON.parse(text); } catch { /* handled below, with the status in hand */ }

  if (res.status === 401) {
    throw new Error(`Odoo rejected the production report API key (HTTP 401: ${(json && json.message) || 'no message'}) — check ODOO_PRODUCTION_API_KEY`);
  }
  if (!res.ok) throw new Error(`Odoo production report HTTP ${res.status}`);
  if (!json) {
    throw new Error(
      `Odoo production report returned a non-JSON or incomplete response for ${from}..${to} `
      + `(${Math.round(text.length / 1024)} KB) — pull a shorter period`);
  }
  if (json.status !== true) throw new Error(`Odoo production report error: ${json.message || 'unknown error'}`);

  const data = json.data;
  if (data === null || data === undefined || (Array.isArray(data) && data.length === 0)) return {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Odoo production report returned an unexpected shape: data is not an object keyed by picking type');
  }
  return data;
}

module.exports = { fetchProductionReport, isConfigured, PRODUCTION_TIMEOUT_MS };
