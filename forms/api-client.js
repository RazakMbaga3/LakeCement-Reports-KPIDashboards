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

  global.NyatiAPI = { submitForm, getForm, getFormRange };

}(window));
