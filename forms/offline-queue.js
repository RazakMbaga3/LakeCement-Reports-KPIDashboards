/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — Offline Write Queue
   ─────────────────────────────────────────────────────────────────
   When a form submit can't reach the backend (plant network outage,
   server restart), form-persist.js / inline-edit.js enqueue it here.
   The queue auto-flushes on reconnect ('online' event), every 60 s,
   and shortly after page load — so entries made offline reach
   Postgres without anyone having to remember to resubmit.

   CONFLICT RULE (server wins): before sending a queued item, the
   current server record is fetched; if the server copy was written
   AFTER the item was queued, the item is NOT applied — it moves to a
   review list where the user chooses "use mine" or "keep server".

   The core is environment-agnostic (storage + api injected) so the
   node acceptance test (backend/scripts/accept-phase2.js) exercises
   the exact code the browser runs. In the browser it wires itself to
   localStorage + NyatiAPI and renders a status pill bottom-left.

   Load order: auth.js → api-client.js → offline-queue.js
   ══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var QKEY = 'nyati-queue';
  var CKEY = 'nyati-queue-conflicts';

  function createQueue(opts) {
    var storage  = opts.storage;
    var api      = opts.api; // function returning { getForm, submitForm } (lazy — load order safe)
    var now      = opts.now || function () { return new Date().toISOString(); };
    var onChange = opts.onChange || function () {};

    function _load(key) {
      try { return JSON.parse(storage.getItem(key) || '[]'); } catch (e) { return []; }
    }
    function _save(key, arr) {
      storage.setItem(key, JSON.stringify(arr));
      onChange(counts());
    }

    function counts() {
      return { pending: _load(QKEY).length, conflicts: _load(CKEY).length };
    }
    function list() {
      return { pending: _load(QKEY), conflicts: _load(CKEY) };
    }

    /* One queue slot per form+date+shift — a newer save replaces the
       older queued one (the user re-saved the same report). */
    function _intentOf(item) {
      return (item && item.data && item.data._status) === 'draft' ? 'draft' : 'submitted';
    }

    function enqueue(formType, date, shift, data) {
      var q = _load(QKEY).filter(function (it) {
        return !(it.formType === formType && it.date === date && it.shift === shift);
      });
      q.push({ formType: formType, date: date, shift: shift || 'day', data: data, queuedAt: now() });
      _save(QKEY, q);
    }

    function _toConflict(item, reason, serverSavedAt) {
      var c = _load(CKEY).filter(function (it) {
        return !(it.formType === item.formType && it.date === item.date && it.shift === item.shift);
      });
      c.push({
        formType: item.formType, date: item.date, shift: item.shift,
        data: item.data, queuedAt: item.queuedAt,
        reason: reason, serverSavedAt: serverSavedAt || null, flaggedAt: now(),
      });
      _save(CKEY, c);
    }

    /* 'sent' | 'conflict' | 'retry' */
    function _trySend(item) {
      var a = api();
      if (!a) return Promise.resolve('retry');
      return a.getForm(item.formType, item.date, item.shift).then(function (current) {
        var serverAt = current && (current.updated_at || current.submitted_at);
        if (serverAt && Date.parse(serverAt) > Date.parse(item.queuedAt)) {
          _toConflict(item, 'A newer version was saved on the server while this entry was queued.', serverAt);
          return 'conflict';
        }
        /* Replay each item with the intent it was created with. Without
           this a queued DRAFT comes back online as a full submission —
           entering an HOD's approval queue, or self-certifying as approved,
           for a form its author never finished. form-persist.js stamps
           `_status` into the payload, so items queued before this change
           replay correctly too. */
        return a.submitForm(item.formType, item.date, item.shift, item.data, { status: _intentOf(item) })
          .then(function () { return 'sent'; })
          .catch(function (e) {
            // Permanent rejections (validation, no permission) will never
            // succeed by retrying — surface them for review instead.
            if (e && e.status && e.status !== 401 && e.status >= 400 && e.status < 500) {
              _toConflict(item, 'Server rejected the entry (HTTP ' + e.status + ').', null);
              return 'conflict';
            }
            return 'retry'; // network down, 401 (re-login pending), or 5xx
          });
      }).catch(function () {
        return 'retry'; // can't even read the server — still offline
      });
    }

    var _flushing = false;
    async function flush() {
      if (_flushing) return counts();
      _flushing = true;
      try {
        var q = _load(QKEY);
        if (!q.length) return counts();
        var keep = [], stopped = false;
        for (var i = 0; i < q.length; i++) {
          if (stopped) { keep.push(q[i]); continue; }
          var outcome = await _trySend(q[i]);
          if (outcome === 'retry') { keep.push(q[i]); stopped = true; } // server unreachable — stop hammering
          // 'sent' → drop from queue; 'conflict' → already moved to review list
        }
        _save(QKEY, keep);
        return counts();
      } finally {
        _flushing = false;
      }
    }

    /* action: 'mine' (push the queued data to the server) | 'server' (discard mine) */
    async function resolveConflict(index, action) {
      var c = _load(CKEY);
      var item = c[index];
      if (!item) return { ok: false, error: 'No such conflict.' };
      if (action === 'mine') {
        try {
          await api().submitForm(item.formType, item.date, item.shift, item.data, { status: _intentOf(item) });
        } catch (e) {
          return { ok: false, error: 'Could not send — server unreachable or rejected it.' };
        }
      }
      c.splice(index, 1);
      _save(CKEY, c);
      return { ok: true };
    }

    return { enqueue: enqueue, flush: flush, counts: counts, list: list, resolveConflict: resolveConflict };
  }

  /* Node (acceptance tests) — export the factory and stop here */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createQueue: createQueue };
    return;
  }

  /* ═════════════════ Browser bootstrap + status pill ═══════════════ */

  var queue = createQueue({
    storage: global.localStorage,
    api: function () { return global.NyatiAPI; },
    onChange: _renderPill,
  });
  global.NyatiQueue = queue;

  global.addEventListener('online', function () { queue.flush(); });
  setInterval(function () { queue.flush(); }, 60000);
  setTimeout(function () { queue.flush(); }, 2500); // after auth/api are ready

  function _fmtTime(iso) {
    try { return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return iso; }
  }

  function _renderPill(c) {
    c = c || queue.counts();
    var total = c.pending + c.conflicts;
    var pill = document.getElementById('_nyq-pill');
    if (!total) {
      if (pill) pill.remove();
      var panel = document.getElementById('_nyq-panel');
      if (panel) panel.remove();
      return;
    }
    if (!pill) {
      pill = document.createElement('button');
      pill.id = '_nyq-pill';
      pill.type = 'button';
      Object.assign(pill.style, {
        position: 'fixed', bottom: '18px', left: '18px', zIndex: '9996',
        border: 'none', borderRadius: '999px', padding: '8px 16px',
        fontFamily: 'Inter,sans-serif', fontSize: '12px', fontWeight: '700',
        color: 'white', cursor: 'pointer', boxShadow: '0 4px 18px rgba(0,0,0,.25)',
      });
      pill.onclick = _togglePanel;
      document.body.appendChild(pill);
    }
    if (c.conflicts > 0) {
      pill.style.background = '#DC2626';
      pill.textContent = '⚠ ' + c.conflicts + ' entr' + (c.conflicts === 1 ? 'y needs' : 'ies need') + ' review' +
        (c.pending ? ' · ' + c.pending + ' pending' : '');
    } else {
      pill.style.background = '#173158';
      pill.textContent = '⏳ ' + c.pending + ' entr' + (c.pending === 1 ? 'y' : 'ies') + ' waiting to sync';
    }
  }

  function _togglePanel() {
    var old = document.getElementById('_nyq-panel');
    if (old) { old.remove(); return; }

    var l = queue.list();
    var panel = document.createElement('div');
    panel.id = '_nyq-panel';
    Object.assign(panel.style, {
      position: 'fixed', bottom: '58px', left: '18px', zIndex: '9996',
      background: 'white', border: '1.5px solid #DDE3EC', borderRadius: '10px',
      boxShadow: '0 8px 36px rgba(0,0,0,.16)', width: '340px', maxHeight: '400px',
      overflowY: 'auto', fontFamily: 'Inter,sans-serif',
    });

    var html =
      '<div style="background:#173158;color:white;padding:10px 14px;font-size:11px;font-weight:700;' +
      'letter-spacing:.6px;text-transform:uppercase;display:flex;justify-content:space-between;align-items:center">' +
      '<span>Offline Sync</span>' +
      '<button id="_nyq-sync" style="background:#F49545;border:none;color:white;font-size:10px;font-weight:700;' +
      'padding:4px 10px;border-radius:5px;cursor:pointer;font-family:inherit">Sync now</button></div>';

    l.conflicts.forEach(function (it, i) {
      html +=
        '<div style="padding:10px 14px;border-bottom:1px solid #F0F4F8;font-size:12px">' +
        '<div style="font-weight:700;color:#DC2626">⚠ ' + it.formType + ' — ' + it.date + '</div>' +
        '<div style="color:#64748B;font-size:11px;margin:3px 0 7px;line-height:1.45">' + it.reason +
        '<br>Yours queued ' + _fmtTime(it.queuedAt) +
        (it.serverSavedAt ? ' · server saved ' + _fmtTime(it.serverSavedAt) : '') + '</div>' +
        '<button data-nyq-resolve="mine:' + i + '" style="background:#F49545;border:none;color:white;font-size:11px;' +
        'font-weight:700;padding:5px 11px;border-radius:5px;cursor:pointer;margin-right:6px;font-family:inherit">Use mine</button>' +
        '<button data-nyq-resolve="server:' + i + '" style="background:#EEF2F7;border:none;color:#173158;font-size:11px;' +
        'font-weight:700;padding:5px 11px;border-radius:5px;cursor:pointer;font-family:inherit">Keep server</button>' +
        '</div>';
    });

    l.pending.forEach(function (it) {
      html +=
        '<div style="padding:10px 14px;border-bottom:1px solid #F0F4F8;font-size:12px;display:flex;justify-content:space-between">' +
        '<span style="font-weight:600;color:#173158">' + it.formType + ' — ' + it.date + '</span>' +
        '<span style="color:#94A3B8;font-size:11px">queued ' + _fmtTime(it.queuedAt) + '</span></div>';
    });

    if (!l.conflicts.length && !l.pending.length) {
      html += '<div style="padding:18px 14px;font-size:12px;color:#94A3B8;text-align:center">All synced ✓</div>';
    }

    panel.innerHTML = html;
    document.body.appendChild(panel);

    panel.querySelector('#_nyq-sync').onclick = function () {
      queue.flush().then(function () { panel.remove(); _renderPill(); });
    };
    panel.querySelectorAll('[data-nyq-resolve]').forEach(function (btn) {
      btn.onclick = function () {
        var parts = btn.getAttribute('data-nyq-resolve').split(':');
        queue.resolveConflict(parseInt(parts[1], 10), parts[0]).then(function (r) {
          panel.remove();
          _renderPill();
          if (!r.ok) alert(r.error);
        });
      };
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { _renderPill(); });
  } else {
    _renderPill();
  }

}(typeof window !== 'undefined' ? window : globalThis));
