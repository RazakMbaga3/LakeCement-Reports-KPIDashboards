/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — Cross-Form Report Data Bridge  v1.0
   ─────────────────────────────────────────────────────────────────
   PROBLEM this solves:
     Each daily entry form saves its own localStorage snapshot under
     nyati-{formId}-{YYYY-MM-DD}.  Reports live in a different page
     and call initFormPersist('production') for their own snapshot.
     Without this bridge, form data never reaches report KPI cards —
     operators end up entering the same figures twice.

   WHAT it does:
     1. Reads named-field dicts from one or more source forms for
        the currently selected date.
     2. Runs "compute" functions against the merged dict to produce
        KPI values → writes to [data-kpi="..."] elements.
     3. Runs "fill" functions → pre-populates report input fields
        that should be sourced from a form (not re-entered).
        Fills only run if the target field is blank or was last
        written by a previous cross-fill (won't clobber manual edits).

   Usage — add after form-persist.js + initFormPersist() in a report:
     <script src="forms/report-loader.js"></script>
     <script>
     initReportLoader({
       forms: ['materials', 'power-cons', 'quality'],
       computes: [
         { kpi:'total_power', fmt:'n0',
           compute: function(d,n){ return n(d.pwr_crusher_kwh)+n(d.pwr_rawmill_kwh)+...; } }
       ],
       fills: [
         { field:'coal_kiln',
           compute: function(d,n){ return n(d.coal_k_s1)+n(d.coal_k_s2)+...; } }
       ]
     });
     </script>

   localStorage key format:  nyati-{formId}-{YYYY-MM-DD}
   ══════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  const NS = 'nyati';

  /* ── Safe number parse (handles comma-formatted strings) ────────── */
  function _num(v) {
    if (v === '' || v == null) return 0;
    const n = +(String(v).replace(/,/g, ''));
    return isNaN(n) ? 0 : n;
  }

  /* ── Format a computed value for display ────────────────────────── */
  function _fmt(val, fmt) {
    if (val === null || val === undefined) return null;
    const n = +val;
    if (isNaN(n)) return null;
    switch (fmt) {
      case 'n0':   return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
      case 'n1':   return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      case 'n2':   return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      case 'pct1': return n.toFixed(1) + '%';
      case 'pct2': return n.toFixed(2) + '%';
      default:     return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }
  }

  /* ── Read named-field dict from a saved form snapshot ───────────── */
  function _readForm(formId, date) {
    const raw = localStorage.getItem(`${NS}-${formId}-${date}`);
    if (!raw) return {};
    try {
      const p = JSON.parse(raw);
      return p.data || {};   // Phase 2 named dict
    } catch (e) { return {}; }
  }

  /* ── Merge all source forms for a given date ────────────────────── */
  function _loadAll(formIds, date) {
    const merged = {};
    (formIds || []).forEach(id => {
      const d = _readForm(id, date);
      Object.entries(d).forEach(([k, v]) => {
        // Later forms overwrite on key collision — order matters
        merged[k] = v;
      });
    });
    return merged;
  }

  /* ── Update [data-kpi] card values ─────────────────────────────── */
  function _applyComputes(computes, data) {
    (computes || []).forEach(c => {
      const el = document.querySelector(`[data-kpi="${c.kpi}"]`);
      if (!el) return;
      let val;
      try { val = c.compute(data, _num); } catch (e) { return; }
      if (val === null || val === undefined || isNaN(+val) || +val === 0) return;
      const str = _fmt(val, c.fmt || 'n0');
      if (str !== null) el.textContent = str;
    });
  }

  /* ── Pre-populate report input fields from cross-form data ──────── */
  function _applyFills(fills, data) {
    (fills || []).forEach(f => {
      const sel = `input[data-field="${f.field}"], select[data-field="${f.field}"]`;
      const el = document.querySelector(sel);
      if (!el) return;

      let val;
      try { val = f.compute(data, _num); } catch (e) { return; }
      if (val === null || val === undefined || isNaN(+val)) return;

      const num = +val;

      // Skip if cross-fill would write 0 into a field already containing a non-zero value
      if (num === 0 && el.value !== '' && el.value !== '0') return;

      // Only fill if field is blank OR was last written by a previous cross-fill
      const wasCrossFilled = el.getAttribute('data-cross-filled') === '1';
      if (el.value === '' || el.value === '0' || wasCrossFilled) {
        el.value = num;
        el.setAttribute('data-cross-filled', '1');
        // Bubble an input event so kpi-live.js reacts
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }

  /* ── Show/hide a badge indicating cross-form data loaded ────────── */
  function _badge(formIds, date, data) {
    const loaded = (formIds || []).filter(id => {
      const raw = localStorage.getItem(`${NS}-${id}-${date}`);
      return raw !== null;
    });
    let chip = document.getElementById('_rl-badge');
    if (!chip) {
      chip = document.createElement('span');
      chip.id = '_rl-badge';
      chip.title = 'Cross-form data auto-loaded';
      Object.assign(chip.style, {
        fontSize: '9px', fontWeight: '700', padding: '2px 8px',
        borderRadius: '4px', background: '#EFF6FF', color: '#1D4ED8',
        border: '1px solid #BFDBFE', letterSpacing: '.4px',
        textTransform: 'uppercase', whiteSpace: 'nowrap', flexShrink: '0'
      });
      const grp = document.querySelector('.btn-grp');
      if (grp) grp.parentElement.insertBefore(chip, grp);
    }
    if (loaded.length > 0) {
      chip.textContent = `↓ ${loaded.length} form${loaded.length > 1 ? 's' : ''} loaded`;
      chip.style.display = '';
    } else {
      chip.style.display = 'none';
    }
  }

  /* ── Main run: load + apply ────────────────────────────────────── */
  function _run(config) {
    const dateEl = document.querySelector('input[type="date"]');
    const date   = dateEl ? dateEl.value : new Date().toISOString().slice(0, 10);
    const data   = _loadAll(config.forms, date);
    _applyComputes(config.computes, data);
    _applyFills(config.fills, data);
    _badge(config.forms, date, data);
  }

  /* ══ Public entry point ════════════════════════════════════════════ */
  let _activeConfig = null;

  global.initReportLoader = function (config) {
    _activeConfig = config;

    // Re-run when date picker changes
    const dateEl = document.querySelector('input[type="date"]');
    if (dateEl) {
      dateEl.addEventListener('change', () => _run(config));
    }

    // Re-run after form-persist restores a production snapshot
    document.addEventListener('nyati:restored', () => setTimeout(() => _run(config), 80));

    // Re-run after inline section save
    document.addEventListener('nyati:inline-saved', () => setTimeout(() => _run(config), 80));

    // Initial run — wait 160 ms for form-persist to initialise first
    setTimeout(() => _run(config), 160);
  };

  // Exposed so inline-edit.js can trigger a KPI refresh after saving
  global.refreshReportLoader = function () {
    if (_activeConfig) _run(_activeConfig);
  };

}(window));
