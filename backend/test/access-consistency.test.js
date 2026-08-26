/*
  test/access-consistency.test.js — proves auth.js's own copy of the role
  access rules hasn't drifted from forms/access-registry.js (the backend's
  actual source of truth, re-exported by config/formAccess.js,
  config/kpiAccess.js and config/commercialAccess.js).

  auth.js is a plain global script loaded on ~27 pages with no build step
  and no module loader, so it can't require() access-registry.js the way
  the backend does without adding a new mandatory <script> tag to every
  page — real regression risk with no live browser available to verify
  it. Instead auth.js keeps its own literal copies of these three maps,
  and this test is the guardrail: it statically extracts the relevant
  object literals from auth.js's source (never executes the file — it
  has browser-only code) and diffs them against the registry. This is
  exactly the check that would have caught the 2026-08-19 admin/
  management KPI-edit-rights mismatch automatically instead of by a
  manual audit.

  Pure static check: no server, no Postgres, no browser.
  Usage: node --test test/access-consistency.test.js   (from backend/)
*/
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const { FORM_ACCESS, KPI_EDIT_DEPTS, COMMERCIAL_VIEW_ROLES, PURCHASE_VIEW_ROLES } =
  require(path.join('..', '..', 'forms', 'access-registry.js'));

const AUTH_JS_PATH = path.join(__dirname, '..', '..', 'auth.js');
const authSrc = fs.readFileSync(AUTH_JS_PATH, 'utf8');

/* Extracts the balanced {...} object literal that starts right after
   `marker` in `source` — comment/string-aware, so a brace inside a
   comment or a quoted string never miscounts the depth. Returns the
   literal text (including the outer braces), or throws if unbalanced. */
function extractBalancedObject(source, marker) {
  const markerIdx = source.indexOf(marker);
  if (markerIdx === -1) throw new Error(`marker not found in auth.js: ${marker}`);
  const start = source.indexOf('{', markerIdx);
  if (start === -1) throw new Error(`no "{" after marker: ${marker}`);

  let depth = 0, i = start, state = 'normal';
  for (; i < source.length; i++) {
    const c = source[i], c2 = source[i + 1];
    if (state === 'normal') {
      if (c === '/' && c2 === '/') { state = 'line-comment'; i++; continue; }
      if (c === '/' && c2 === '*') { state = 'block-comment'; i++; continue; }
      if (c === "'") { state = 'sq-string'; continue; }
      if (c === '"') { state = 'dq-string'; continue; }
      if (c === '`') { state = 'template-string'; continue; }
      if (c === '{') depth++;
      if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    } else if (state === 'line-comment') {
      if (c === '\n') state = 'normal';
    } else if (state === 'block-comment') {
      if (c === '*' && c2 === '/') { state = 'normal'; i++; }
    } else if (state === 'sq-string') {
      if (c === '\\') i++;
      else if (c === "'") state = 'normal';
    } else if (state === 'dq-string') {
      if (c === '\\') i++;
      else if (c === '"') state = 'normal';
    } else if (state === 'template-string') {
      if (c === '\\') i++;
      else if (c === '`') state = 'normal';
    }
  }
  if (depth !== 0) throw new Error(`unbalanced braces extracting: ${marker}`);
  return source.slice(start, i);
}

function extractObjectLiteral(source, marker) {
  const text = extractBalancedObject(source, marker);
  // eslint-disable-next-line no-new-func
  return new Function('return (' + text + ')')();
}

test("auth.js's _FORM_TYPE_ACCESS matches forms/access-registry.js's FORM_ACCESS", () => {
  const authFormAccess = extractObjectLiteral(authSrc, 'const _FORM_TYPE_ACCESS');
  assert.deepEqual(authFormAccess, FORM_ACCESS,
    'auth.js\'s _FORM_TYPE_ACCESS has drifted from forms/access-registry.js\'s FORM_ACCESS — ' +
    'update whichever one is stale (they must describe the same rule).');
});

test("auth.js's PERMISSIONS[role].kpi.editDepts matches forms/access-registry.js's KPI_EDIT_DEPTS, for every role", () => {
  const permissions = extractObjectLiteral(authSrc, 'const PERMISSIONS');
  const mismatches = [];
  for (const role of Object.keys(KPI_EDIT_DEPTS)) {
    const authValue = permissions[role] && permissions[role].kpi && permissions[role].kpi.editDepts;
    const registryValue = KPI_EDIT_DEPTS[role];
    if (JSON.stringify(authValue) !== JSON.stringify(registryValue)) {
      mismatches.push(`${role}: auth.js has ${JSON.stringify(authValue)}, registry has ${JSON.stringify(registryValue)}`);
    }
  }
  assert.equal(mismatches.length, 0, mismatches.join('\n  '));
});

test("auth.js's PERMISSIONS[role].commercial.sales matches forms/access-registry.js's COMMERCIAL_VIEW_ROLES, for every role", () => {
  const permissions = extractObjectLiteral(authSrc, 'const PERMISSIONS');
  const mismatches = [];
  for (const role of Object.keys(permissions)) {
    const authCanView = !!(permissions[role].commercial && permissions[role].commercial.sales);
    const registryCanView = COMMERCIAL_VIEW_ROLES.includes(role);
    if (authCanView !== registryCanView) {
      mismatches.push(`${role}: auth.js commercial.sales=${JSON.stringify(permissions[role].commercial && permissions[role].commercial.sales)} (canView=${authCanView}), registry canView=${registryCanView}`);
    }
  }
  assert.equal(mismatches.length, 0, mismatches.join('\n  '));
});

test("auth.js's PERMISSIONS[role].commercial.purchase matches forms/access-registry.js's PURCHASE_VIEW_ROLES, for every role", () => {
  const permissions = extractObjectLiteral(authSrc, 'const PERMISSIONS');
  const mismatches = [];
  for (const role of Object.keys(permissions)) {
    const authCanView = !!(permissions[role].commercial && permissions[role].commercial.purchase);
    const registryCanView = PURCHASE_VIEW_ROLES.includes(role);
    if (authCanView !== registryCanView) {
      mismatches.push(`${role}: auth.js commercial.purchase=${JSON.stringify(permissions[role].commercial && permissions[role].commercial.purchase)} (canView=${authCanView}), registry canView=${registryCanView}`);
    }
  }
  assert.equal(mismatches.length, 0, mismatches.join('\n  '));
});
