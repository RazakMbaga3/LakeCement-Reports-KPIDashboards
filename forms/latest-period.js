/* ══════════════════════════════════════════════════════════════
   Lake Cement Ltd — "latest period that actually has data"

   Every analytics page defaults its date picker to today. In a plant entering
   reports daily that is exactly right. It is wrong in every other situation,
   and the dashboard had no way to tell the two apart: with the backfill
   ending 15 Jul 2026, Material & Power Balance opened on "No Production or
   Power Consumption data", Equipment Reliability opened with an empty Pareto,
   empty equipment table and no RCFA flags, and Operational Insights showed
   three blank material charts — all of which read as "this page is broken"
   rather than "you are looking past the end of the data".

   So a page asks for its default range, gets today when today has data, and
   otherwise gets the newest date that does — plus a banner saying which
   period it fell back to and why. Never silently: a figure on screen must
   always say which day it belongs to.

   Requires forms/api-client.js (NyatiAPI.getDataRange).
   ══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  /* Local calendar date, never toISOString(): EAT is UTC+3, so between local
     midnight and 03:00 the UTC date is still yesterday. */
  function isoOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayIso() { return isoOf(new Date()); }
  function addDaysIso(iso, n) {
    var d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return isoOf(d);
  }
  function fmtLong(iso) {
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  var _cache = null;   // one fetch per page load, shared by every caller

  async function dataRange() {
    if (_cache) return _cache;
    if (!global.NyatiAPI || !NyatiAPI.getDataRange) return null;
    try { _cache = await NyatiAPI.getDataRange(); } catch (e) { _cache = null; }
    return _cache;
  }

  /* The newest date holding data. `formTypes` narrows it to the forms a page
     actually reads (Balance cares about production + power-cons; Reliability
     only about stoppage), so a page isn't dragged forward by a form it never
     displays. Returns null when the server is unreachable — the caller then
     keeps today and shows its own offline state. */
  async function latestDate(formTypes) {
    var range = await dataRange();
    if (!range) return null;
    if (!formTypes || !formTypes.length) return range.overall && range.overall.last;
    var lasts = formTypes
      .map(function (f) { return range.forms[f] && range.forms[f].last; })
      .filter(Boolean)
      .sort();
    return lasts.length ? lasts[lasts.length - 1] : null;
  }

  /* A single date for a day-at-a-time page (balance.html).
     → { date, fellBack, note } */
  async function defaultDate(formTypes) {
    var today = todayIso();
    var last  = await latestDate(formTypes);
    if (!last || last >= today) return { date: today, fellBack: false, note: '' };
    return {
      date: last,
      fellBack: true,
      note: 'Showing ' + fmtLong(last) + ' — the most recent date with data (nothing has been entered since).',
    };
  }

  /* A from/to window for the range pages (insights.html, reliability.html,
     completeness.html). Keeps the requested WIDTH and slides it back so it
     ends on the last day that has data, rather than silently shortening it. */
  async function defaultRange(days, formTypes) {
    var today = todayIso();
    var last  = await latestDate(formTypes);
    if (!last || last >= today) {
      return { from: addDaysIso(today, -(days - 1)), to: today, fellBack: false, note: '' };
    }
    return {
      from: addDaysIso(last, -(days - 1)),
      to: last,
      fellBack: true,
      note: 'Showing the ' + days + ' days ending ' + fmtLong(last) +
            ' — the most recent date with data (nothing has been entered since).',
    };
  }

  /* Renders the fallback note into a container the page provides. Kept here
     so all five pages say the same thing the same way. */
  function showNote(elId, result) {
    var el = document.getElementById(elId);
    if (!el) return;
    if (!result || !result.fellBack) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = '';
    el.textContent = result.note;
  }

  global.LatestPeriod = {
    dataRange: dataRange,
    latestDate: latestDate,
    defaultDate: defaultDate,
    defaultRange: defaultRange,
    showNote: showNote,
    todayIso: todayIso,
    isoOf: isoOf,
    addDaysIso: addDaysIso,
  };
}(typeof window !== 'undefined' ? window : globalThis));
