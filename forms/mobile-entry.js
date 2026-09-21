/* ══════════════════════════════════════════════════════════════════════
   Lake Cement Ltd — CARD VIEW FOR ENTRY GRIDS  |  forms/mobile-entry.js
   ──────────────────────────────────────────────────────────────────────
   Presents a shift grid as one card per row, and lets the reader choose
   between that and the grid at ANY screen size.

   Why
   ───
   The entry grids are 700–3,100px wide. That is right on a control-room
   screen and a keyhole on a handset: you cannot see which parameter you
   are typing a value for, because the label column has scrolled away.

   Card view is therefore the default on a phone — but it is a *view*,
   not a mobile fallback. Some people prefer cards on a desktop and some
   need the grid on a tablet, so the choice is theirs, it applies to the
   whole page, and it is remembered. `auto` (cards under 960px, grid
   above) is only the starting point.

   The one rule this file cannot break
   ───────────────────────────────────
   It MOVES the existing <input> and .cv nodes. It never clones them.

   form-persist.js, report-rollup.js and formula-registry.js all bind by
   attribute — [data-field], [data-kpi], .ci — never by row or cell
   position, which is what makes relocation safe. A clone would put two
   elements on the same data-field and the officer would fill one while
   the form saved the other. Every moved node's original parent and next
   sibling are recorded, so switching back is exact.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {

  const MOBILE_Q = '(max-width: 959px)';
  const isNarrow = () => window.matchMedia(MOBILE_Q).matches;

  const CTRL = 'input:not([type=hidden]):not([type=button]):not([type=submit]), select, textarea';

  /* Where every moved node came from, so restore is exact. */
  const homes = new WeakMap();
  let uid = 0;

  /* ══════════════════════════════════════════════════════════════════
     VIEW PREFERENCE
     'auto' | 'cards' | 'table'. Remembered per browser, applied to the
     whole page — a per-table toggle produced a mixed state nobody could
     reason about ("why is this one a grid?").
     ══════════════════════════════════════════════════════════════════ */
  const PREF_KEY = 'lcl_form_view';

  function pref() {
    try { return localStorage.getItem(PREF_KEY) || 'auto'; } catch (_) { return 'auto'; }
  }
  function setPref(v) {
    try { localStorage.setItem(PREF_KEY, v); } catch (_) {}
  }
  function wantCards() {
    const p = pref();
    return p === 'cards' || (p !== 'table' && isNarrow());
  }

  /* ══════════════════════════════════════════════════════════════════
     TEXT + HEADERS
     ══════════════════════════════════════════════════════════════════ */
  const squash = s => String(s || '').replace(/\s+/g, ' ').trim();

  /* <br> is invisible to textContent, and 84 headers in this app use one
     as a line break — which is how "Moisture<br>On Date" read as
     "MoistureOn Date". a11y.js owns the fix so both files agree. */
  function text(el) {
    if (window.LCL_A11Y && typeof window.LCL_A11Y.cellText === 'function') {
      return window.LCL_A11Y.cellText(el);
    }
    return squash(el && el.textContent);
  }

  /* A <thead> with rowspan/colspan cannot be read by column index.
     a11y.js owns the matrix; both files need the same answer. */
  function headerMatrix(table) {
    if (window.LCL_A11Y && typeof window.LCL_A11Y.headerMatrix === 'function') {
      return window.LCL_A11Y.headerMatrix(table);
    }
    const thead = table.tHead;
    if (!thead) return [];
    const last = thead.rows[thead.rows.length - 1];
    return [...(last ? last.cells : [])].map(th => [text(th)]);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ══════════════════════════════════════════════════════════════════
     ROW → CARD
     ══════════════════════════════════════════════════════════════════ */

  function isSectionRow(tr, width) {
    const cells = [...tr.cells];
    if (!cells.length) return false;
    if (cells.length === 1) return true;
    return cells.length < width && cells.every(td => !td.querySelector(CTRL)) &&
           cells.some(td => (td.colSpan || 1) >= width - 1);
  }

  function specOf(td) {
    const el = td.querySelector('.spec-range');
    if (el) return text(el);
    const div = [...td.children].find(n => n.tagName === 'DIV' && !n.classList.contains('cv'));
    return div ? text(div) : '';
  }

  /* What names this row?
     Several grids lead with a serial number — materials, the pile log and
     the daily raw-material table all do — so taking the first cell gave
     cards titled "3" and "4" while the thing that actually identifies the
     row (CLAY, IRON ORE, Gypsum) got buried in the read-back strip. Skip
     leading serials, keep them as a small badge, and title the card with
     the first cell that reads like a name. */
  function pickTitle(cells) {
    let serial = '';
    const consumed = [];
    for (let i = 0; i < cells.length && i < 4; i++) {
      const td = cells[i];
      if (td.querySelector(CTRL)) break;      /* reached the data */
      const t = text(td);
      consumed.push(i);
      if (!t || t === '—') continue;
      if (/^\d{1,3}[.)]?$/.test(t)) { if (!serial) serial = t; continue; }
      return { title: t, serial, consumed };
    }
    return { title: serial, serial: '', consumed: [0] };
  }

  const groupKeyOf = parts => (parts || []).slice(0, -1).join(' · ');
  const leafOf     = parts => (parts && parts.length) ? parts[parts.length - 1] : '';

  function buildCards(table) {
    const cols  = headerMatrix(table);
    const width = cols.length;
    const frag  = document.createDocumentFragment();

    [...table.tBodies].forEach(tbody => {
      [...tbody.rows].forEach(tr => {
        if (tr.hidden || tr.style.display === 'none') return;

        if (isSectionRow(tr, width)) {
          const h = document.createElement('div');
          h.className = 'me-group';
          h.textContent = text(tr);
          if (h.textContent) frag.appendChild(h);
          return;
        }

        const cells = [...tr.cells];
        if (cells.length < 2) return;

        const { title, serial, consumed } = pickTitle(cells);
        const skip = new Set(consumed);

        let ci = 0;
        const entries = [];
        const derived = [];

        cells.forEach((td, i) => {
          const span = td.colSpan || 1;
          const colParts = cols[ci] || [];
          ci += span;
          if (skip.has(i)) return;             /* already the card's identity */

          const ctrls = [...td.querySelectorAll(CTRL)];
          if (ctrls.length) {
            entries.push({ ctrls, colParts, spec: specOf(td) });
          } else {
            const val = td.querySelector('.cv');
            const txt = text(td);
            if (val) derived.push({ node: val, colParts });
            else if (txt && txt !== '—') derived.push({ node: null, text: txt, colParts });
          }
        });

        if (!entries.length && !derived.length) return;

        const card = document.createElement('article');
        card.className = 'me-card';
        if (!entries.length) card.classList.add('me-readonly');

        /* ── header ─────────────────────────────────────────────── */
        const rowSpec = entries.map(e => e.spec).find(Boolean) || '';
        const head = document.createElement('header');
        head.className = 'me-card-hd';
        head.innerHTML =
          (serial ? `<span class="me-card-sn">${esc(serial)}</span>` : '') +
          `<h4 class="me-card-title">${esc(title || 'Row')}</h4>` +
          (rowSpec ? `<span class="me-card-spec">${esc(rowSpec)}</span>` : '');
        card.appendChild(head);

        /* ── entry fields, grouped by their shared column heading ──
           "Material Consumption (MT)" covering On Date / MTD / YTD was
           being repeated in full on all three labels, which made each
           label three lines tall and squeezed the input to nothing.
           Shown once as a heading, the leaves fit on one line. */
        if (entries.length) {
          const body = document.createElement('div');
          body.className = 'me-body';

          const runs = [];
          entries.forEach(e => {
            const key = groupKeyOf(e.colParts);
            const last = runs[runs.length - 1];
            if (last && last.key === key) last.items.push(e);
            else runs.push({ key, items: [e] });
          });

          /* Consecutive singletons share one grid rather than becoming a
             stack of one-column grids. */
          const blocks = [];
          runs.forEach(run => {
            const grouped = run.key && run.items.length >= 2;
            const last = blocks[blocks.length - 1];
            if (!grouped && last && !last.key) last.items.push(...run.items);
            else blocks.push({ key: grouped ? run.key : '', items: run.items });
          });

          blocks.forEach(block => {
            const host = document.createElement('div');
            host.className = block.key ? 'me-fgroup' : 'me-plain';
            if (block.key) {
              const h = document.createElement('div');
              h.className = 'me-fgroup-h';
              h.textContent = block.key;
              host.appendChild(h);
            }
            const grid = document.createElement('div');
            grid.className = 'me-fields';
            grid.style.setProperty('--me-cols', Math.min(block.items.length, 3));

            block.items.forEach(e => {
              const wrap = document.createElement('label');
              wrap.className = 'me-field';
              const lbl = document.createElement('span');
              lbl.className = 'me-field-lbl';
              /* Inside a group the heading carries the context, so only
                 the leaf is needed here. */
              lbl.textContent = block.key ? leafOf(e.colParts) : (e.colParts || []).join(' · ');
              wrap.appendChild(lbl);
              e.ctrls.forEach(c => {
                homes.set(c, { parent: c.parentNode, next: c.nextSibling });
                wrap.appendChild(c);
              });
              grid.appendChild(wrap);
            });
            host.appendChild(grid);
            body.appendChild(host);
          });
          card.appendChild(body);
        }

        /* ── computed read-back ──────────────────────────────────
           Keyed by the leaf where that is unambiguous, and by group +
           leaf where it is not: a card with both "Received Quantity ·
           MTD" and "Material Consumption · MTD" showed two cells both
           labelled "MTD". */
        if (derived.length) {
          const seen = {};
          derived.forEach(d => {
            const l = leafOf(d.colParts);
            seen[l] = (seen[l] || 0) + 1;
          });

          const foot = document.createElement('footer');
          foot.className = 'me-derived';
          derived.forEach(d => {
            const l = leafOf(d.colParts);
            const label = (seen[l] > 1 && d.colParts.length > 1)
              ? d.colParts.join(' · ') : l;

            const item = document.createElement('div');
            item.className = 'me-d';
            const k = document.createElement('span');
            k.className = 'me-d-k';
            k.textContent = label;
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
    /* Deliberately NOT gated on whether the grid is too wide to fit. That
       was the first rule and it was wrong twice over: a table inside a
       collapsed section reports scrollWidth 0, which stranded 48 inputs
       in cells on stoppage-form.html; and a grid that fits is still the
       wrong shape for entry when the reader has asked for cards. */
  }

  function convert(table) {
    if (table.dataset.meOn === '1') return;
    const wrap = table.closest('.tbl-scroll, .table-wrapper') || table.parentElement;
    if (!wrap) return;

    const host = document.createElement('div');
    host.className = 'me-cards';
    host.id = 'me-cards-' + (++uid);
    host.appendChild(buildCards(table));
    if (!host.children.length) { table.dataset.meSkip = '1'; return; }

    wrap.parentNode.insertBefore(host, wrap);
    wrap.classList.add('me-hidden');
    table.dataset.meOn = '1';
    table.dataset.meHost = host.id;

    /* mobile-shell.js may already have hung its "swipe sideways" hint on
       this grid; the grid is hidden now, so the hint is advice about
       something invisible. */
    const stale = wrap.parentNode.querySelector('.ms-swipe-hint');
    if (stale) stale.remove();

    const bar = document.createElement('div');
    bar.className = 'me-toolbar';
    bar.innerHTML = '<span class="me-count"></span>';
    host.insertBefore(bar, host.firstChild);

    updateCount(table);
  }

  function restore(table) {
    if (table.dataset.meOn !== '1') return;
    const host = document.getElementById(table.dataset.meHost);
    const wrap = table.closest('.tbl-scroll, .table-wrapper') || table.parentElement;

    if (host) {
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
    if (wrap) wrap.classList.remove('me-hidden');
    delete table.dataset.meOn;
    delete table.dataset.meHost;
  }

  /* ══════════════════════════════════════════════════════════════════
     PROGRESS + VIEW SWITCH + SAVE
     ══════════════════════════════════════════════════════════════════ */
  function countFields(scope) {
    let total = 0, filled = 0, locked = 0, optional = 0, logged = 0;
    scope.querySelectorAll('input.ci, input[data-field], select[data-field], textarea[data-field]')
      .forEach(el => {
        if (el.type === 'hidden') return;
        const has = String(el.value || '').trim() !== '';
        el.classList.toggle('me-filled', has);
        /* A disabled field is not work outstanding — a form the role does
           not own disables every input. */
        if (el.disabled || el.readOnly) { locked++; return; }
        /* Nor is an exception log, where blank is the normal and correct
           answer for nearly every row: the stoppage form lists all 417 of
           the plant's named faults and a good day fills in three. Counted
           as outstanding work, a finished report would read "3 of 417
           filled" and sit at 1% forever. These report a count, not a
           fraction — there is no denominator to be a fraction of. */
        if (el.hasAttribute('data-optional')) { optional++; if (has) logged++; return; }
        total++;
        if (has) filled++;
      });
    return { total, filled, locked, optional, logged };
  }

  function reportScopes() {
    const els = [...document.querySelectorAll('.me-cards, table.rt')];
    return els.filter(el => !els.some(other => other !== el && other.contains(el)));
  }

  function countReport() {
    const acc = { total: 0, filled: 0, locked: 0, optional: 0, logged: 0 };
    reportScopes().forEach(el => {
      const c = countFields(el);
      acc.total += c.total; acc.filled += c.filled; acc.locked += c.locked;
      acc.optional += c.optional; acc.logged += c.logged;
    });
    return acc;
  }

  function updateCount(table) {
    const host = table && table.dataset.meHost && document.getElementById(table.dataset.meHost);
    if (host) {
      const el = host.querySelector('.me-count');
      const c = countFields(host);
      if (el) {
        el.textContent = c.total ? `${c.filled} of ${c.total} filled`
                       : c.optional ? `${c.logged} logged`
                       : (c.locked ? 'View only' : '');
        el.classList.toggle('me-done', c.total > 0 && c.filled === c.total);
      }
    }
    updateFormProgress();
  }

  function updateFormProgress() {
    const bar = document.getElementById('me-progress');
    if (!bar) return;
    const c = countReport();
    const fill  = bar.querySelector('.me-pg-fill');
    const txt   = bar.querySelector('.me-pg-text');
    const track = bar.querySelector('.me-pg-track');

    /* An all-optional report (an exception log) has a count but no ratio.
       Checked before the locked branch so it is not mistaken for a form
       the role cannot edit — it is editable, it is simply never "full". */
    if (!c.total && c.optional) {
      bar.classList.remove('me-pg-locked', 'me-pg-done');
      if (track) track.hidden = true;
      txt.textContent = c.logged ? `${c.logged} logged` : 'Nothing logged yet';
      syncSaveProxy(true);
      return;
    }

    if (!c.total && c.locked) {
      bar.classList.add('me-pg-locked');
      bar.classList.remove('me-pg-done');
      /* Nothing to report progress ON. This used to fill the bar to 100%
         and label it "View only" — a completed-looking progress bar for
         a form that cannot be filled, sitting directly above the banner
         that already says the same three words. The track and the label
         go; the Cards/Table switch beside them stays, because choosing
         how to read a report is still the reader's to make. */
      if (track) track.hidden = true;
      txt.textContent = '';
      syncSaveProxy(false);
      return;
    }
    bar.classList.remove('me-pg-locked');
    if (track) track.hidden = false;

    const pct = c.total ? Math.round((c.filled / c.total) * 100) : 0;
    fill.style.width = pct + '%';
    txt.textContent = c.total ? `${c.filled} of ${c.total} filled` : 'Nothing to fill here';
    bar.classList.toggle('me-pg-done', c.total > 0 && c.filled === c.total);
    if (track) track.setAttribute('aria-valuenow', String(pct));
    syncSaveProxy(c.total > 0);
  }

  /* Shown only when there is something to save. Gated on whether the
     report has an editable field rather than on .btn-save being disabled:
     a page the role cannot edit disables its inputs but not always that
     button, which offered a Save on a view-only report. */
  function syncSaveProxy(editable) {
    const bar = document.getElementById('me-progress');
    if (!bar) return;
    const proxy = bar.querySelector('.me-pg-save');
    const real  = document.querySelector('.btn-save');
    if (!proxy) return;
    proxy.hidden = !real || real.disabled || !editable;
  }

  function mountProgress() {
    if (document.getElementById('me-progress')) return;
    const main = document.querySelector('.main');
    if (!main) return;
    const anchor = main.querySelector('.top-header');

    const bar = document.createElement('div');
    bar.id = 'me-progress';
    bar.className = 'me-pg';
    /* The progressbar role goes on the TRACK, not on this container: the
       container also holds the view switch and Save, and a progressbar
       may not have focusable descendants (axe: nested-interactive). */
    bar.innerHTML =
      '<div class="me-pg-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"' +
      ' aria-label="Entry progress for this report"><i class="me-pg-fill"></i></div>' +
      '<span class="me-pg-text"></span>' +
      '<div class="me-viewsw" role="group" aria-label="Report view">' +
        '<button type="button" class="me-vs" data-view="cards">Cards</button>' +
        '<button type="button" class="me-vs" data-view="table">Table</button>' +
      '</div>' +
      '<button type="button" class="me-pg-save" hidden>Save</button>';

    if (anchor && anchor.nextSibling) main.insertBefore(bar, anchor.nextSibling);
    else main.insertBefore(bar, main.firstChild);

    bar.querySelectorAll('.me-vs').forEach(btn => {
      btn.addEventListener('click', () => {
        setPref(btn.dataset.view);
        sync();
        paintViewSwitch();
      });
    });

    /* Save lives here because the real button is in the toolbar at the
       very top. form-persist autosaves every 60s, but only to
       localStorage — persisting to the server is an explicit act, and an
       officer sixty fields down should not scroll back up to perform it.
       A proxy, not a second implementation: it clicks the page's own
       .btn-save so the lock checks, validation and toasts still run. */
    const proxy = bar.querySelector('.me-pg-save');
    proxy.addEventListener('click', () => {
      const real = document.querySelector('.btn-save');
      if (!real || real.disabled) return;
      real.click();
      proxy.textContent = 'Saving…';
      proxy.disabled = true;
      setTimeout(() => { proxy.textContent = 'Save'; proxy.disabled = false; }, 2200);
    });

    paintViewSwitch();
  }

  function paintViewSwitch() {
    const cards = wantCards();
    document.querySelectorAll('.me-vs').forEach(b => {
      const on = (b.dataset.view === 'cards') === cards;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     BOOT
     ══════════════════════════════════════════════════════════════════ */
  let applied = false;

  function apply() {
    if (applied) return;
    applied = true;
    document.body.classList.add('me-view-cards');
    tablesToConvert().forEach(convert);
    updateFormProgress();
  }

  function unapply() {
    if (!applied) return;
    applied = false;
    document.body.classList.remove('me-view-cards');
    document.querySelectorAll('table.rt[data-me-on="1"]').forEach(restore);
    updateFormProgress();
  }

  function sync() {
    if (wantCards()) apply(); else unapply();
    paintViewSwitch();
  }

  function init() {
    if (!document.querySelector('table.rt')) return;

    mountProgress();
    sync();

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

    /* Values arrive from the API after load, so counts follow rather than
       being read once. */
    [700, 1800, 3500].forEach(t => setTimeout(() => {
      if (applied) document.querySelectorAll('table.rt[data-me-on="1"]').forEach(updateCount);
      updateFormProgress();
    }, t));

    const mq = window.matchMedia(MOBILE_Q);
    const onChange = () => { if (pref() === 'auto') sync(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.LCL_MOBILE_ENTRY = { apply, unapply, sync, refresh: updateFormProgress, setView: v => { setPref(v); sync(); } };
})();
