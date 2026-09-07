/* ══════════════════════════════════════════════════════════════════════
   Lake Cement Ltd — MOBILE ENTRY  |  forms/mobile-entry.js
   ──────────────────────────────────────────────────────────────────────
   Turns the daily entry grids into per-parameter cards on a phone, and
   puts them back on a desktop.

   Why
   ───
   The shift forms are 800–3,100px wide. That is CORRECT on a control-room
   screen: an officer reads across a row and down a column, and the grid
   is what makes the comparison possible. On a 390px handset the same grid
   is a keyhole — you cannot see the parameter you are typing a value for
   while you type it, because the label column has scrolled away.

   So on mobile each ROW becomes a card: the parameter is the title, each
   entry cell becomes a labelled field, and the computed cells become a
   read-back strip underneath. Nothing is hidden; it is re-laid-out.

   The one rule this file obeys above all others
   ─────────────────────────────────────────────
   It MOVES the existing <input> and .cv nodes. It never clones them.

   form-persist.js, report-rollup.js and formula-registry.js all bind by
   attribute — querySelectorAll('[data-field]'), [data-kpi], .ci — and
   never by row or cell position, so a relocated input saves, restores,
   rolls up and recomputes exactly as it did in the table. A clone would
   silently produce two elements with the same data-field, and the officer
   would fill one while the form saved the other. Every node's original
   parent is recorded so the move is exactly reversible.

   (The single positional exception in the codebase, checkCao() in
   pile-quality-form.html, was hardened to tolerate the move.)
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {

  const MOBILE_Q = '(max-width: 959px)';
  const isMobile = () => window.matchMedia(MOBILE_Q).matches;

  const CTRL = 'input:not([type=hidden]):not([type=button]):not([type=submit]), select, textarea';

  /* Remembers where every moved node came from, so restore is exact. */
  const homes = new WeakMap();

  let uid = 0;

  /* ══════════════════════════════════════════════════════════════════
     HEADER MATRIX
     A 3-level <thead> with rowspan and colspan cannot be read by index —
     dispatch-form.html's is "Regular Bags" / "42.5 R" / "On Date" across
     three rows, where the leaf label alone ("On Date") appears thirteen
     times and means something different each time. This walks the header
     the way a browser does and returns, for each column, the full stack
     of headings that cover it.
     ══════════════════════════════════════════════════════════════════ */
  function headerMatrix(table) {
    const thead = table.tHead;
    if (!thead) return [];

    const grid = [];   /* grid[row][col] = <th> */
    [...thead.rows].forEach((tr, r) => {
      let c = 0;
      [...tr.cells].forEach(th => {
        while (grid[r] && grid[r][c]) c++;
        const rs = th.rowSpan || 1;
        const cs = th.colSpan || 1;
        for (let dr = 0; dr < rs; dr++) {
          const rr = r + dr;
          grid[rr] = grid[rr] || [];
          for (let dc = 0; dc < cs; dc++) grid[rr][c + dc] = th;
        }
        c += cs;
      });
    });

    const width = grid.reduce((m, row) => Math.max(m, row ? row.length : 0), 0);
    const cols = [];
    for (let c = 0; c < width; c++) {
      const parts = [];
      for (let r = 0; r < grid.length; r++) {
        const th = grid[r] && grid[r][c];
        if (!th) continue;
        /* A <th> spanning several rows must not repeat down the stack. */
        if (parts.length && parts[parts.length - 1].el === th) continue;
        const txt = cellLabel(th);
        if (txt) parts.push({ el: th, txt });
      }
      cols.push(parts.map(p => p.txt));
    }
    return cols;
  }

  /* Header text without the sub-labels the grid uses for spec ranges and
     units — those are shown separately on the card so they do not bloat
     every field label. */
  function cellLabel(th) {
    const clone = th.cloneNode(true);
    clone.querySelectorAll('.spec-range, small, .unit').forEach(n => n.remove());
    return squash(clone.textContent);
  }

  const squash = s => String(s || '').replace(/\s+/g, ' ').trim();

  /* ══════════════════════════════════════════════════════════════════
     ROW → CARD
     ══════════════════════════════════════════════════════════════════ */

  /* A row that is a section heading rather than data: one cell, or a
     single cell spanning the whole grid. */
  function isSectionRow(tr, width) {
    const cells = [...tr.cells];
    if (!cells.length) return false;
    if (cells.length === 1) return true;
    return cells.length < width && cells.every(td => !td.querySelector(CTRL)) &&
           cells.some(td => (td.colSpan || 1) >= width - 1);
  }

  /* The spec/target hint the grid prints under an input, e.g. "95–98". */
  function specOf(td) {
    const el = td.querySelector('.spec-range');
    if (el) return squash(el.textContent);
    /* Several forms print the range in a bare <div> after the input. */
    const div = [...td.children].find(n => n.tagName === 'DIV' && !n.classList.contains('cv'));
    return div ? squash(div.textContent) : '';
  }

  function fieldLabelHTML(colParts) {
    if (!colParts || !colParts.length) return '';
    const leaf  = colParts[colParts.length - 1];
    const group = colParts.slice(0, -1).join(' · ');
    return (group ? `<small>${esc(group)}</small>` : '') + esc(leaf);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function buildCards(table) {
    const cols = headerMatrix(table);
    const width = cols.length;
    const frag = document.createDocumentFragment();

    [...table.tBodies].forEach(tbody => {
      [...tbody.rows].forEach(tr => {
        if (tr.hidden || tr.style.display === 'none') return;

        if (isSectionRow(tr, width)) {
          const h = document.createElement('div');
          h.className = 'me-group';
          h.textContent = squash(tr.textContent);
          if (h.textContent) frag.appendChild(h);
          return;
        }

        const cells = [...tr.cells];
        if (cells.length < 2) return;

        /* Column index has to track colspan so labels stay aligned. */
        let ci = 0;
        const entries = [];
        const derived = [];
        let title = '';

        cells.forEach((td, i) => {
          const span = td.colSpan || 1;
          const colParts = cols[ci] || [];
          ci += span;

          if (i === 0) { title = squash(td.textContent); return; }

          const ctrls = [...td.querySelectorAll(CTRL)];
          if (ctrls.length) {
            entries.push({ td, ctrls, colParts, spec: specOf(td) });
          } else {
            const val = td.querySelector('.cv') || td;
            const txt = squash(td.textContent);
            /* An empty computed cell still earns its slot — it is where
               the recomputed figure will land as the officer types. */
            if (val.classList && val.classList.contains('cv')) {
              derived.push({ td, node: val, colParts });
            } else if (txt && txt !== '—') {
              derived.push({ td, node: null, text: txt, colParts });
            }
          }
        });

        if (!entries.length && !derived.length) return;

        const card = document.createElement('article');
        card.className = 'me-card';
        if (!entries.length) card.classList.add('me-readonly');

        const rowSpec = entries.map(e => e.spec).find(Boolean) || '';
        const head = document.createElement('header');
        head.className = 'me-card-hd';
        head.innerHTML =
          `<h4 class="me-card-title">${esc(title || 'Row')}</h4>` +
          (rowSpec ? `<span class="me-card-spec">${esc(rowSpec)}</span>` : '');
        card.appendChild(head);

        if (entries.length) {
          const grid = document.createElement('div');
          grid.className = 'me-fields';
          grid.style.setProperty('--me-cols', entries.length >= 3 ? 3 : entries.length);

          entries.forEach(e => {
            const wrap = document.createElement('label');
            wrap.className = 'me-field';

            const lbl = document.createElement('span');
            lbl.className = 'me-field-lbl';
            lbl.innerHTML = fieldLabelHTML(e.colParts);
            wrap.appendChild(lbl);

            e.ctrls.forEach(c => {
              homes.set(c, { parent: c.parentNode, next: c.nextSibling });
              wrap.appendChild(c);
            });
            grid.appendChild(wrap);
          });
          card.appendChild(grid);
        }

        if (derived.length) {
          const foot = document.createElement('footer');
          foot.className = 'me-derived';
          derived.forEach(d => {
            const item = document.createElement('div');
            item.className = 'me-d';
            const k = document.createElement('span');
            k.className = 'me-d-k';
            k.textContent = (d.colParts && d.colParts.length)
              ? d.colParts[d.colParts.length - 1] : '';
            item.appendChild(k);
            if (d.node) {
              homes.set(d.node, { parent: d.node.parentNode, next: d.node.nextSibling });
              d.node.classList.add('me-d-v');
              item.appendChild(d.node);
            } else {
              const v = document.createElement('span');
              v.className = 'me-d-v';
              v.textContent = d.text;
              item.appendChild(v);
            }
            foot.appendChild(item);
          });
          card.appendChild(foot);
        }

        frag.appendChild(card);
      });
    });

    return frag;
  }

  /* ══════════════════════════════════════════════════════════════════
     APPLY / RESTORE
     ══════════════════════════════════════════════════════════════════ */

  function tablesToConvert() {
    return [...document.querySelectorAll('table.rt')].filter(t => {
      if (t.dataset.meSkip === '1') return false;
      if (!t.tHead || !t.tBodies.length) return false;
      return [...t.tBodies].some(tb => tb.rows.length > 0);
    });
    /* This deliberately does NOT test whether the grid is too wide to fit.
       That was the first rule here and it was wrong twice over: several of
       these forms keep sections collapsed, and a table inside a
       display:none container reports scrollWidth 0, so seven of
       stoppage-form.html's eight grids measured as "narrow enough" and
       kept 48 inputs in table cells. And a grid that does fit is still
       the wrong shape for entry on a phone — a labelled field beats a
       cell whose column heading is off-screen, fit or no fit. */
  }

  function convert(table) {
    if (table.dataset.meOn === '1') return;

    const wrap = table.closest('.tbl-scroll, .table-wrapper') || table.parentElement;
    if (!wrap) return;

    const host = document.createElement('div');
    host.className = 'me-cards';
    host.id = 'me-cards-' + (++uid);
    host.appendChild(buildCards(table));

    /* Nothing worth showing (an empty or purely decorative table). */
    if (!host.children.length) { table.dataset.meSkip = '1'; return; }

    wrap.parentNode.insertBefore(host, wrap);
    wrap.classList.add('me-hidden');

    /* mobile-shell.js may already have attached its "swipe sideways" hint
       to this grid before the cards existed. The grid is hidden now, so
       the hint would be advice about something invisible. */
    const stale = wrap.parentNode.querySelector('.ms-swipe-hint');
    if (stale) stale.remove();
    table.dataset.meOn = '1';
    table.dataset.meHost = host.id;

    /* The toggle sits with the cards, so the officer can always get the
       real grid back — some checks genuinely need the row-and-column
       view, and this must never be a one-way door. */
    const bar = document.createElement('div');
    bar.className = 'me-toolbar';
    bar.innerHTML =
      '<span class="me-count"></span>' +
      '<button type="button" class="me-toggle">Table view</button>';
    host.insertBefore(bar, host.firstChild);

    bar.querySelector('.me-toggle').addEventListener('click', () => {
      const showingCards = !wrap.classList.contains('me-hidden-off');
      if (showingCards) {
        wrap.classList.remove('me-hidden');
        wrap.classList.add('me-hidden-off');
        host.classList.add('me-collapsed');
        bar.querySelector('.me-toggle').textContent = 'Card view';
        wrap.parentNode.insertBefore(bar, wrap);
      } else {
        wrap.classList.add('me-hidden');
        wrap.classList.remove('me-hidden-off');
        host.classList.remove('me-collapsed');
        bar.querySelector('.me-toggle').textContent = 'Table view';
        host.insertBefore(bar, host.firstChild);
      }
    });

    updateCount(table);
  }

  function restore(table) {
    if (table.dataset.meOn !== '1') return;
    const host = document.getElementById(table.dataset.meHost);
    const wrap = table.closest('.tbl-scroll, .table-wrapper') || table.parentElement;

    if (host) {
      /* Put every moved node back exactly where it came from. */
      host.querySelectorAll(CTRL + ', .cv').forEach(node => {
        const home = homes.get(node);
        if (!home || !home.parent) return;
        if (home.next && home.next.parentNode === home.parent) {
          home.parent.insertBefore(node, home.next);
        } else {
          home.parent.appendChild(node);
        }
        node.classList.remove('me-d-v');
        homes.delete(node);
      });
      host.remove();
    }
    if (wrap) wrap.classList.remove('me-hidden', 'me-hidden-off');
    delete table.dataset.meOn;
    delete table.dataset.meHost;
  }

  /* ══════════════════════════════════════════════════════════════════
     PROGRESS
     "23 of 84 filled" beats a bare scrollbar for the one question an
     officer actually has half way through a shift report: how much is
     left. Counted per table, and once for the whole form.
     ══════════════════════════════════════════════════════════════════ */
  function countFields(scope) {
    let total = 0, filled = 0, locked = 0;
    scope.querySelectorAll('input.ci, input[data-field], select[data-field], textarea[data-field]')
      .forEach(el => {
        if (el.type === 'hidden') return;
        const has = String(el.value || '').trim() !== '';
        /* :placeholder-shown cannot answer this — a number input with no
           placeholder never matches it — so the filled state is a class. */
        el.classList.toggle('me-filled', has);
        /* A disabled field is not work outstanding. The form disables
           every input when the role does not own the report or the day is
           already submitted, so counting them would tell an officer they
           have 84 fields to fill on a report they cannot touch. */
        if (el.disabled || el.readOnly) { locked++; return; }
        total++;
        if (has) filled++;
      });
    return { total, filled, locked };
  }

  function updateCount(table) {
    const host = table && table.dataset.meHost && document.getElementById(table.dataset.meHost);
    if (host) {
      const el = host.querySelector('.me-count');
      const c = countFields(host);
      if (el) {
        el.textContent = c.total ? `${c.filled} of ${c.total} filled`
                       : (c.locked ? 'View only' : '');
        el.classList.toggle('me-done', c.total > 0 && c.filled === c.total);
      }
    }
    updateFormProgress();
  }

  /* Progress means "how much of the REPORT is done", so it counts the
     entry areas only. Counting the whole document would fold in the
     toolbar's date and Prepared By, which are never disabled — enough to
     make a report this role cannot edit at all read "1 of 1 filled"
     instead of "View only". */
  function reportScopes() {
    const els = [...document.querySelectorAll('.me-cards, table.rt')];
    return els.filter(el => !els.some(other => other !== el && other.contains(el)));
  }

  function countReport() {
    const acc = { total: 0, filled: 0, locked: 0 };
    reportScopes().forEach(el => {
      const c = countFields(el);
      acc.total += c.total; acc.filled += c.filled; acc.locked += c.locked;
    });
    return acc;
  }

  function updateFormProgress() {
    const bar = document.getElementById('me-progress');
    if (!bar) return;
    const c = countReport();

    /* Read-only is a state worth naming, not a progress of zero. It is
       what an officer sees on another department's report, and what
       everyone sees once the day is submitted. */
    if (!c.total && c.locked) {
      bar.classList.add('me-pg-locked');
      bar.classList.remove('me-pg-done');
      bar.querySelector('.me-pg-fill').style.width = '100%';
      bar.querySelector('.me-pg-text').textContent = 'View only';
      bar.setAttribute('aria-valuenow', '100');
      syncSaveProxy(false);
      return;
    }
    bar.classList.remove('me-pg-locked');

    const pct = c.total ? Math.round((c.filled / c.total) * 100) : 0;
    bar.querySelector('.me-pg-fill').style.width = pct + '%';
    bar.querySelector('.me-pg-text').textContent =
      c.total ? `${c.filled} of ${c.total} filled` : 'Nothing to fill here';
    bar.classList.toggle('me-pg-done', c.total > 0 && c.filled === c.total);
    bar.setAttribute('aria-valuenow', String(pct));
    syncSaveProxy(c.total > 0);
  }

  function mountProgress() {
    if (document.getElementById('me-progress')) return;
    const main = document.querySelector('.main');
    if (!main) return;
    const anchor = main.querySelector('.top-header');
    const bar = document.createElement('div');
    bar.id = 'me-progress';
    bar.className = 'me-pg';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-label', 'Entry progress for this report');
    bar.innerHTML = '<div class="me-pg-track"><i class="me-pg-fill"></i></div>' +
                    '<span class="me-pg-text"></span>' +
                    '<button type="button" class="me-pg-save" hidden>Save</button>';
    if (anchor && anchor.nextSibling) main.insertBefore(bar, anchor.nextSibling);
    else main.insertBefore(bar, main.firstChild);

    /* Save lives in the sticky strip because the real button is in the
       toolbar at the very top of the page. form-persist.js autosaves every
       60s, but only to localStorage — persisting to the server is still an
       explicit act, and an officer 60 fields down a card list should not
       have to scroll back up to perform it. This is a proxy, not a second
       implementation: it clicks the page's own .btn-save so the lock
       checks, validation and toasts all still run. */
    const proxy = bar.querySelector('.me-pg-save');
    proxy.addEventListener('click', () => {
      const real = document.querySelector('.btn-save');
      if (!real || real.disabled) return;
      real.click();
      proxy.textContent = 'Saving…';
      proxy.disabled = true;
      setTimeout(() => { proxy.textContent = 'Save'; proxy.disabled = false; }, 2200);
    });
  }

  /* Shown only when there is something to save. Deliberately gated on
     whether the report has any editable field rather than on whether
     .btn-save is disabled: a page the role cannot edit disables its
     inputs but does not always disable that button, so mirroring the
     button offered a Save on a view-only report. */
  function syncSaveProxy(editable) {
    const bar = document.getElementById('me-progress');
    if (!bar) return;
    const proxy = bar.querySelector('.me-pg-save');
    const real  = document.querySelector('.btn-save');
    if (!proxy) return;
    proxy.hidden = !real || real.disabled || !editable;
  }

  /* ══════════════════════════════════════════════════════════════════
     BOOT
     ══════════════════════════════════════════════════════════════════ */
  let applied = false;

  function apply() {
    if (applied) return;
    applied = true;
    mountProgress();
    tablesToConvert().forEach(convert);
    updateFormProgress();
  }

  function unapply() {
    if (!applied) return;
    applied = false;
    document.querySelectorAll('table.rt[data-me-on="1"]').forEach(restore);
    const bar = document.getElementById('me-progress');
    if (bar) bar.remove();
  }

  function sync() {
    if (isMobile()) apply();
    else unapply();
  }

  function init() {
    if (!document.querySelector('table.rt')) return;

    sync();

    /* Values arrive from the API after load (form-persist restores a
       draft), so the counts must follow rather than be read once. */
    document.addEventListener('input', e => {
      if (!e.target || !e.target.matches || !e.target.matches(CTRL)) return;
      e.target.classList.toggle('me-filled', String(e.target.value || '').trim() !== '');
      updateFormProgress();
    }, true);
    document.addEventListener('change', e => {
      if (e.target && e.target.matches && e.target.matches(CTRL)) {
        document.querySelectorAll('table.rt[data-me-on="1"]').forEach(updateCount);
      }
    }, true);

    [700, 1800, 3500].forEach(t => setTimeout(() => {
      if (applied) document.querySelectorAll('table.rt[data-me-on="1"]').forEach(updateCount);
      updateFormProgress();
    }, t));

    const mq = window.matchMedia(MOBILE_Q);
    if (mq.addEventListener) mq.addEventListener('change', sync);
    else if (mq.addListener) mq.addListener(sync);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.LCL_MOBILE_ENTRY = { apply, unapply, sync, refresh: updateFormProgress };
})();
