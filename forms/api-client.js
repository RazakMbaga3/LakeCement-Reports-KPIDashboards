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

  global.NyatiAPI = {
    submitForm, getForm, getFormRange,
    evalFormulas, getDailySeries, setOverride, clearOverride, getOverrides,
    getBaseline, getCompleteness, getStoppageInsights,
  };

}(window));
