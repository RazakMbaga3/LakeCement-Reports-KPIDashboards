/* ══════════════════════════════════════════════════════════════════════
   Lake Cement Ltd — CHART THEME  |  chart-theme.js
   ──────────────────────────────────────────────────────────────────────
   One visual language for every chart in the dashboard. Load AFTER
   Chart.js and BEFORE any page script that constructs a chart.

   Why a shared theme
   ──────────────────
   The ten charts across six pages each carried their own colours, fonts
   and grid styling. Three consequences:

   1. The brand palette was being used as a data palette. #173158 was
      serving as a chart series colour, and it fails the categorical
      checks outright — OKLCH lightness 0.315 (outside the 0.43–0.77
      band) and chroma 0.077 (below the 0.1 floor, so it reads as grey
      rather than as a hue). A brand colour identifies a company; a
      series colour has to identify a series to someone with
      colour-vision deficiency, on a projector, in a print-out. Those
      are different jobs.
   2. Axis and legend labels sat at 9–10px, which is below the app's
      legibility floor. They were invisible to the DOM audit because
      canvas text is a bitmap, so the regression could never be caught
      automatically — the numbers here are the guard.
   3. Grid lines competed with the data. Few's rule: chrome recedes,
      data advances.

   The palette (LCL_CHART.series) is machine-validated, not chosen by
   eye. See design-system.css §1 for the run and its results.

   Usage
   ─────
     backgroundColor: LCL_CHART.series[0]
     backgroundColor: LCL_CHART.seriesFor(i)      // wraps safely, never cycles hue
     backgroundColor: LCL_CHART.alpha(LCL_CHART.series[0], .12)
     options: LCL_CHART.merge({ scales: { y: { title: … } } })
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

var LCL_CHART = (function () {

  var css = function (name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (_) { return fallback; }
  };

  /* Read from the design-system tokens so the palette has exactly one
     home. The literals are the same values, kept only as a fallback for
     the case where design-system.css has not parsed yet. */
  var SERIES = [
    css('--series-1', '#1F5FA8'),
    css('--series-2', '#EB6834'),
    css('--series-3', '#1BAF7A'),
    css('--series-4', '#EDA100'),
    css('--series-5', '#E87BA4'),
    css('--series-6', '#008300'),
    css('--series-7', '#4A3AA7'),
    css('--series-8', '#E34948'),
  ];

  var STATUS = {
    good:    css('--st-good',    '#157F4B'),
    warning: css('--st-warn',    '#9A6100'),
    bad:     css('--st-bad',     '#C0271F'),
    neutral: css('--st-neutral', '#5A6270'),
  };

  var SEQUENTIAL = ['--seq-1','--seq-2','--seq-3','--seq-4','--seq-5','--seq-6','--seq-7']
    .map(function (n, i) { return css(n, ['#EAF1F9','#C5D8EE','#93B6DC','#5B8FC7','#2F6BAE','#1F5FA8','#14406F'][i]); });

  var DIVERGING = ['--div-neg-3','--div-neg-2','--div-neg-1','--div-mid','--div-pos-1','--div-pos-2','--div-pos-3']
    .map(function (n, i) { return css(n, ['#A32E24','#D8604F','#F0A99C','#EFEFEF','#A5D9BF','#4FA97C','#14713F'][i]); });

  var INK    = css('--chart-ink',   '#111827');
  var INK_2  = css('--chart-ink-2', '#5A6270');
  var GRID   = css('--chart-grid',  '#EDF0F5');
  var AXIS   = css('--chart-axis',  '#C8CDD5');
  var FONT   = "'Inter', system-ui, -apple-system, sans-serif";

  var isMobile = function () {
    try { return window.matchMedia('(max-width: 959px)').matches; } catch (_) { return false; }
  };

  /* The legibility floor applies to canvas text too — arguably more,
     since a reader cannot zoom a bitmap label the way they can zoom
     DOM text. */
  var FS_BASE  = function () { return isMobile() ? 13 : 12; };
  var FS_TITLE = function () { return isMobile() ? 14 : 13; };

  /* Hex → rgba. Used for area fills, which must stay far lighter than
     the line that owns them or the fill starts reading as data. */
  function alpha(hex, a) {
    if (!hex || hex.charAt(0) !== '#') return hex;
    var h = hex.slice(1);
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n>>16)&255) + ',' + ((n>>8)&255) + ',' + (n&255) + ',' + a + ')';
  }

  /* Categorical hues are assigned in fixed order and NEVER cycled: a
     9th series repainting slot 1 would say "these two are the same
     thing". Past the palette, everything folds into one neutral, which
     is the honest signal that the chart has too many series and should
     be faceted or rolled into "Other". */
  function seriesFor(i) {
    return (i < SERIES.length) ? SERIES[i] : STATUS.neutral;
  }

  /* Break a long category label across at most two lines, on a space.
     Chart.js renders an array of strings as stacked tick lines. Returns
     the value untouched when it is short, not a string, or a single long
     word there is no safe place to break. */
  var TICK_CHARS = 14;
  function wrapTick(label) {
    if (typeof label !== 'string' || label.length <= TICK_CHARS) return label;
    var words = label.split(' ');
    if (words.length < 2) return label;
    var mid = Math.ceil(words.length / 2);
    return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
  }

  /* ── Global defaults ───────────────────────────────────────────── */
  function apply() {
    if (typeof Chart === 'undefined' || !Chart.defaults) return false;
    var d = Chart.defaults;

    d.font.family = FONT;
    d.font.size   = FS_BASE();
    d.font.weight = 500;
    d.color       = INK_2;
    d.borderColor = GRID;

    d.plugins.legend.labels.font        = { family: FONT, size: FS_BASE(), weight: 600 };
    d.plugins.legend.labels.color       = INK_2;
    d.plugins.legend.labels.usePointStyle = true;
    d.plugins.legend.labels.pointStyle  = 'circle';
    d.plugins.legend.labels.boxWidth    = 8;
    d.plugins.legend.labels.boxHeight   = 8;
    d.plugins.legend.labels.padding     = 14;

    /* Tooltips are the interaction layer an HTML chart owes the reader.
       Dark surface, high contrast, generous padding — a tooltip that is
       hard to read defeats its own purpose. */
    d.plugins.tooltip.backgroundColor = 'rgba(17,24,39,.94)';
    d.plugins.tooltip.titleColor      = 'rgba(255,255,255,.72)';
    d.plugins.tooltip.bodyColor       = '#FFFFFF';
    d.plugins.tooltip.titleFont       = { family: FONT, size: FS_BASE(), weight: 700 };
    d.plugins.tooltip.bodyFont        = { family: FONT, size: FS_TITLE(), weight: 600 };
    d.plugins.tooltip.padding         = 10;
    d.plugins.tooltip.cornerRadius    = 8;
    d.plugins.tooltip.displayColors   = true;
    d.plugins.tooltip.boxPadding      = 4;

    /* Hit targets bigger than the mark — on a phone the mark is the
       size of a grain of rice and the finger is not. */
    d.interaction.mode      = 'index';
    d.interaction.intersect = false;

    /* Category labels wrap instead of colliding.
       The Pareto charts on reliability.html rank six causes across a
       ~560px canvas, which leaves ~90px a slot; "Planned Maintenance"
       and "Electrical & Instr." need ~130px and were overprinting their
       neighbours at the 20° rotation the pages ask for. Canvas text is a
       bitmap, so no audit in this repo can see that — it is only ever
       caught by looking, which is how it was found.

       Set as a Chart.js DEFAULT rather than in merge(): every page that
       needs this writes its own `scales.x.ticks`, so a default is the
       only place that reaches all of them. A page wanting different
       behaviour still overrides `callback` and wins. */
    if (d.scales && d.scales.category && d.scales.category.ticks) {
      d.scales.category.ticks.callback = function (value) {
        var label = this.getLabelForValue ? this.getLabelForValue(value) : value;
        return wrapTick(label);
      };
    }

    /* Thin marks, visible points. */
    if (d.elements) {
      if (d.elements.line)  { d.elements.line.borderWidth = 2; d.elements.line.tension = 0.28; }
      if (d.elements.point) { d.elements.point.radius = 0; d.elements.point.hoverRadius = 5; d.elements.point.hitRadius = 12; }
      if (d.elements.bar)   { d.elements.bar.borderRadius = 3; d.elements.bar.borderSkipped = false; }
      if (d.elements.arc)   { d.elements.arc.borderWidth = 2; d.elements.arc.borderColor = '#FFFFFF'; }
    }

    if (d.scale && d.scale.grid) {
      d.scale.grid.color       = GRID;
      d.scale.grid.drawBorder  = false;
      d.scale.grid.tickLength  = 0;
    }
    if (d.scale && d.scale.ticks) {
      d.scale.ticks.color   = INK_2;
      d.scale.ticks.padding = 6;
      d.scale.ticks.font    = { family: FONT, size: FS_BASE(), weight: 500 };
    }
    return true;
  }

  /* Sensible option scaffolding a page can spread its own config into.
     Deliberately shallow-merged one level down so a page overriding
     `scales.y` does not silently lose `scales.x`. */
  function merge(opts) {
    opts = opts || {};
    var base = {
      responsive: true,
      plugins: {
        legend: { position: 'top', align: 'end' },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: isMobile() ? 45 : 20, autoSkip: true,
             maxTicksLimit: isMobile() ? 6 : 12 } },
        y: { beginAtZero: true, grid: { color: GRID }, border: { display: false } },
      },
    };
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    Object.keys(opts).forEach(function (k) {
      if (out[k] && typeof out[k] === 'object' && typeof opts[k] === 'object' && !Array.isArray(opts[k])) {
        var m = {};
        Object.keys(out[k]).forEach(function (j) { m[j] = out[k][j]; });
        Object.keys(opts[k]).forEach(function (j) { m[j] = opts[k][j]; });
        out[k] = m;
      } else {
        out[k] = opts[k];
      }
    });
    return out;
  }

  /* Chart.js reads font sizes once, at construction. Crossing the mobile
     breakpoint therefore needs the defaults re-applied and live charts
     nudged, or a phone rotated to landscape keeps the phone type scale. */
  function watchBreakpoint() {
    try {
      var mq = window.matchMedia('(max-width: 959px)');
      var onChange = function () {
        apply();
        if (Chart.instances) {
          Object.keys(Chart.instances).forEach(function (k) {
            try { Chart.instances[k].update('none'); } catch (_) {}
          });
        }
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    } catch (_) {}
  }

  /* Chart.js may still be loading from the CDN when this file runs. */
  if (!apply()) {
    var tries = 0;
    var t = setInterval(function () {
      if (apply() || ++tries > 40) { clearInterval(t); watchBreakpoint(); }
    }, 50);
  } else {
    watchBreakpoint();
  }

  return {
    series: SERIES,
    seriesFor: seriesFor,
    status: STATUS,
    sequential: SEQUENTIAL,
    diverging: DIVERGING,
    ink: INK,
    ink2: INK_2,
    grid: GRID,
    axis: AXIS,
    font: FONT,
    alpha: alpha,
    apply: apply,
    merge: merge,
    isMobile: isMobile,
  };
})();
