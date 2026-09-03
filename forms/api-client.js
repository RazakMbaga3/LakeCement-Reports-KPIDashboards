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
  /* `opts.status` — 'draft' or 'submitted' (default). The server derives the
     approval state from it: a draft never enters an HOD's queue and is never
     self-certified as approved.
     `opts.replace` — overwrite the stored fields instead of merging into
     them. Only for callers that own the whole record (importers, syncs). */
  async function submitForm(formType, date, shift, data, opts) {
    const body = { date, shift: shift || 'day', data };
    if (opts && opts.status)  body.status  = opts.status;
    if (opts && opts.replace) body.replace = true;
    const res = await fetch(BASE + '/reports/' + encodeURIComponent(formType), {
      method:  'POST',
      headers: _headers(),
      body:    JSON.stringify(body),
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

  /* GET /api/mis/daily-summary/:date — the plant head's Daily Summary
     Report (Mining / Stock / Production, ON DATE + MTD + YTD) rebuilt from
     the daily forms. Shown at the foot of the Executive Summary. */
  async function getDailySummary(date) {
    const res = await fetch(BASE + '/mis/daily-summary/' + encodeURIComponent(date), { headers: _headers() });
    if (!res.ok) throw _httpError('getDailySummary', date, res);
    return res.json();
  }

  /* GET /api/mis/data-range — which dates actually hold data, per form type,
     plus the newest kpi_monthly period. Backs forms/latest-period.js, which
     stops the analytics pages from opening on an empty "today". */
  async function getDataRange() {
    const res = await fetch(BASE + '/mis/data-range', { headers: _headers() });
    if (!res.ok) throw _httpError('getDataRange', '', res);
    return res.json();
  }

  /* GET /api/insights/stoppages?from=&to= — downtime Pareto (hours + freq),
     per-equipment MTTR/MTBF/availability and RCFA flags (reliability.html) */
  async function getStoppageInsights(from, to) {
    const res = await fetch(BASE + '/insights/stoppages?' + new URLSearchParams({ from, to }), { headers: _headers() });
    if (!res.ok) throw _httpError('getStoppageInsights', from + '..' + to, res);
    return res.json();
  }

  /* GET /api/insights/stoppages/:equip?from=&to= — same KPIs scoped to one
     equipment, plus named-fault-level Pareto and an MTBF-by-month trend
     (reliability.html's per-equipment section). `equip` is one of
     crusher|rm|cm_coal|kiln|cm1|cm2|packing. */
  async function getEquipmentStoppageDetail(equip, from, to) {
    const res = await fetch(BASE + '/insights/stoppages/' + encodeURIComponent(equip) + '?' + new URLSearchParams({ from, to }), { headers: _headers() });
    if (!res.ok) throw _httpError('getEquipmentStoppageDetail', equip + ' ' + from + '..' + to, res);
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

  /* ── Monthly KPI submission lock ──────────────────────────────────
     A department-month is "submitted" once its HOD declares it final;
     kpi_monthly writes for that period are then refused with 409
     KPI_PERIOD_LOCKED until an admin/MD reopens it. See
     backend/middleware/kpiAccess.js requireKpiPeriodOpen. */

  // Never throws on a missing record — an unsubmitted period is the normal
  // case and the API answers { status: 'open' }, not a 404.
  async function getKpiSubmission(dept, year, month) {
    const res = await fetch(BASE + '/kpi/' + encodeURIComponent(dept) + '/' + year + '/' + month + '/submission', { headers: _headers() });
    if (!res.ok) throw _httpError('getKpiSubmission', dept + ' ' + year + '-' + month, res);
    return res.json();
  }

  async function submitKpiMonth(dept, year, month) {
    const res = await fetch(BASE + '/kpi/' + encodeURIComponent(dept) + '/' + year + '/' + month + '/submit', {
      method: 'POST', headers: _headers(),
    });
    const body = await res.json().catch(() => ({}));
    // Surface the server's own wording (empty month, already locked, not
    // your department) rather than a generic failure.
    if (!res.ok) throw new Error(body.error || ('Submit failed (' + res.status + ')'));
    return body;
  }

  async function reopenKpiMonth(dept, year, month, reason) {
    const res = await fetch(BASE + '/kpi/' + encodeURIComponent(dept) + '/' + year + '/' + month + '/reopen', {
      method: 'POST', headers: _headers(), body: JSON.stringify({ reason }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('Reopen failed (' + res.status + ')'));
    return body;
  }

  /* ── Admin: user provisioning (admin-users.html) ───────────────────
     All admin-only server-side. Errors carry the server's own wording —
     "that email is already on another account", "you cannot change your
     own access level" — which is more useful than a status code, so these
     throw Error(body.error) rather than the generic _httpError. */
  async function adminGetCatalogue() {
    const res = await fetch(BASE + '/admin/catalogue', { headers: _headers() });
    if (!res.ok) throw _httpError('adminGetCatalogue', '', res);
    return res.json();
  }

  async function adminListUsers(filters) {
    const qs = new URLSearchParams();
    Object.entries(filters || {}).forEach(([k, v]) => { if (v) qs.set(k, v); });
    const res = await fetch(BASE + '/admin/users?' + qs.toString(), { headers: _headers() });
    if (!res.ok) throw _httpError('adminListUsers', '', res);
    return res.json();
  }

  async function _adminWrite(path, method, body) {
    const res = await fetch(BASE + path, {
      method, headers: _headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || (method + ' ' + path + ' failed (' + res.status + ')'));
    return payload;
  }

  // Resolves to { user, temporaryPassword } — the password is shown once
  // and is not recoverable afterwards.
  const adminCreateUser  = (data)     => _adminWrite('/admin/users', 'POST', data);
  const adminUpdateUser  = (id, data) => _adminWrite('/admin/users/' + id, 'PATCH', data);
  const adminResetPw     = (id)       => _adminWrite('/admin/users/' + id + '/reset-password', 'POST');
  const adminUnlockUser  = (id)       => _adminWrite('/admin/users/' + id + '/unlock', 'POST');
  // Mails a single-use activation link instead of handing a password over.
  // Also the "resend" — issuing supersedes any earlier outstanding invite.
  const adminInviteUser  = (id)       => _adminWrite('/admin/users/' + id + '/invite', 'POST');
  const adminInviteBulk  = (filter)   => _adminWrite('/admin/users/invite-bulk', 'POST', filter || {});

  async function adminInviteReadiness() {
    const res = await fetch(BASE + '/admin/invite-readiness', { headers: _headers() });
    if (!res.ok) throw _httpError('adminInviteReadiness', '', res);
    return res.json();
  }

  global.NyatiAPI = {
    submitForm, getForm, getFormRange,
    evalFormulas, getDailySeries, setOverride, clearOverride, getOverrides,
    getBaseline, getCompleteness, getDataRange, getDailySummary,
    getStoppageInsights, getEquipmentStoppageDetail,
    quarryImportTickets, quarryGetTickets,
    getSalesTerritories, getSalesDashboard, setSalesTarget,
    getPurchasesDashboard,
    getApprovals, approveReport, rejectReport,
    getMisEmployees, getMisItAssets, getMisVehicles, getMisComplianceCerts,
    getKpiSubmission, submitKpiMonth, reopenKpiMonth,
    adminGetCatalogue, adminListUsers, adminCreateUser, adminUpdateUser,
    adminResetPw, adminUnlockUser,
    adminInviteUser, adminInviteBulk, adminInviteReadiness,
  };

}(window));
