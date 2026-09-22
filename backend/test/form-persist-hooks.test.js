/*
  form-persist-hooks.test.js — do the buttons on a form page do what their
  labels say?

  forms/form-persist.js wires a page up by looking for elements: .btn-save
  saves a draft, .btn-sub submits, and "Load Previous" opens the history
  panel. Until 2026-09-21 it found the history button by `.btn-out` — which is
  only the outline-button STYLE, used all over these pages. Seven pages ship a
  second "Save Draft" in the sign-off card at the foot of the form, and every
  one was written as `btn btn-out`, so it opened the "Saved Snapshots" panel
  instead of saving. A CPP officer who filled the whole 19 September report and
  pressed the Save Draft next to Submit & Lock got a panel reading "No drafts
  saved yet" and nothing on the server; the same binding also stopped the
  "View report" links from navigating and made "Add pile row" open the panel.

  These are static checks on the markup, discovered from each page's own
  initFormPersist() call, so a new form page is held to the same rule without
  anyone remembering to register it. (e2e/tests/draft-reaccess.spec.js proves
  the behaviour end to end; this is what stops the markup drifting back.)
*/

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

function htmlPages() {
  const dirs = [ROOT, path.join(ROOT, 'forms')];
  return dirs.flatMap(d => fs.readdirSync(d)
    .filter(f => f.endsWith('.html'))
    .map(f => path.join(d, f)));
}

const FORM_PAGES = htmlPages()
  .map(file => ({ file, rel: path.relative(ROOT, file).replace(/\\/g, '/'), src: fs.readFileSync(file, 'utf8') }))
  .filter(p => /initFormPersist\(/.test(p.src));

/* Every <button> / <a> in the static markup, with its class list and its
   visible text (inner tags stripped). */
function controls(src) {
  const out = [];
  const re = /<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(src))) {
    const cls = (/class="([^"]*)"/.exec(m[2]) || ['', ''])[1].split(/\s+/);
    out.push({
      tag: m[1], attrs: m[2], cls,
      text: m[3].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

test('the scan actually found the form pages', () => {
  assert.ok(FORM_PAGES.length >= 10,
    `expected the ~10 form pages, found ${FORM_PAGES.length}: ${FORM_PAGES.map(p => p.rel).join(', ')}`);
});

test('every "Save Draft" button is a .btn-save, never an outline button', () => {
  const offenders = [];
  FORM_PAGES.forEach(p => {
    controls(p.src)
      .filter(c => /^save draft$/i.test(c.text) && !c.cls.includes('btn-save'))
      .forEach(c => offenders.push(`${p.rel}: <${c.tag} class="${c.cls.join(' ')}">`));
  });
  assert.deepStrictEqual(offenders, [],
    'these "Save Draft" buttons are not bound to the save handler:\n  ' + offenders.join('\n  '));
});

test('every form page has exactly one Load Previous button carrying the history hook', () => {
  const problems = [];
  FORM_PAGES.forEach(p => {
    const hooked = controls(p.src).filter(c => /data-persist="history"/.test(c.attrs));
    if (hooked.length !== 1) problems.push(`${p.rel}: ${hooked.length} elements with data-persist="history"`);
    else if (hooked[0].tag !== 'button') problems.push(`${p.rel}: the history hook is on an <${hooked[0].tag}>, expected a <button>`);
    else if (!/load previous/i.test(hooked[0].text)) problems.push(`${p.rel}: the history hook is on "${hooked[0].text}"`);
  });
  assert.deepStrictEqual(problems, [], problems.join('\n'));
});

test('no "Load Previous" button is left without the history hook', () => {
  const stray = [];
  FORM_PAGES.forEach(p => {
    controls(p.src)
      .filter(c => /^load previous$/i.test(c.text) && !/data-persist="history"/.test(c.attrs))
      .forEach(() => stray.push(`${p.rel}: "Load Previous" without the hook`));
  });
  assert.deepStrictEqual(stray, [], stray.join('\n'));
});

test('form-persist.js binds history by its hook, not by the .btn-out style class', () => {
  const src = fs.readFileSync(path.join(ROOT, 'forms', 'form-persist.js'), 'utf8');
  assert.ok(src.includes(`querySelectorAll('[data-persist="history"]')`),
    'form-persist.js should bind Load Previous via [data-persist="history"]');
  assert.ok(!/querySelectorAll\(\s*['"`]\.btn-out/.test(src),
    'form-persist.js must not bind behaviour to .btn-out — it is a style shared by unrelated buttons');
});

test('every form page loads form-persist.js and api-client.js with a version query', () => {
  /* nginx caches .js for a day (deploy/nginx.digitalocean.conf) and serves .html
     fresh, so a fix to either script only reaches a user who already has the old
     one when the URL changes. An unversioned tag would be stuck at yesterday's. */
  const bare = [];
  FORM_PAGES.forEach(p => {
    ['form-persist.js', 'api-client.js'].forEach(name => {
      const tags = p.src.match(new RegExp('<script[^>]+src="[^"]*' + name.replace('.', '\\.') + '[^"]*"', 'g')) || [];
      if (!tags.length) bare.push(p.rel + ': does not load ' + name);
      tags.forEach(t => { if (!/\.js\?v=\d+/.test(t)) bare.push(p.rel + ': ' + name + ' has no ?v= version'); });
    });
  });
  assert.deepStrictEqual(bare, [], bare.join('\n'));
});

test('controls that are not report data opt out of persistence at the source', () => {
  /* An unnamed input is given a structural data-field and saved. These two are
     UI, not data: the e-mail-this-report box and the stoppage form's "name the
     fault" box. */
  const exp = fs.readFileSync(path.join(ROOT, 'forms', 'excel-export.js'), 'utf8');
  const rsn = fs.readFileSync(path.join(ROOT, 'forms', 'stoppage-reasons.js'), 'utf8');
  assert.match(exp, /class="exp-email-in"[^>]*data-nopersist/, 'the export e-mail box must carry data-nopersist');
  assert.match(rsn, /class="rsn-add-in"[^>]*data-nopersist/, 'the add-a-reason box must carry data-nopersist');
});

test('the pile log grows its rows before a saved log is restored', () => {
  const pile = fs.readFileSync(path.join(ROOT, 'forms', 'pile-quality-form.html'), 'utf8');
  const fp   = fs.readFileSync(path.join(ROOT, 'forms', 'form-persist.js'), 'utf8');
  assert.ok(fp.includes('nyati:before-restore'), 'form-persist.js must announce nyati:before-restore');
  assert.ok(pile.includes('nyati:before-restore') && pile.includes('addPileRow()'),
    'pile-quality-form.html must add rows on nyati:before-restore, or rows past the 18th have nowhere to land');
});
