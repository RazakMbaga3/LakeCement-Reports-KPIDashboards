/* ══════════════════════════════════════════════════════════════════════
   Lake Cement Ltd — COMPONENT RUNTIME  |  components.js
   ──────────────────────────────────────────────────────────────────────
   Renders the components in components.css. The important one is the KPI
   card, and the important thing about it is WHERE IT GETS ITS TARGET.

   The problem it exists to solve: before this file, a KPI's target was
   typed into the page as a string. `Target: < 0.30%` on index.html and
   `Target: ≤ 0.30%` on the dispatch form are the same business rule
   written twice, already drifting, with nothing able to detect it — while
   forms/formula-registry.js, the actual single source of truth, sat right
   there holding `target`, `signage`, `targetLabel`, `notes` and `version`
   for every KPI it knows about.

   So: NyatiUI.fromRegistry('burst-bag-rate', value) reads all of that from
   the registry. A page supplies the VALUE and the PERIOD. It does not get
   to state the target. If a KPI is not in the registry, that is now a
   visible fact (`No target defined`) instead of an invented number.

   Everything the drill-down shows is likewise registry-sourced — including
   `notes`, the plain-English statement of method and caveats that until
   now only ever reached docs/KPI_REFERENCE.md.

   Depends on: forms/formula-registry.js (window.NyatiFormulas), and
   lucide-icons.js for glyphs. Neither is fetched here; a page loads them.
   ══════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ══ Registry access ════════════════════════════════════════════════ */
  function _registry() {
    return (global.NyatiFormulas && global.NyatiFormulas.FORMULAS) || {};
  }
  function _facts() {
    return (global.NyatiFormulas && global.NyatiFormulas.FACTS) || {};
  }

  /* ══ Numbers ════════════════════════════════════════════════════════
     A blank is not a zero. Every helper here preserves null rather than
     coercing it, because the whole point of the read side is that "no
     report was filed" and "they dispatched nothing" are different facts
     and a dashboard that shows both as 0 cannot be trusted. ═══════════ */
  function num(v) {
    if (v === '' || v === null || v === undefined) return null;
    var n = +(String(v).replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }

  function fmt(v, dp) {
    if (v === null || v === undefined || v === '') return null;
    var n = +v;
    if (isNaN(n)) return null;
    var d = (dp === undefined || dp === null) ? 0 : dp;
    /* A value that rounds to zero at this precision must never display as
       "-0" — found on production.html's Plant Operations table, where a
       period sum of a consumption field landed on a small negative
       fraction (data entry or floating-point summation residue) that
       toLocaleString then rounds to "-0" at 0dp. That reads as a sign
       error or a typo on an operations report, whatever produced it, so
       snap anything within half a rounding unit of zero to a true +0
       before formatting. Shared by every page through this one function. */
    if (Math.abs(n) < 0.5 / Math.pow(10, d)) n = 0;
    return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  /* Signed, for a variance: +12 / −3.5 (true minus sign, not a hyphen — it
     aligns with the digits in a tabular-nums column, a hyphen does not). */
  function fmtSigned(v, dp) {
    var s = fmt(Math.abs(v), dp);
    if (s === null) return null;
    return (v < 0 ? '−' : '+') + s;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ══ Status ═════════════════════════════════════════════════════════
     Deliberately the SAME banding forms/kpi-live.js already applies on the
     entry side (±15% either way of target). Two different bandings for one
     KPI would mean the entry form and the review page could disagree about
     whether the day was good, which is worse than either banding being
     imperfect. ══════════════════════════════════════════════════════════ */
  function statusFor(value, target, signage) {
    if (value === null || target === null || target === undefined || !signage) return 'none';
    var t = +target, v = +value;
    if (!isFinite(t) || !isFinite(v) || t === 0) return 'none';
    var higherIsBetter = (signage === '>=' || signage === '>');
    if (higherIsBetter) return v >= t ? 'good' : v >= t * 0.85 ? 'warn' : 'bad';
    return v <= t ? 'good' : v <= t * 1.15 ? 'warn' : 'bad';
  }

  var STATUS_LABEL = {
    good: 'On Track',
    warn: 'Attention',
    bad:  'Critical',
    none: 'No Target',
  };

  /* ══ Provenance ═════════════════════════════════════════════════════
     Where the number came from. Derived from the registry's FACTS where
     possible — a formula whose every input is a manual fact is showing you
     hand-entered data, however much arithmetic happened on the way. ════ */
  var PROV_LABEL = { manual: 'Manual', system: 'System', formula: 'Formula', imported: 'Imported' };

  function provenanceOf(key) {
    var f = _registry()[key];
    if (!f) return null;
    var facts = _facts();
    var sources = (f.inputs || []).map(function (i) { return facts[i] && facts[i].source; }).filter(Boolean);
    if (!sources.length) return 'formula';
    /* One input, read straight through — that is the fact's own source.
       More than one, or any arithmetic, and the number is a formula. */
    var allManual = sources.every(function (s) { return s === 'manual'; });
    if (f.inputs.length === 1) return sources[0];
    return allManual ? 'formula' : 'system';
  }

  /* Which forms feed this KPI — real, checkable provenance for the drill-down. */
  function inputForms(key) {
    var f = _registry()[key];
    if (!f) return [];
    var facts = _facts(), seen = {};
    (f.inputs || []).forEach(function (i) { if (facts[i] && facts[i].form) seen[facts[i].form] = true; });
    return Object.keys(seen);
  }

  /* ══ Spec ═══════════════════════════════════════════════════════════
     A KPI card spec. `fromRegistry` fills the metadata half; the caller
     supplies only what it actually measured.

       key        registry key, e.g. 'burst-bag-rate'
       value      number | null  ← the caller's ONE job
       period     'On Date' | 'MTD' | 'YTD' | free text
       name       override the registry label (rarely wanted)
       target     override — only for a target that is genuinely per-page
                  (a monthly plan figure entered on the form, say), and it
                  must come with `targetNote` saying where it came from
       href       drill-down replacement: go somewhere instead
       detail     extra rows for the drill-down: [{k, v}]
     ══════════════════════════════════════════════════════════════════ */
  function fromRegistry(key, value, extra) {
    var f = _registry()[key] || null;
    var spec = Object.assign({
      key: key,
      value: value === undefined ? null : value,
      name: f ? f.label : key,
      unit: f ? f.unit : '',
      dp: f ? f.dp : 0,
      target: f ? f.target : null,
      signage: f ? f.signage : null,
      targetLabel: f ? f.targetLabel : null,
      notes: f ? f.notes : null,
      version: f ? f.version : null,
      inputs: f ? (f.inputs || []) : [],
      provisional: f ? !!f.provisional : false,
      provisionalNote: f ? (f.provisionalNote || null) : null,
      provenance: provenanceOf(key),
      inRegistry: !!f,
    }, extra || {});
    return spec;
  }

  /* A KPI that genuinely is not a registry formula — a stock figure read
     straight off a form, say. Explicit, so it reads as a deliberate choice
     in the calling page rather than an accidental omission. */
  function adHoc(spec) {
    return Object.assign({ inRegistry: false, provenance: 'manual', inputs: [] }, spec);
  }

  /* ══ KPI CARD ═══════════════════════════════════════════════════════ */
  function _icon(name, cls) {
    return '<i data-lucide="' + name + '"' + (cls ? ' class="' + cls + '"' : '') + '></i>';
  }

  function kpiCardHTML(spec, index) {
    var v      = spec.value === undefined ? null : spec.value;
    var hasVal = v !== null;
    var target = (spec.target === undefined) ? null : spec.target;
    var status = statusFor(v, target, spec.signage);
    var drillable = spec.drill !== false;

    var tag   = drillable ? 'button' : 'div';
    var attrs = drillable
      ? ' type="button" data-kpi-idx="' + index + '"'
        + ' aria-label="' + esc(spec.name) + (hasVal ? ', ' + esc(fmt(v, spec.dp)) + ' ' + esc(spec.unit || '') : ', no data')
        + '. Show how this is calculated."'
      : '';

    var h = '<' + tag + ' class="n-kpi is-' + status + '"' + attrs + '>';

    /* Top line — provenance and the metric name. */
    h += '<div class="n-kpi-top">';
    h += '<span class="n-kpi-name">' + esc(spec.name) + '</span>';
    if (spec.provenance) {
      h += '<span class="n-prov is-' + esc(spec.provenance) + '" title="Data source: '
         + esc(PROV_LABEL[spec.provenance] || spec.provenance) + '">'
         + '<span class="n-prov-sw"></span>' + esc(PROV_LABEL[spec.provenance] || spec.provenance) + '</span>';
    }
    h += '</div>';

    /* Value. "No data" is a sentence, not a big dash. */
    h += '<div class="n-kpi-valrow">';
    if (hasVal) {
      h += '<span class="n-kpi-val">' + esc(fmt(v, spec.dp)) + '</span>';
      if (spec.unit) h += '<span class="n-kpi-unit">' + esc(spec.unit) + '</span>';
    } else {
      h += '<span class="n-kpi-val is-empty">No data</span>';
    }
    h += '</div>';

    /* Why there is no number, when the caller knows. A card that reads only
       "No data" is indistinguishable from a broken page: the Production
       Report had three such cards for months, two of them waiting on a form
       nobody was submitting and one on a field Odoo did not expose, and
       nothing on screen said so. Only shown when the value is genuinely
       absent — a real number never carries an excuse. */
    if (!hasVal && spec.emptyReason) {
      h += '<div class="n-kpi-why">' + esc(spec.emptyReason) + '</div>';
    }

    /* Period — never leave a reader guessing which number this is. */
    if (spec.period) h += '<div class="n-kpi-unit">' + esc(spec.period) + '</div>';

    /* Provisional KPIs carry the registry's own warning at the point of
       reading, not only in the generated reference doc. */
    if (spec.provisional) {
      h += '<span class="n-kpi-flag">' + _icon('alert-triangle') + 'Provisional — read the method</span>';
    }

    /* Foot — target and variance. */
    h += '<div class="n-kpi-foot">';
    if (target !== null && target !== undefined) {
      h += '<span class="n-kpi-tgt">' + esc(spec.targetLabel || ('Target ' + fmt(target, spec.dp))) + '</span>';
      if (hasVal) {
        var variance = v - target;
        h += '<span class="n-kpi-var">' + esc(fmtSigned(variance, spec.dp)) + ' ' + esc(spec.unit || '') + '</span>';
      } else {
        h += '<span class="n-kpi-var">—</span>';
      }
    } else if (spec.targetNote) {
      h += '<span class="n-kpi-tgt">' + esc(spec.targetNote) + '</span>';
    } else {
      h += '<span class="n-kpi-tgt">No target defined</span>';
    }
    h += '</div>';

    /* Progress, only where a target genuinely exists to progress toward. */
    if (target !== null && target !== undefined && hasVal && +target > 0) {
      var pct = Math.max(0, Math.min(v / target * 100, 100));
      h += '<div class="n-kpi-bar" role="presentation"><div class="n-kpi-bar-fill" style="width:' + pct.toFixed(1) + '%"></div></div>';
    }

    if (drillable) h += '<span class="n-kpi-more">' + _icon('arrow-right') + '</span>';

    h += '</' + tag + '>';
    return h;
  }

  /* Render a set of KPI cards into a mount element and wire their
     drill-downs. Specs are held on the mount so a re-render replaces them
     cleanly rather than stacking listeners. */
  function renderKpis(mount, specs) {
    if (!mount) return;
    mount.innerHTML = specs.map(function (s, i) { return kpiCardHTML(s, i); }).join('');
    mount._nSpecs = specs;
    if (!mount._nWired) {
      mount.addEventListener('click', function (e) {
        var card = e.target.closest ? e.target.closest('[data-kpi-idx]') : null;
        if (!card || !mount.contains(card)) return;
        var spec = (mount._nSpecs || [])[+card.getAttribute('data-kpi-idx')];
        if (spec) openDrill(spec, card);
      });
      mount._nWired = true;
    }
    if (global.lucide && global.lucide.createIcons) global.lucide.createIcons();
  }

  /* Skeletons, so a slow connection shows the page's SHAPE rather than a
     blank rectangle that might be an error. */
  function renderKpiSkeletons(mount, count) {
    if (!mount) return;
    var one = '<div class="n-kpi is-none">'
            + '<div class="n-kpi-top"><span class="n-skel n-skel-line" style="width:55%"></span></div>'
            + '<div class="n-skel n-skel-val"></div>'
            + '<div class="n-kpi-foot"><span class="n-skel n-skel-line" style="width:70%"></span></div>'
            + '</div>';
    mount.innerHTML = new Array(count || 4).fill(one).join('');
  }

  /* ══ DRILL-DOWN ═════════════════════════════════════════════════════ */
  var _openEl = null, _lastFocus = null;

  function _drillRow(k, v) {
    return '<div class="n-drill-row"><span class="n-drill-k">' + esc(k) + '</span>'
         + '<span class="n-drill-v">' + esc(v) + '</span></div>';
  }

  function drillHTML(spec) {
    var v      = spec.value;
    var hasVal = v !== null && v !== undefined;
    var target = (spec.target === undefined) ? null : spec.target;
    var status = statusFor(v, target, spec.signage);

    var h = '<div class="n-drill" role="dialog" aria-modal="true" aria-label="' + esc(spec.name) + ' — how this is calculated">';

    h += '<div class="n-drill-hdr">'
       + '<div><div class="n-drill-title">' + esc(spec.name) + '</div>'
       + (spec.period ? '<div class="n-card-sub">' + esc(spec.period) + '</div>' : '')
       + '</div>'
       + '<button type="button" class="n-drill-close" data-n-drill-close aria-label="Close">' + _icon('x') + '</button>'
       + '</div>';

    h += '<div class="n-drill-body">';

    h += '<div class="n-drill-hero">';
    h += hasVal
      ? '<span class="n-drill-hero-val">' + esc(fmt(v, spec.dp)) + '</span>'
        + (spec.unit ? '<span class="n-drill-hero-unit">' + esc(spec.unit) + '</span>' : '')
      : '<span class="n-kpi-val is-empty">No data for this period</span>';
    h += '</div>';

    /* ── Performance against target ── */
    h += '<div class="n-drill-rows">';
    if (target !== null && target !== undefined) {
      h += _drillRow('Target', (spec.targetLabel || (fmt(target, spec.dp) + ' ' + (spec.unit || ''))));
      if (hasVal) {
        h += _drillRow('Variance', fmtSigned(v - target, spec.dp) + ' ' + (spec.unit || ''));
        if (+target > 0) h += _drillRow('Achievement', fmt(v / target * 100, 1) + '%');
      }
      h += _drillRow('Status', STATUS_LABEL[status]);
      if (spec.targetNote) h += _drillRow('Target source', spec.targetNote);
    } else {
      h += _drillRow('Target', spec.targetNote || 'None defined in the KPI registry');
    }
    if (spec.provenance) h += _drillRow('Data source', PROV_LABEL[spec.provenance] || spec.provenance);
    (spec.detail || []).forEach(function (d) { h += _drillRow(d.k, d.v); });
    h += '</div>';

    /* ── Method: the registry's own words ── */
    if (spec.notes) {
      h += '<div class="n-drill-sec-title">How this is calculated</div>';
      h += '<div class="n-drill-notes' + (spec.provisional ? ' is-provisional' : '') + '">' + esc(spec.notes) + '</div>';
    }
    if (spec.provisional && spec.provisionalNote) {
      h += '<div class="n-drill-sec-title">Why it is provisional</div>';
      h += '<div class="n-drill-notes is-provisional">' + esc(spec.provisionalNote) + '</div>';
    }
    if (!spec.inRegistry) {
      h += '<div class="n-drill-sec-title">How this is calculated</div>';
      h += '<div class="n-drill-notes">This figure is read directly from the report for this period. '
         + 'It is not a KPI-registry formula, so it has no stored history, no target and no audit trail '
         + 'of its own — it is only as current as the report it came from.</div>';
    }

    /* ── Inputs, and which form each is entered on ── */
    if (spec.inputs && spec.inputs.length) {
      h += '<div class="n-drill-sec-title">Built from ' + spec.inputs.length + ' input'
         + (spec.inputs.length === 1 ? '' : 's') + '</div>';
      h += '<div class="n-drill-inputs">'
         + spec.inputs.map(function (i) { return '<span class="n-drill-input">' + esc(i) + '</span>'; }).join('')
         + '</div>';
      var forms = inputForms(spec.key);
      if (forms.length) {
        h += '<div class="n-drill-rows" style="margin-top:var(--sp-3)">'
           + _drillRow(forms.length === 1 ? 'Entered on' : 'Entered on', forms.join(', ')) + '</div>';
      }
    }

    h += '</div>'; /* body */

    h += '<div class="n-drill-foot">';
    if (spec.version) {
      h += '<span class="n-chip is-neutral">Formula v' + esc(spec.version) + '</span>';
    }
    if (spec.key && spec.inRegistry) {
      h += '<span class="n-prov is-formula"><span class="n-prov-sw"></span>' + esc(spec.key) + '</span>';
    }
    if (spec.href) {
      h += '<span style="flex:1"></span><a class="n-btn" href="' + esc(spec.href) + '">'
         + _icon('arrow-right') + esc(spec.hrefLabel || 'Open source report') + '</a>';
    }
    h += '</div>';

    h += '</div>';
    return h;
  }

  function openDrill(spec, returnFocusTo) {
    closeDrill();
    _lastFocus = returnFocusTo || document.activeElement;
    var back = document.createElement('div');
    back.className = 'n-drill-back';
    back.innerHTML = drillHTML(spec);
    document.body.appendChild(back);
    document.body.style.overflow = 'hidden';
    _openEl = back;

    back.addEventListener('click', function (e) {
      if (e.target === back || (e.target.closest && e.target.closest('[data-n-drill-close]'))) closeDrill();
    });
    document.addEventListener('keydown', _onKey);

    if (global.lucide && global.lucide.createIcons) global.lucide.createIcons();
    var closeBtn = back.querySelector('[data-n-drill-close]');
    if (closeBtn) closeBtn.focus();
  }

  function _onKey(e) {
    if (e.key === 'Escape') { closeDrill(); return; }
    /* Keep Tab inside the dialog — a modal you can tab out of behind is a
       modal a screen-reader user is lost in. */
    if (e.key !== 'Tab' || !_openEl) return;
    var f = _openEl.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function closeDrill() {
    if (!_openEl) return;
    _openEl.remove();
    _openEl = null;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', _onKey);
    if (_lastFocus && _lastFocus.focus) _lastFocus.focus();
    _lastFocus = null;
  }

  /* ══ SEGMENTED CONTROL ══════════════════════════════════════════════ */
  function wireSegmented(root, onChange) {
    if (!root) return;
    root.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.n-seg-btn') : null;
      if (!btn || !root.contains(btn)) return;
      root.querySelectorAll('.n-seg-btn').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b === btn));
      });
      onChange(btn.getAttribute('data-value'), btn);
    });
  }

  /* ══ STATES ═════════════════════════════════════════════════════════
     Reuses `.ds-state` from design-system.css — four pages already depend
     on it and must keep working. `kind` distinguishes the four cases the
     brief asks for, and "no data" is deliberately NOT an error: a day
     nobody has filed yet is a normal state of an operations system. ═══ */
  var STATE_ICON = { empty: 'clipboard-list', nodata: 'calendar', loading: 'refresh-cw', error: 'alert-octagon', denied: 'lock' };

  function stateHTML(opts) {
    var kind = opts.kind || 'empty';
    var cls  = 'ds-state' + (kind === 'error' ? ' is-error' : '') + (opts.compact ? ' is-compact' : '');
    var h = '<div class="' + cls + '">';
    h += '<div class="ds-state-icon">' + _icon(STATE_ICON[kind] || 'info') + '</div>';
    if (opts.title) h += '<div class="ds-state-title">' + esc(opts.title) + '</div>';
    if (opts.body)  h += '<div class="ds-state-body">' + esc(opts.body) + '</div>';
    if (opts.action && opts.actionHref) {
      h += '<a class="ds-state-act" href="' + esc(opts.actionHref) + '">' + esc(opts.action) + '</a>';
    } else if (opts.action) {
      h += '<button type="button" class="ds-state-act" data-n-state-act>' + esc(opts.action) + '</button>';
    }
    h += '</div>';
    return h;
  }

  function renderState(mount, opts) {
    if (!mount) return;
    mount.innerHTML = stateHTML(opts);
    if (opts.onAction) {
      var btn = mount.querySelector('[data-n-state-act]');
      if (btn) btn.addEventListener('click', opts.onAction);
    }
    if (global.lucide && global.lucide.createIcons) global.lucide.createIcons();
  }

  /* ══ WORKFLOW STATUS ════════════════════════════════════════════════
     The four real values of daily_reports.status, plus the two states the
     read side has that the write side does not: nothing filed at all, and
     a period that is an aggregate of many reports rather than one. ════ */
  var WORKFLOW = {
    draft:            { label: 'Draft',           cls: 'is-neutral', note: 'Entered but not yet submitted — these figures can still change.' },
    pending_approval: { label: 'Pending Review',  cls: 'is-warn',    note: 'Submitted and waiting for the HOD to sign off. Not yet approved.' },
    approved:         { label: 'Approved',        cls: 'is-good',    note: 'Signed off by the approving HOD.' },
    rejected:         { label: 'Returned',        cls: 'is-bad',     note: 'Returned to the department for correction.' },
    missing:          { label: 'Not Submitted',   cls: 'is-neutral', note: 'No report has been filed for this date.' },
    mixed:            { label: 'Multiple Reports', cls: 'is-info',   note: 'This period aggregates several daily reports at different stages.' },
  };

  function workflowChipHTML(status) {
    var w = WORKFLOW[status] || WORKFLOW.missing;
    return '<span class="n-chip ' + w.cls + '" title="' + esc(w.note) + '">'
         + '<span class="n-chip-dot"></span>' + esc(w.label) + '</span>';
  }

  /* ══ TABLE HELPERS ══════════════════════════════════════════════════ */
  /* A cell that knows the difference between 0 and nothing. */
  function cell(v, dp) {
    if (v === null || v === undefined || v === '') return '<span class="n-nodata">—</span>';
    var s = fmt(v, dp);
    return s === null ? '<span class="n-nodata">—</span>' : esc(s);
  }

  global.NyatiUI = {
    /* numbers */
    num: num, fmt: fmt, fmtSigned: fmtSigned, esc: esc, cell: cell,
    /* kpi */
    fromRegistry: fromRegistry, adHoc: adHoc, statusFor: statusFor,
    kpiCardHTML: kpiCardHTML, renderKpis: renderKpis, renderKpiSkeletons: renderKpiSkeletons,
    provenanceOf: provenanceOf, inputForms: inputForms,
    /* drill */
    openDrill: openDrill, closeDrill: closeDrill,
    /* chrome */
    wireSegmented: wireSegmented, renderState: renderState, stateHTML: stateHTML,
    workflowChipHTML: workflowChipHTML, WORKFLOW: WORKFLOW,
    STATUS_LABEL: STATUS_LABEL,
  };

}(window));
