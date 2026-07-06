/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — Browser Error Reporter
   ─────────────────────────────────────────────────────────────────
   Posts uncaught JS errors and unhandled promise rejections to
   POST /api/client-errors so plant-floor browser failures show up on
   the admin Monitor page instead of dying silently in someone's tab.

   Max 5 reports per page load (a crash loop must not flood anything);
   the server rate-limits per IP on top. Works logged-in or not — the
   token is attached when available so the report is attributed.

   Load order: after auth.js (uses _API_BASE / getAuthToken if present).
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var MAX_PER_PAGE = 5;
  var sent = 0;

  function apiBase() {
    return (typeof _API_BASE !== 'undefined') ? _API_BASE : 'http://localhost:5000/api';
  }

  function report(message, source, line, stack) {
    if (sent >= MAX_PER_PAGE || !message) return;
    sent++;
    try {
      var headers = { 'Content-Type': 'application/json' };
      var token = (typeof getAuthToken === 'function') ? getAuthToken() : null;
      if (token) headers['Authorization'] = 'Bearer ' + token;

      fetch(apiBase() + '/client-errors', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          message: String(message).slice(0, 500),
          source:  source ? String(source).slice(0, 300) : null,
          line:    typeof line === 'number' ? line : null,
          page:    window.location.pathname.split('/').pop() || 'index.html',
          stack:   stack ? String(stack).slice(0, 2000) : null,
        }),
      }).catch(function () { /* reporting must never cause more errors */ });
    } catch (e) { /* ditto */ }
  }

  window.addEventListener('error', function (e) {
    report(e.message, e.filename, e.lineno, e.error && e.error.stack);
  });

  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason || {};
    report(r.message || String(r), null, null, r.stack);
  });

}());
