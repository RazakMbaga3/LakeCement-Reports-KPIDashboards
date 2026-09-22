/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — Stoppage Reason Catalogue renderer
   ─────────────────────────────────────────────────────────────────
   Renders forms/stoppage-form.html's seven section tabs from the
   governed reason catalogue (backend/routes/stoppage.js) instead of
   the free-text event rows the form used to carry.

   WHY: the old Cause/Remarks boxes were empty text fields, so the same
   fault arrived spelled a dozen different ways ("BE1 trip", "631BE1
   tripped", "elevator tripped") and nothing downstream could count it.
   The plant's own monthly Stoppage report workbook never had that
   problem — every sheet is a fixed, pre-printed list of named faults
   grouped by cause, and the shift only writes hours against the line
   that happened. This file reproduces that sheet.

   Those old text boxes also carried no data-field at all, which means
   they were never sent to the server — they survived only as a
   positional array in localStorage. Nothing is lost by replacing them.

   PERSISTENCE: every hours box carries data-field="stopr_<reasonId>",
   so it saves and submits down the same daily_reports path as every
   other field on every other form. No new write endpoint.

   THE SUMMARY TAB IS NOW DERIVED. stop_<equipment>_<cause> stays the
   field the KPI strip and services/insights.js read, and stays in
   MINUTES (insights.js converts mins/60 — see its STOP_RE block), but
   nobody types it any more: it is the sum of that group's hours × 60.
   That removes the entry/report conflation the plant head complained
   about, where the same downtime was keyed twice and could disagree.
   ══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const CACHE_KEY = 'nyati-stoppage-reasons';

  /* Panel id suffix in the HTML → equipment key in the catalogue. The two
     differ because the tabs were named for the reader ('rawmill') and the
     data for services/insights.js's STOP_EQUIPMENT ('rm'). */
  const PANEL_EQUIP = {
    crusher: 'crusher', rawmill: 'rm', coalmill: 'cm_coal', kiln: 'kiln',
    cm1: 'cm1', cm2: 'cm2', packing: 'packing',
  };

  /* Cause order and headings. The workbook files planned+power together
     under one "Common" heading; they are split here because they are two
     different columns on the summary matrix and two different causes to
     services/insights.js. */
  const CAUSE_ORDER = ['mech', 'ei', 'prod', 'planned', 'power', 'other'];
  const CAUSE_LABEL = {
    mech: 'Mechanical', ei: 'Electrical & Instrumentation', prod: 'Production',
    planned: 'Planned Maintenance', power: 'Power Restriction', other: 'Others',
  };

  let _reasons = [];

  const esc = s => (typeof global.escHtml === 'function')
    ? global.escHtml(s)
    : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

  const num = v => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };

  /* ── Load: server is the source of truth, localStorage is the offline
     fallback. Cached rather than bundled as a static file so a reason one
     shift adds is visible to the next shift without a redeploy. ─────── */
  async function _load() {
    try {
      const { reasons } = await global.NyatiAPI.getStoppageReasons();
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(reasons)); } catch (_) { /* quota/private mode */ }
      return { reasons, stale: false };
    } catch (err) {
      try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (Array.isArray(cached) && cached.length) return { reasons: cached, stale: true };
      } catch (_) { /* unparseable cache */ }
      throw err;
    }
  }

  /* ── One cause group: heading, its reason rows, a running subtotal and
     the control that extends it. ──────────────────────────────────── */
  function _groupHtml(equip, cause, rows) {
    const body = rows.map(r => `
      <tr>
        <td class="tp rsn-lbl">${esc(r.label)}${r.custom ? ' <span class="rsn-new" title="Added by the plant, not in the original workbook">added</span>' : ''}</td>
        <td class="cm"><input class="ci rsn-hrs" type="number" step="0.01" min="0" max="24"
             data-field="stopr_${r.id}" data-rsn-equip="${equip}" data-rsn-cause="${cause}"
             data-optional aria-label="${esc(r.label)} — hours" /></td>
      </tr>`).join('');

    return `
      <div class="rsn-grp" data-rsn-group="${equip}:${cause}">
        <button type="button" class="rsn-grp-hdr" aria-expanded="true">
          <i data-lucide="chevron-down" class="rsn-chev"></i>
          <span class="rsn-grp-name">${CAUSE_LABEL[cause]}</span>
          <span class="rsn-grp-count">${rows.length}</span>
          <span class="rsn-grp-total" data-rsn-subtotal="${equip}:${cause}">0.00 h</span>
        </button>
        <div class="rsn-grp-body">
          <table class="rt rsn-tbl">
            <thead><tr>
              <th class="tl grp-hdr">Reason</th>
              <th class="grp-hdr rsn-hcol">Hours</th>
            </tr></thead>
            <tbody>${body}</tbody>
          </table>
          <!-- NB: these buttons must NOT carry .btn-sub / .btn-save.
               form-persist.js binds Submit Report / Save Draft to every
               element with those classes on the page, so an "Add" button
               wearing .btn-sub silently submits the whole day's report
               (and preventDefault()s this form) instead of adding a reason.
               (Load Previous is bound by data-persist="history", not by
               .btn-out, which is only a style.) -->
          <div class="rsn-add-wrap">
            <button type="button" class="rsn-add" data-rsn-add="${equip}:${cause}"
                    aria-label="Add a ${CAUSE_LABEL[cause]} reason">
              <i data-lucide="plus-circle" class="btn-icon"></i> Add a reason
            </button>
            <form class="rsn-add-form" hidden>
              <input type="text" class="rsn-add-in" data-nopersist maxlength="300" required minlength="3"
                     placeholder="Name the fault as the plant would say it…" />
              <button type="submit" class="rsn-btn rsn-btn-go rsn-add-save">Add</button>
              <button type="button" class="rsn-btn rsn-add-cancel">Cancel</button>
            </form>
            <div class="rsn-add-msg" role="status"></div>
          </div>
        </div>
      </div>`;
  }

  /* ── Render every section panel that has a mount point ───────────── */
  function _render() {
    Object.entries(PANEL_EQUIP).forEach(([panel, equip]) => {
      const mount = document.querySelector(`[data-reasons-for="${panel}"]`);
      if (!mount) return;

      const mine = _reasons.filter(r => r.equipment === equip);
      const html = CAUSE_ORDER
        .map(cause => {
          const rows = mine.filter(r => r.cause === cause)
            .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
          return rows.length ? _groupHtml(equip, cause, rows) : '';
        })
        .join('');

      mount.innerHTML = html + `
        <div class="rsn-foot">
          <span class="rsn-foot-lbl">Section total</span>
          <span class="rsn-foot-val" data-rsn-sectotal="${equip}">0.00 h</span>
        </div>`;
    });
    if (global.lucide && typeof global.lucide.createIcons === 'function') global.lucide.createIcons();
  }

  /* ── Totals + the derived summary matrix ─────────────────────────────
     Runs in the CAPTURE phase (see _wire) so the stop_* inputs already
     hold this keystroke's value by the time kpi-live.js's own bubble-phase
     listener reads them — otherwise the KPI strip would always render one
     edit behind. ──────────────────────────────────────────────────── */
  function _recompute() {
    const perGroup = {};
    document.querySelectorAll('.rsn-hrs').forEach(inp => {
      const k = inp.dataset.rsnEquip + ':' + inp.dataset.rsnCause;
      perGroup[k] = (perGroup[k] || 0) + num(inp.value);
    });

    document.querySelectorAll('[data-rsn-subtotal]').forEach(el => {
      const v = perGroup[el.dataset.rsnSubtotal] || 0;
      el.textContent = v.toFixed(2) + ' h';
      el.classList.toggle('has', v > 0);
    });

    const perEquip = {};
    Object.entries(perGroup).forEach(([k, v]) => {
      const equip = k.split(':')[0];
      perEquip[equip] = (perEquip[equip] || 0) + v;
    });
    document.querySelectorAll('[data-rsn-sectotal]').forEach(el => {
      el.textContent = (perEquip[el.dataset.rsnSectotal] || 0).toFixed(2) + ' h';
    });

    /* Summary matrix, in MINUTES — the unit stop_<equip>_<cause> has
       always been stored in and that services/insights.js divides by 60.
       Written even when zero: a blank would read as "not filled in". */
    const equips = Object.values(PANEL_EQUIP);
    const mins = (equip, cause) => Math.round((perGroup[equip + ':' + cause] || 0) * 60);

    let grand = 0;
    equips.forEach(equip => {
      let row = 0;
      CAUSE_ORDER.forEach(cause => {
        const m = mins(equip, cause);
        row += m;
        const cell = document.querySelector(`[data-field="stop_${equip}_${cause}"]`);
        if (cell) cell.value = String(m);
      });
      grand += row;
      const rowEl = document.querySelector(`[data-rsn-rowtotal="${equip}"]`);
      if (rowEl) rowEl.textContent = row.toLocaleString();
    });

    CAUSE_ORDER.forEach(cause => {
      const el = document.querySelector(`[data-rsn-coltotal="${cause}"]`);
      if (el) el.textContent = equips.reduce((a, e) => a + mins(e, cause), 0).toLocaleString();
    });
    const g = document.querySelector('[data-rsn-grandtotal]');
    if (g) g.textContent = grand.toLocaleString();
  }

  /* ── Add a reason. Server-first and never local-only: a reason that
     existed on one shift's laptop and nowhere else would rebuild exactly
     the divergent vocabulary this whole feature exists to end. ──────── */
  async function _submitNew(wrap, equip, cause, label) {
    const msg  = wrap.querySelector('.rsn-add-msg');
    const form = wrap.querySelector('.rsn-add-form');
    const save = wrap.querySelector('.rsn-add-save');

    save.disabled = true;
    msg.className = 'rsn-add-msg';
    msg.textContent = 'Adding…';

    try {
      const out = await global.NyatiAPI.addStoppageReason(equip, cause, label);
      if (!out.created) {
        msg.className = 'rsn-add-msg warn';
        msg.textContent = out.revived
          ? `"${out.reason.label}" was retired — it is back on the list.`
          : `"${out.reason.label}" is already on the list.`;
      } else {
        msg.className = 'rsn-add-msg ok';
        msg.textContent = `Added "${out.reason.label}".`;
      }

      if (!_reasons.some(r => r.id === out.reason.id)) _reasons.push(out.reason);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(_reasons)); } catch (_) { /* quota */ }

      /* Re-render loses the typed hours, so carry them across by field
         name — the ids are stable, the DOM nodes are not. */
      const keep = {};
      document.querySelectorAll('.rsn-hrs').forEach(i => { if (i.value) keep[i.dataset.field] = i.value; });
      _render();
      Object.entries(keep).forEach(([f, v]) => {
        const el = document.querySelector(`.rsn-hrs[data-field="${f}"]`);
        if (el) el.value = v;
      });
      _recompute();
      document.dispatchEvent(new CustomEvent('nyati:restored'));

      const fresh = document.querySelector(`[data-rsn-add="${equip}:${cause}"]`);
      if (fresh) {
        const w = fresh.closest('.rsn-add-wrap');
        w.querySelector('.rsn-add-msg').className = msg.className;
        w.querySelector('.rsn-add-msg').textContent = msg.textContent;
      }
      const row = document.querySelector(`.rsn-hrs[data-field="stopr_${out.reason.id}"]`);
      if (row) row.focus();
    } catch (err) {
      msg.className = 'rsn-add-msg err';
      msg.textContent = err && err.status === 403
        ? 'Your role may not add stoppage reasons — ask the P&M head.'
        : 'Could not reach the server. A new reason has to be saved centrally, so it is shared — try again when you are back online.';
      save.disabled = false;
      form.hidden = false;
    }
  }

  function _wire() {
    // Capture phase — must beat kpi-live.js's bubble listener. See _recompute.
    document.addEventListener('input', e => {
      if (e.target.classList && e.target.classList.contains('rsn-hrs')) _recompute();
    }, true);
    document.addEventListener('nyati:restored', _recompute);

    document.addEventListener('click', e => {
      const hdr = e.target.closest && e.target.closest('.rsn-grp-hdr');
      if (hdr) {
        const open = hdr.getAttribute('aria-expanded') === 'true';
        hdr.setAttribute('aria-expanded', String(!open));
        return;
      }

      const add = e.target.closest && e.target.closest('.rsn-add');
      if (add) {
        const wrap = add.closest('.rsn-add-wrap');
        wrap.querySelector('.rsn-add-form').hidden = false;
        wrap.querySelector('.rsn-add-msg').textContent = '';
        wrap.querySelector('.rsn-add-in').focus();
        add.hidden = true;
        return;
      }

      const cancel = e.target.closest && e.target.closest('.rsn-add-cancel');
      if (cancel) {
        const wrap = cancel.closest('.rsn-add-wrap');
        wrap.querySelector('.rsn-add-form').hidden = true;
        wrap.querySelector('.rsn-add-in').value = '';
        wrap.querySelector('.rsn-add-msg').textContent = '';
        wrap.querySelector('.rsn-add').hidden = false;
      }
    });

    document.addEventListener('submit', e => {
      const form = e.target.closest && e.target.closest('.rsn-add-form');
      if (!form) return;
      e.preventDefault();
      const wrap  = form.closest('.rsn-add-wrap');
      const label = wrap.querySelector('.rsn-add-in').value.trim();
      if (label.length < 3) return;
      const [equip, cause] = wrap.querySelector('.rsn-add').dataset.rsnAdd.split(':');
      _submitNew(wrap, equip, cause, label);
    });
  }

  /* ── Entry point. Resolves once the rows are in the DOM, so the caller
     can start form-persist afterwards and have its restore find them. ── */
  global.initStoppageReasons = async function initStoppageReasons() {
    try {
      const { reasons, stale } = await _load();
      _reasons = reasons;
      _render();
      _wire();
      _recompute();
      if (stale) {
        document.querySelectorAll('[data-reasons-for]').forEach(m => {
          const n = document.createElement('div');
          n.className = 'rsn-offline';
          n.textContent = 'Offline — showing the reason list saved on this device. Any reason added elsewhere since is missing.';
          m.prepend(n);
        });
      }
      return true;
    } catch (err) {
      document.querySelectorAll('[data-reasons-for]').forEach(m => {
        m.innerHTML = '<div class="rsn-offline err">The stoppage reason list could not be loaded, '
          + 'so there is nothing to record hours against. Reload the page; if it keeps failing, contact IT.</div>';
      });
      return false;
    }
  };

}(window));
