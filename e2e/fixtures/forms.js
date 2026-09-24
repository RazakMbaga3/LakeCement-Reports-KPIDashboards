/*
  Helpers for driving the daily-report forms.

  setReportDate(page, date) — change the toolbar date the way the app sees it:
  a new value on the date input, then the same 'input' and 'change' events a
  real edit fires. Use this instead of page.fill('input[type="date"]', ...).

  WHY NOT page.fill(): that call waits for the element to be *editable*, and
  whether the toolbar date is editable depends on the state of whichever record
  the page opened on — which is TODAY's, in a shared dev database that the Odoo
  sync writes to.

    - forms/date-picker.js makes every input[type="date"] readonly at load, so
      the native popup gives way to its own calendar.
    - form-persist.js _unlockForm() then does removeAttribute('readonly') on
      every .ci / .tb-ctl — the date input included — so on a blank or draft day
      the field happens to be editable and fill() works.
    - On an APPROVED day _unlockForm() never runs and the picker's readonly
      stands, so fill() waits 60 s and times out with "element is not editable".

  So a spec that passed at 09:00 could fail at 13:30 without a line of code
  changing, the moment the Odoo dispatch pull approved today's record. That
  cost the suite dispatch-mtd (x2), draft-autosave and others, and it read as
  eight unrelated "pre-existing failures". A person changes the date by
  clicking the picker, which sets the value and fires 'change' — that is what
  this reproduces, and it is indifferent to the page's lock state.
*/

async function setReportDate(page, date) {
  await page.evaluate(d => {
    const el = document.querySelector('input[type="date"]');
    if (!el) throw new Error('setReportDate: no input[type="date"] on the page');
    el.value = d;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, date);
}

module.exports = { setReportDate };
