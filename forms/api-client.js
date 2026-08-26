/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — Shared Reports API Client
   ─────────────────────────────────────────────────────────────────
   Thin fetch wrapper around backend/routes/reports.js, shared by
   form-persist.js, report-loader.js and inline-edit.js so there's one
   place that knows the API base, auth header, and error handling.

   Requires auth.js to be loaded first (uses getAuthToken()).
   ══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const BASE = (typeof _API_BASE !== 'undefined') ? _API_BASE : 'http://localhost:5000/api';

  /* Shared HTML-escaper — was independently reimplemented (with
     inconsistent character coverage) in sales.html, purchases.html,
     memory.html, monitor.html and mines-report.html; one page's
     4-character version (missing `'`) is exactly the kind of gap that
     let a real stored-XSS hole through the Quarry ticket inspector. One
     copy here, loaded by every page that already includes this file. */
  if (typeof global.escHtml !== 'function') {
    global.escHtml = function escHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };
  }

  function _headers() {
    const token = (typeof getAuthToken === 'function') ? getAuthToken() : null;
    const h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  /* HTTP failures carry err.status so callers (offline-queue.js) can tell
     permanent rejections (4xx — flag for review) from retryable outages
     (network error → no status, 401 auth pending, 5xx). */
  function _httpError(fn, formType, res) {
    const err = new Error(fn + '(' + formType + ') failed: HTTP ' + res.status);
    err.status = res.status;
    return err;
  }

  /* POST /api/reports/:formType — submit/update a daily form */
  async function submitForm(formType, date, shift, data) {
    const res = await fetch(BASE + '/reports/' + encodeURIComponent(formType), {
      method:  'POST',
      headers: _headers(),
      body:    JSON.stringify({ date, shift: shift || 'day', data }),
    });
    if (!res.ok) throw _httpError('submitForm', formType, res);
    return res.json();
  }

  /* GET /api/reports/:formType/:date — one day's record, or null */
  async function getForm(formType, date, shift) {
    const qs = shift ? ('?shift=' + encodeURIComponent(shift)) : '';
    const res = await fetch(BASE + '/reports/' + encodeURIComponent(formType) + '/' + encodeURIComponent(date) + qs, {
      headers: _headers(),
    });
    if (!res.ok) throw _httpError('getForm', formType, res);
    return res.json();
  }

  /* GET /api/reports/:formType?from=&to= — date-range records */
  async function getFormRange(formType, from, to, shift) {
    const params = new URLSearchParams({ from, to });
    if (shift) params.set('shift', shift);
    const res = await fetch(BASE + '/reports/' + encodeURIComponent(formType) + '?' + params.toString(), {
      headers: _headers(),
    });
    if (!res.ok) throw _httpError('getFormRange', formType, res);
    return res.json();
  }

  /* ── Formula layer (backend/routes/formula.js) ─────────────────────
     Dashboards render KPI values exclusively from these — formula math
     lives in forms/formula-registry.js + the server engine, never in
     page JS. */

  /* GET /api/formula/eval/:year/:month — all KPIs for a month, overrides applied */
  async function evalFormulas(year, month) {
    const res = await fetch(BASE + '/formula/eval/' + year + '/' + month, { headers: _headers() });
    if (!res.ok) throw _httpError('evalFormulas', year + '-' + month, res);
    return res.json();
  }

  /* GET /api/formula/daily?from=&to= — daily series per KPI (trend charts) */
  async function getDailySeries(from, to) {
    const res = await fetch(BASE + '/formula/daily?' + new URLSearchParams({ from, to }), { headers: _headers() });
    if (!res.ok) throw _httpError('getDailySeries', from + '..' + to, res);
    return res.json();
  }

  /* POST /api/formula/override — manual override; reason is mandatory */
  async function setOverride(kpiKey, year, month, value, reason) {
    const res = await fetch(BASE + '/formula/override', {
      method: 'POST', headers: _headers(),
      body: JSON.stringify({ kpi_key: kpiKey, year: Number(year), month: Number(month), value, reason }),
    });
    if (!res.ok) throw _httpError('setOverride', kpiKey, res);
    return res.json();
  }

  /* DELETE /api/formula/override/:id — clear (row is kept + audited) */
  async function clearOverride(id) {
    const res = await fetch(BASE + '/formula/override/' + id, { method: 'DELETE', headers: _headers() });
    if (!res.ok) throw _httpError('clearOverride', String(id), res);
    return res.json();
  }

  /* GET /api/formula/overrides/:year/:month — full override history */
  async function getOverrides(year, month) {
    const res = await fetch(BASE + '/formula/overrides/' + year + '/' + month, { headers: _headers() });
    if (!res.ok) throw _httpError('getOverrides', year + '-' + month, res);
    return res.json();
  }

  /* GET /api/insights/baseline/:formType — 30-day mean/σ per field, used
     by form-persist.js to flag unusual values at submit time */
  async function getBaseline(formType) {
    const res = await fetch(BASE + '/insights/baseline/' + encodeURIComponent(formType), { headers: _headers() });
    if (!res.ok) throw _httpError('getBaseline', formType, res);
    return res.json();
  }

  /* GET /api/mis/completeness?from=&to= — per-day, per-form entry status
     for the completeness heatmap (completeness.html) */
  async function getCompleteness(from, to) {
    const res = await fetch(BASE + '/mis/completeness?' + new URLSearchParams({ from, to }), { headers: _headers() });
    if (!res.ok) throw _httpError('getCompleteness', from + '..' + to, res);
    return res.json();
  }

  /* GET /api/insights/stoppages?from=&to= — downtime Pareto (hours + freq),
     per-equipment MTTR/MTBF/availability and RCFA flags (reliability.html) */
  async function getStoppageInsights(from, to) {
    const res = await fetch(BASE + '/insights/stoppages?' + new URLSearchParams({ from, to }), { headers: _headers() });
    if (!res.ok) throw _httpError('getStoppageInsights', from + '..' + to, res);
    return res.json();
  }

  /* ── Quarry weighbridge tickets (backend/routes/quarry.js) ─────────
     Separate from the daily-form endpoints above — many rows per day,
     deduped by ticket_no server-side, not a one-blob-per-day shape. */

  /* POST /api/quarry/tickets/import — bulk upsert parsed Excel rows */
  async function quarryImportTickets(rows) {
    const res = await fetch(BASE + '/quarry/tickets/import', {
      method: 'POST', headers: _headers(),
      body: JSON.stringify({ rows }),
    });
    if (!res.ok) throw _httpError('quarryImportTickets', rows.length + ' rows', res);
    return res.json();
  }

  /* GET /api/quarry/tickets?from=&to= — omit both to fetch the whole log */
  async function quarryGetTickets(from, to) {
    const qs = (from && to) ? ('?' + new URLSearchParams({ from, to })) : '';
    const res = await fetch(BASE + '/quarry/tickets' + qs, { headers: _headers() });
    if (!res.ok) throw _httpError('quarryGetTickets', from + '..' + to, res);
    return res.json();
  }

  /* ── Sales dashboard (backend/routes/sales.js) ──────────────────── */

  /* GET /api/sales/territories — division/zone/officer roster, used by
     both sales.html and forms/sales-projection-form.html */
  async function getSalesTerritories() {
    const res = await fetch(BASE + '/sales/territories', { headers: _headers() });
    if (!res.ok) throw _httpError('getSalesTerritories', '', res);
    return res.json();
  }

  /* GET /api/sales/dashboard?year=&month= */
  async function getSalesDashboard(year, month) {
    const params = new URLSearchParams();
    if (year)  params.set('year', year);
    if (month) params.set('month', month);
    const qs = params.toString();
    const res = await fetch(BASE + '/sales/dashboard' + (qs ? '?' + qs : ''), { headers: _headers() });
    if (!res.ok) throw _httpError('getSalesDashboard', year + '-' + month, res);
    return res.json();
  }

  /* POST /api/sales/targets — set an interim manual target */
  async function setSalesTarget(targetMonth, officerCode, targetMt) {
    const res = await fetch(BASE + '/sales/targets', {
      method: 'POST', headers: _headers(),
      body: JSON.stringify({ targetMonth, officerCode, targetMt }),
    });
    if (!res.ok) throw _httpError('setSalesTarget', officerCode, res);
    return res.json();
  }

  /* ── Purchase dashboard (backend/routes/purchases.js) ───────────── */

  /* GET /api/purchases/dashboard?year=&month= */
  async function getPurchasesDashboard(year, month) {
    const params = new URLSearchParams();
    if (year)  params.set('year', year);
    if (month) params.set('month', month);
    const qs = params.toString();
    const res = await fetch(BASE + '/purchases/dashboard' + (qs ? '?' + qs : ''), { headers: _headers() });
    if (!res.ok) throw _httpError('getPurchasesDashboard', year + '-' + month, res);
    return res.json();
  }

  /* ── Approvals (backend/routes/reports.js + routes/approvals.js) ──
     Officer/Senior submissions land as 'pending_approval'; only their
     department's HOD (or admin/md) may approve/reject. See approvals.html. */

  /* GET /api/approvals — pending reports scoped to the caller's department
     (admin/md see everything, HOD sees their own department, others []) */
  async function getApprovals() {
    const res = await fetch(BASE + '/approvals', { headers: _headers() });
    if (!res.ok) throw _httpError('getApprovals', '', res);
    return res.json();
  }

  /* POST /api/reports/:formType/:date/approve */
  async function approveReport(formType, date, shift) {
    const res = await fetch(BASE + '/reports/' + encodeURIComponent(formType) + '/' + encodeURIComponent(date) + '/approve', {
      method: 'POST', headers: _headers(),
      body: JSON.stringify({ shift: shift || 'day' }),
    });
    if (!res.ok) throw _httpError('approveReport', formType, res);
    return res.json();
  }

  /* POST /api/reports/:formType/:date/reject — reason is mandatory */
  async function rejectReport(formType, date, shift, reason) {
    const res = await fetch(BASE + '/reports/' + encodeURIComponent(formType) + '/' + encodeURIComponent(date) + '/reject', {
      method: 'POST', headers: _headers(),
      body: JSON.stringify({ shift: shift || 'day', reason }),
    });
    if (!res.ok) throw _httpError('rejectReport', formType, res);
    return res.json();
  }

  /* ── MIS reference data (backend/routes/mis.js) ─────────────────── */

  /* GET /api/mis/employees|it-assets|vehicles|compliance-certs — static
     HR/IT/vehicle/compliance registers shown on mis.html's tabs. */
  async function getMisEmployees() {
    const res = await fetch(BASE + '/mis/employees', { headers: _headers() });
    if (!res.ok) throw _httpError('getMisEmployees', '', res);
    return res.json();
  }
  async function getMisItAssets() {
    const res = await fetch(BASE + '/mis/it-assets', { headers: _headers() });
    if (!res.ok) throw _httpError('getMisItAssets', '', res);
    return res.json();
  }
  async function getMisVehicles() {
    const res = await fetch(BASE + '/mis/vehicles', { headers: _headers() });
    if (!res.ok) throw _httpError('getMisVehicles', '', res);
    return res.json();
  }
  async function getMisComplianceCerts() {
    const res = await fetch(BASE + '/mis/compliance-certs', { headers: _headers() });
    if (!res.ok) throw _httpError('getMisComplianceCerts', '', res);
    return res.json();
  }

  global.NyatiAPI = {
    submitForm, getForm, getFormRange,
    evalFormulas, getDailySeries, setOverride, clearOverride, getOverrides,
    getBaseline, getCompleteness, getStoppageInsights,
    quarryImportTickets, quarryGetTickets,
    getSalesTerritories, getSalesDashboard, setSalesTarget,
    getPurchasesDashboard,
    getApprovals, approveReport, rejectReport,
    getMisEmployees, getMisItAssets, getMisVehicles, getMisComplianceCerts,
  };

}(window));
