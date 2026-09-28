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
     them. Only for callers that own the whole record (importers, syncs).
     `opts.autosave` — the form's unattended background save: merges into a
     report that is still editable, never changes its status, never touches a
     submitted/approved one (409) and leaves no audit row.
     `opts.keepalive` — let the request outlive the page (a save fired as the
     tab is closing). Browsers cap such a body at 64 KB. */
  async function submitForm(formType, date, shift, data, opts) {
    const body = { date, shift: shift || 'day', data };
    if (opts && opts.status)   body.status   = opts.status;
    if (opts && opts.replace)  body.replace  = true;
    if (opts && opts.autosave) body.autosave = true;
    const res = await fetch(BASE + '/reports/' + encodeURIComponent(formType), {
      method:  'POST',
      headers: _headers(),
      body:    JSON.stringify(body),
      keepalive: !!(opts && opts.keepalive),
    });
    if (!res.ok) {
      const err = _httpError('submitForm', formType, res);
      /* The refusal's own body: REPORT_LOCKED and WINDOW_CLOSED are both a 409,
         and the form has to say different things about them — "ask for a
         correction" versus "your correction window has closed". The generic
         message only ever carried the status. Best-effort: a non-JSON body
         (an HTML error page from a proxy) simply leaves these unset. */
      try {
        const b = await res.json();
        if (b) { err.code = b.code; err.serverMessage = b.error; err.body = b; }
      } catch (e) { /* not JSON */ }
      throw err;
    }
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

  /* GET /api/reports/:formType/history — which days have a record, newest
     first, as [{ record_date, status, updated_at, … }]. Dates and statuses
     only, no field data. Feeds form-persist's "Load Previous" so a draft
     saved on another device is listed, not just this browser's own. A
     result shorter than `limit` is the complete list. */
  async function getFormHistory(formType, limit) {
    const qs = limit ? ('?limit=' + encodeURIComponent(limit)) : '';
    const res = await fetch(BASE + '/reports/' + encodeURIComponent(formType) + '/history' + qs, {
      headers: _headers(),
    });
    if (!res.ok) throw _httpError('getFormHistory', formType, res);
    return res.json();
  }

  /* GET /api/reports/unfinished — my drafts and rejected reports across every
     form this role may submit, over the last `days` days, newest first:
     [{ form_type, record_date, status, updated_at, rejection_reason }].
     Feeds the "unfinished report" banner on the forms and the sidebar dots. */
  async function getUnfinished(days) {
    const qs = days ? ('?days=' + encodeURIComponent(days)) : '';
    const res = await fetch(BASE + '/reports/unfinished' + qs, { headers: _headers() });
    if (!res.ok) throw _httpError('getUnfinished', '', res);
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
  /* Takes the resolved period as an object — { mode, year, month,
     quarter, from, to } — since 2026-09-22, when the dashboard gained
     quarter / year-to-date / custom-range filters. The old positional
     (year, month) call is still accepted so any other caller keeps
     working; backend/services/purchases.js resolvePeriod() defaults every
     omitted part, so an empty object is a valid "current month". */
  async function getPurchasesDashboard(period, monthArg) {
    const spec = (period && typeof period === 'object')
      ? period
      : { year: period, month: monthArg };
    const params = new URLSearchParams();
    ['mode', 'year', 'month', 'quarter', 'from', 'to'].forEach(k => {
      if (spec[k] !== undefined && spec[k] !== null && spec[k] !== '') params.set(k, spec[k]);
    });
    const qs = params.toString();
    const res = await fetch(BASE + '/purchases/dashboard' + (qs ? '?' + qs : ''), { headers: _headers() });
    if (!res.ok) throw _httpError('getPurchasesDashboard', qs || 'current month', res);
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

  /* ── IT Asset Register (backend/routes/itAssets.js) ────────────────
     Database-backed, editable, Excel-importable — replaces the static
     snapshot GET /api/mis/it-assets still serves to mis.html's own tab
     (that page is unchanged; this is the new it-assets.html's API). */
  async function itAssetsOverview() {
    const res = await fetch(BASE + '/it-assets', { headers: _headers() });
    if (!res.ok) throw _httpError('itAssetsOverview', '', res);
    return res.json();
  }
  async function itAssetsList(category, opts) {
    const params = new URLSearchParams();
    if (opts && opts.q)      params.set('q', opts.q);
    if (opts && opts.limit)  params.set('limit', opts.limit);
    if (opts && opts.offset) params.set('offset', opts.offset);
    const qs = params.toString();
    const res = await fetch(BASE + '/it-assets/' + encodeURIComponent(category) + (qs ? '?' + qs : ''), { headers: _headers() });
    if (!res.ok) throw _httpError('itAssetsList', category, res);
    return res.json();
  }
  async function itAssetCreate(category, data) {
    const res = await fetch(BASE + '/it-assets/' + encodeURIComponent(category), {
      method: 'POST', headers: _headers(), body: JSON.stringify(data),
    });
    if (!res.ok) throw _httpError('itAssetCreate', category, res);
    return res.json();
  }
  async function itAssetUpdate(category, id, patch) {
    const res = await fetch(BASE + '/it-assets/' + encodeURIComponent(category) + '/' + encodeURIComponent(id), {
      method: 'PUT', headers: _headers(), body: JSON.stringify(patch),
    });
    if (!res.ok) throw _httpError('itAssetUpdate', category, res);
    return res.json();
  }
  async function itAssetDelete(category, id) {
    const res = await fetch(BASE + '/it-assets/' + encodeURIComponent(category) + '/' + encodeURIComponent(id), {
      method: 'DELETE', headers: _headers(),
    });
    if (!res.ok) throw _httpError('itAssetDelete', category, res);
    return res.json();
  }
  /* Multipart upload — deliberately NOT using _headers(), which sets
     Content-Type: application/json; fetch must set its own multipart
     boundary for a FormData body, so only the Authorization header is
     carried over here. */
  async function itAssetsImport(file) {
    const token = (typeof getAuthToken === 'function') ? getAuthToken() : null;
    const h = {};
    if (token) h['Authorization'] = 'Bearer ' + token;
    const body = new FormData();
    body.append('file', file);
    const res = await fetch(BASE + '/it-assets/import', { method: 'POST', headers: h, body });
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).error || ''; } catch { /* non-JSON error body */ }
      const err = _httpError('itAssetsImport', file.name, res);
      if (msg) err.serverMessage = msg;
      throw err;
    }
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

  /* ── Correction requests (routes/amendments.js) ────────────────────
     A locked report (approved, or awaiting sign-off) can be corrected only
     through a request an approver grants. Errors carry the server's own
     wording AND its machine-readable code — "you cannot decide your own
     correction request", AMENDMENT_ALREADY_OPEN — because the page needs both:
     the sentence for the person, the code to decide what to show. */
  async function _amend(method, path, body) {
    const res = await fetch(BASE + '/amendments' + path, {
      method, headers: _headers(), body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((json && json.error) || ('Correction request failed (' + res.status + ')'));
      err.status = res.status;
      err.code = json && json.code;
      err.body = json;
      throw err;
    }
    return json;
  }
  const _ap = (formType, date) => '/' + encodeURIComponent(formType) + '/' + encodeURIComponent(date);

  /* POST — ask for a correction. `reason` is at least 10 characters. */
  function requestAmendment(formType, date, reason, opts) {
    return _amend('POST', _ap(formType, date), Object.assign({ reason }, opts || {}));
  }
  /* GET — my requests (officer), or the ones I decide (HOD), or all (admin/md). */
  function getAmendments(state, days) {
    const qs = new URLSearchParams({ state: state || 'open' });
    if (days) qs.set('days', days);
    return _amend('GET', '?' + qs.toString());
  }
  /* POST — open a time-boxed window. `hours` 1-72, default 24. */
  function grantAmendment(formType, date, id, hours, note) {
    return _amend('POST', _ap(formType, date) + '/' + id + '/grant', { hours: hours || undefined, note: note || undefined });
  }
  /* POST — refuse, with a reason (at least 10 characters). */
  function declineAmendment(formType, date, id, note) {
    return _amend('POST', _ap(formType, date) + '/' + id + '/decline', { note });
  }
  /* POST — take back a request nobody has decided yet. */
  function withdrawAmendment(formType, date, id) {
    return _amend('POST', _ap(formType, date) + '/' + id + '/withdraw', {});
  }
  /* GET — a day's requests and the revision trail behind it (no figures). */
  function getAmendmentHistory(formType, date) {
    return _amend('GET', _ap(formType, date));
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

  /* ── Stoppage reason catalogue (routes/stoppage.js) ──────────────
     The governed vocabulary the stoppage form renders its rows from,
     instead of asking the shift to describe a fault in its own words. */
  async function getStoppageReasons() {
    const res = await fetch(BASE + '/stoppage/reasons', { headers: _headers() });
    if (!res.ok) throw _httpError('getStoppageReasons', '', res);
    return res.json();
  }

  async function addStoppageReason(equipment, cause, label) {
    const res = await fetch(BASE + '/stoppage/reasons', {
      method:  'POST',
      headers: _headers(),
      body:    JSON.stringify({ equipment, cause, label }),
    });
    if (!res.ok) throw _httpError('addStoppageReason', equipment, res);
    return res.json();
  }

  /* ── Power Consumption Report — fixed Specific Power targets
     (routes/power.js) ── one authoritative value per section, read by
     every day's report instead of typed in fresh each time. */
  async function getPowerTargets() {
    const res = await fetch(BASE + '/power/targets', { headers: _headers() });
    if (!res.ok) throw _httpError('getPowerTargets', '', res);
    return res.json();
  }

  async function setPowerTarget(section, targetKwhMt) {
    const res = await fetch(BASE + '/power/targets/' + encodeURIComponent(section), {
      method:  'PUT',
      headers: _headers(),
      body:    JSON.stringify({ target_kwh_mt: targetKwhMt }),
    });
    if (!res.ok) throw _httpError('setPowerTarget', section, res);
    return res.json();
  }

  global.NyatiAPI = {
    submitForm, getForm, getFormRange, getFormHistory, getUnfinished,
    evalFormulas, getDailySeries, setOverride, clearOverride, getOverrides,
    getBaseline, getCompleteness, getDataRange, getDailySummary,
    getStoppageInsights, getEquipmentStoppageDetail,
    getStoppageReasons, addStoppageReason,
    getPowerTargets, setPowerTarget,
    quarryImportTickets, quarryGetTickets,
    getSalesTerritories, getSalesDashboard, setSalesTarget,
    getPurchasesDashboard,
    getApprovals, approveReport, rejectReport,
    requestAmendment, getAmendments, grantAmendment, declineAmendment, withdrawAmendment, getAmendmentHistory,
    getMisEmployees, getMisItAssets, getMisVehicles, getMisComplianceCerts,
    itAssetsOverview, itAssetsList, itAssetCreate, itAssetUpdate, itAssetDelete, itAssetsImport,
    getKpiSubmission, submitKpiMonth, reopenKpiMonth,
    adminGetCatalogue, adminListUsers, adminCreateUser, adminUpdateUser,
    adminResetPw, adminUnlockUser,
    adminInviteUser, adminInviteBulk, adminInviteReadiness,
  };

}(window));
