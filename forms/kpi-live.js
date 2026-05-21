/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — Live KPI Strip Engine  (Phase 2)
   ─────────────────────────────────────────────────────────────────
   Usage on each report/form page:

     <script src="kpi-live.js"></script>
     <script>
       initKpiLive([
         { kpi:'coal_total', compute:(f,n)=>n(f.coal_kiln)+n(f.coal_cpp), fmt:'n0' },
         { kpi:'free_lime',  field:'free_lime', fmt:'pct1' },
         ...
       ]);
     </script>

   Each rule object:
     kpi      — matches [data-kpi="x"] on the .kt-val element
     field    — single data-field name (use for direct 1-to-1 wiring)
     compute  — function(fieldsDict, numHelper) → value (use for formulas)
     fmt      — 'n0' | 'n1' | 'n2' | 'pct0' | 'pct1' | 'pct2'

   Triggers:
     • input / change on any element  → live update while typing
     • nyati:restored custom event    → update after form-persist restores
     • DOMContentLoaded + 60ms delay  → first paint from saved data
   ══════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* ── Collect all [data-field] values into a plain dict ─────────── */
  function _fields() {
    const d = {};
    document.querySelectorAll('[data-field]').forEach(el => {
      d[el.getAttribute('data-field')] = el.value;
    });
    return d;
  }

  /* ── Parse a potentially comma-formatted number safely ────────── */
  function _num(v) {
    if (v === '' || v == null) return 0;
    const n = +(String(v).replace(/,/g, ''));
    return isNaN(n) ? 0 : n;
  }

  /* ── Format a value for display ──────────────────────────────── */
  function _fmt(val, fmt) {
    if (val === null || val === undefined || val === '') return '—';
    const n = +val;
    if (isNaN(n)) return String(val);
    switch (fmt) {
      case 'n0':   return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
      case 'n1':   return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      case 'n2':   return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      case 'pct0': return n.toFixed(0) + '%';
      case 'pct1': return n.toFixed(1) + '%';
      case 'pct2': return n.toFixed(2) + '%';
      default:     return String(val);
    }
  }

  /* ══ Public entry point ════════════════════════════════════════ */
  global.initKpiLive = function (rules) {
    function update() {
      const f = _fields();
      rules.forEach(function (rule) {
        const el = document.querySelector('[data-kpi="' + rule.kpi + '"]');
        if (!el) return;

        let val;
        if (typeof rule.compute === 'function') {
          val = rule.compute(f, _num);
        } else if (rule.field) {
          val = f[rule.field];
        }

        if (val === null || val === undefined) return;
        const display = _fmt(val, rule.fmt || 'n0');
        if (display !== '—') el.textContent = display;
      });
    }

    /* live update on any input/change */
    document.addEventListener('input',  update);
    document.addEventListener('change', update);

    /* update after form-persist.js restores a snapshot */
    document.addEventListener('nyati:restored', update);

    /* initial paint — slight delay to let form-persist initialise first */
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(update, 60); });
    } else {
      setTimeout(update, 60);
    }
  };

}(window));
