/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — MTD / Fiscal-YTD Rollup Engine
   ─────────────────────────────────────────────────────────────────
   Sums a form's daily submissions across a date range and paints the
   result into declarative [data-roll-mtd]/[data-roll-ytd] cells —
   the table-authoring side only has to tag a cell with the field(s)
   to sum (comma-separated for a multi-field total row); this module
   does the fetching and arithmetic.

   Uses the existing NyatiAPI.getFormRange(formType, from, to) (server-
   first, `daily_reports` date-range query) with a day-by-day
   localStorage fallback when offline, mirroring report-loader.js's
   own server-first/localStorage-fallback pattern.

   Fiscal year starts 1 April (matches mines-report.html's convention).

   Usage — after form-persist.js + initFormPersist():
     <script src="forms/report-rollup.js"></script>
     <script>initReportRollup({ form: 'production' });</script>
   ══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const NS = 'nyati';

  function _num(v) {
    if (v === '' || v == null) return 0;
    const n = +(String(v).replace(/,/g, ''));
    return isNaN(n) ? 0 : n;
  }

  function _fmt(n) {
    return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  function _iso(d) { return d.toISOString().slice(0, 10); }

  function _monthStart(dateStr) {
    return dateStr.slice(0, 8) + '01';
  }

  /* fiscal year runs 1 April → 31 March */
  function _fiscalStart(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; // getMonth() 3 = April
    return y + '-04-01';
  }

  /* day-by-day localStorage fallback for a form+range when the API is unreachable */
  function _localRange(formId, from, to) {
    const rows = [];
    let cur = new Date(from + 'T00:00:00');
    const end = new Date(to + 'T00:00:00');
    while (cur <= end) {
      const iso = _iso(cur);
      const raw = localStorage.getItem(`${NS}-${formId}-${iso}`);
      if (raw) {
        try {
          const p = JSON.parse(raw);
          if (p.data) rows.push({ record_date: iso, data: p.data });
        } catch (e) { /* skip corrupt entry */ }
      }
      cur.setDate(cur.getDate() + 1);
    }
    return rows;
  }

  async function _fetchRange(formId, from, to) {
    if (global.NyatiAPI) {
      try {
        const rows = await global.NyatiAPI.getFormRange(formId, from, to);
        if (Array.isArray(rows)) return rows.map(r => ({ record_date: r.record_date, data: r.data || {} }));
      } catch (e) { /* fall through to localStorage */ }
    }
    return _localRange(formId, from, to);
  }

  /* sum one or more comma-separated fields across every row in a range */
  function _sumFields(rows, fieldSpec) {
    const fields = fieldSpec.split(',').map(s => s.trim());
    let total = 0;
    rows.forEach(row => {
      fields.forEach(f => { total += _num(row.data[f]); });
    });
    return total;
  }

  function _paint(selectorAttr, rows) {
    document.querySelectorAll('[' + selectorAttr + ']').forEach(el => {
      const spec = el.getAttribute(selectorAttr);
      el.textContent = _fmt(_sumFields(rows, spec));
    });
  }

  /* ── Live mode (config.live: true) ───────────────────────────────────
     The day open in the form may be mid-edit and not yet saved, so its
     figures can't come from the last server fetch. _run() below fetches
     the MTD/YTD history as before but DROPS the open date's own row from
     it, caching the rest; _paintFromCache() rebuilds that one day's row
     straight from the live [data-field] inputs and appends it before
     summing. Right after a restore (no edits yet) the DOM holds exactly
     what the server just sent, so this repaints the same total the old
     fetch-only path would have — the only change is that it keeps
     tracking the open day as its inputs change, instead of only on
     save/date-change. Off by default: every other page keeps the exact
     fetch-and-paint behaviour until it's deliberately opted in. */
  let _liveCache = null;   // { form, date, mtdHistory, ytdHistory } — history EXCLUDES `date`

  function _liveRow(date) {
    const data = {};
    document.querySelectorAll('[data-field]').forEach(el => {
      data[el.getAttribute('data-field')] = el.value;
    });
    return { record_date: date, data };
  }

  function _paintFromCache() {
    if (!_liveCache) return;
    const live = _liveRow(_liveCache.date);
    _paint('data-roll-mtd', _liveCache.mtdHistory.concat([live]));
    _paint('data-roll-ytd', _liveCache.ytdHistory.concat([live]));
  }

  async function _run(config) {
    const dateEl = document.querySelector('input[type="date"]');
    const date   = dateEl ? dateEl.value : new Date().toISOString().slice(0, 10);
    if (!date) return;

    const [mtdRows, ytdRows] = await Promise.all([
      _fetchRange(config.form, _monthStart(date), date),
      _fetchRange(config.form, _fiscalStart(date), date),
    ]);

    if (!config.live) {
      _paint('data-roll-mtd', mtdRows);
      _paint('data-roll-ytd', ytdRows);
      return;
    }

    _liveCache = {
      date,
      mtdHistory: mtdRows.filter(r => r.record_date !== date),
      ytdHistory: ytdRows.filter(r => r.record_date !== date),
    };
    _paintFromCache();
  }

  global.initReportRollup = function (config) {
    const dateEl = document.querySelector('input[type="date"]');
    if (dateEl) dateEl.addEventListener('change', () => _run(config));

    document.addEventListener('nyati:restored', () => setTimeout(() => _run(config), 120));
    document.addEventListener('nyati:inline-saved', () => setTimeout(() => _run(config), 120));

    if (config.live) {
      document.addEventListener('input', _paintFromCache);
      document.addEventListener('change', _paintFromCache);
    }

    setTimeout(() => _run(config), 200);
  };

  /* Public read of the same live MTD/YTD sum [data-roll-mtd]/[data-roll-ytd]
     cells are painted from — for a page's own ratio built on top of a
     report-rollup total (e.g. dispatch-form.html's "MTD Target
     Achievement %" = this month's live dispatch sum ÷ this month's target,
     a number that isn't itself a sum so report-rollup can't paint it
     directly). Only meaningful in live mode, once the first fetch has
     landed; returns null otherwise rather than a stale or partial number,
     so a caller should treat null as "not ready yet" and skip painting. */
  global.reportRollupLiveSum = function (period, fieldSpec) {
    if (!_liveCache) return null;
    const history = period === 'ytd' ? _liveCache.ytdHistory : _liveCache.mtdHistory;
    const live = _liveRow(_liveCache.date);
    return _sumFields(history.concat([live]), fieldSpec);
  };

  /* Generalized live rollup: computeFn(dayData) -> a value for ONE day, or
     null if that day doesn't apply — averages the non-null results across
     history + the live open day. This is what lets a page average
     something DERIVED from several fields (e.g. a lab parameter's Day Avg,
     itself the mean of six hourly samples) rather than only one stored
     field directly. reportRollupLiveAvg() below is the single-field
     special case (computeFn = d => d[field]). Same null-when-not-ready
     contract as reportRollupLiveSum(). */
  global.reportRollupLiveCompute = function (period, computeFn) {
    if (!_liveCache) return null;
    const history = period === 'ytd' ? _liveCache.ytdHistory : _liveCache.mtdHistory;
    const live = _liveRow(_liveCache.date);
    const valid = history.concat([live])
      .map(r => computeFn(r.data))
      .filter(v => v !== null && v !== undefined && !isNaN(v));
    return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  };

  /* Plain arithmetic mean over days that actually carry a value for this
     ONE field — the right rollup for an intensive quantity (a lab quality
     reading, a rate) rather than a stock, matching forms/formula-registry
     .js's own `monthlyAgg: 'avg'` convention for free_lime/blaine_425r/
     strength_28d (Σvalid ÷ count(valid), never zero-filling a day with no
     reading). Returns null if live mode isn't on, the cache hasn't loaded
     yet, or no day in range has a value. */
  global.reportRollupLiveAvg = function (period, field) {
    return global.reportRollupLiveCompute(period, function (d) {
      const v = d[field];
      return (v === '' || v === null || v === undefined || isNaN(+v)) ? null : +v;
    });
  };

}(window));
