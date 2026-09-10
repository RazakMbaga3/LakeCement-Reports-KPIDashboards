/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — Live KPI Strip Engine  (Phase 3)
   ─────────────────────────────────────────────────────────────────
   Rule object properties:
     kpi         — matches [data-kpi="x"] on the .kt-val element
     field       — single data-field name (1-to-1 wiring)
     compute     — function(fieldsDict, numHelper) → value
     fmt         — 'n0'|'n1'|'n2'|'pct0'|'pct1'|'pct2'
     target      — numeric target for RAG + progress bar
     sign        — '>='|'<=' direction (>= = higher is better)
     targetLabel — static string shown in .kt-tgt element
     rag         — function(numVal) → 'on-track'|'watch'|'concern'
                   (overrides target/sign logic for non-linear KPIs)
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

  /* ── Update RAG status, progress bar and achievement % ─────────── */
  function _rag(el, numVal, rule) {
    /* walk up to nearest .kt card */
    var kt = el.parentElement;
    while (kt && !kt.classList.contains('kt')) kt = kt.parentElement;
    if (!kt) return;

    var ragClass = null;
    var barPct   = null;

    if (typeof rule.rag === 'function') {
      ragClass = rule.rag(numVal);

    } else if (rule.target !== undefined && rule.sign) {
      var t = +rule.target, v = numVal;
      if (rule.sign === '>=' || rule.sign === '>') {
        if (t > 0) {
          barPct   = Math.min(v / t * 100, 100);
          ragClass = v >= t ? 'on-track' : v >= t * 0.85 ? 'watch' : 'concern';
        }
      } else {                           /* <= or < */
        if (t > 0) {
          barPct   = Math.min(v / t * 100, 100);
          ragClass = v <= t ? 'on-track' : v <= t * 1.15 ? 'watch' : 'concern';
        } else {
          ragClass = v === 0 ? 'on-track' : v <= 60 ? 'watch' : 'concern';
        }
      }
    }

    if (ragClass) {
      kt.classList.remove('on-track', 'watch', 'concern');
      kt.classList.add(ragClass);
    }

    var fill = kt.querySelector('.kt-bar-fill');
    if (fill && barPct !== null) fill.style.width = barPct.toFixed(1) + '%';

    var pctEl = kt.querySelector('.kt-pct');
    if (pctEl && barPct !== null) pctEl.textContent = barPct.toFixed(1) + '%';
  }

  /* ══ Public entry point ════════════════════════════════════════ */
  global.initKpiLive = function (rules) {
    function update() {
      const f = _fields();
      rules.forEach(function (rule) {
        const els = document.querySelectorAll('[data-kpi="' + rule.kpi + '"]');
        if (!els.length) return;

        let val;
        if (typeof rule.compute === 'function') {
          val = rule.compute(f, _num);
        } else if (rule.field) {
          val = f[rule.field];
        }

        if (val === null || val === undefined) return;
        const display = _fmt(val, rule.fmt || 'n0');
        if (display !== '—') {
          els.forEach(function (el) {
            el.textContent = display;
            _rag(el, _num(val), rule);
          });
        }
      });
      markEmptyValues();
    }

    /* An em-dash at 26px/800 in navy is a solid bar — it reads as a
       redacted figure rather than an absent one. Same treatment the KPI
       dashboard's hero cards already got via .sk-value.is-empty.

       Driven by a MutationObserver, not by this module's update cycle.
       These tiles are written by several modules — report-rollup.js fills
       the MTD roll-ups, the formula layer fills others — so a class set
       from here alone stuck on two dispatch tiles that had since received
       real figures, muting them. Watching the text means whoever writes
       it, the styling follows. */
    let _emptyObserver = null;
    function markEmptyValues() {
      const vals = document.querySelectorAll('.kt-val');
      Array.prototype.forEach.call(vals, function (el) {
        el.classList.toggle('is-empty', /^[—–-]$/.test((el.textContent || '').trim()));
      });
      if (_emptyObserver || !window.MutationObserver) return;
      _emptyObserver = new MutationObserver(function (records) {
        records.forEach(function (r) {
          const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
          if (el && el.classList && el.classList.contains('kt-val')) {
            el.classList.toggle('is-empty', /^[—–-]$/.test((el.textContent || '').trim()));
          }
        });
      });
      Array.prototype.forEach.call(vals, function (el) {
        _emptyObserver.observe(el, { childList: true, characterData: true, subtree: true });
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
