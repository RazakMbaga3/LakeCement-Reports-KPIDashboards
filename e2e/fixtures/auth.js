/*
  loginAs(page, role) — authenticates through auth.js's OWN login() function.

  Calling the real function (rather than injecting a hand-made token) means the
  harness exercises the same POST /api/auth/login, the same sessionStorage
  shape and the same _getPerms() lookup the browser uses, so a change to any of
  those breaks the tests instead of silently bypassing them. Typing into
  login.html for all 16 roles × 6 pages would add minutes per run for no extra
  coverage — loginViaForm() below covers the form itself, once.
*/
const { E2E_PASSWORD, username } = require('./roles');

/* Any page in the app loads auth.js; login.html is the cheapest one that
   never redirects an unauthenticated visitor away. */
/* `role` may carry a level suffix — 'production' is the HOD, and
   'production_officer' the same role at level 'officer'. Both are real
   accounts created by global-setup.js. */
async function loginAs(page, role) {
  await page.goto('/login.html');
  const result = await page.evaluate(
    ([u, p]) => window.login(u, p),
    ['e2e_' + role, E2E_PASSWORD]
  );
  if (!result || !result.ok) {
    throw new Error(`e2e login failed for role "${role}": ${result && result.error}`);
  }
  if (result.mustChangePassword) {
    throw new Error(`e2e account for "${role}" was created with must_change_password set`);
  }
  return result;
}

/* The real form path — one role is enough to prove login.html itself works. */
async function loginViaForm(page, role) {
  await page.goto('/login.html');
  await page.fill('#username', username(role));
  await page.fill('#password', E2E_PASSWORD);
  await page.click('button[type="submit"]');
}

/* Collects uncaught page errors and console errors for the no-noise assertions.
   Returns a getter; call it after the page has settled. */
function collectErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    /* Ignore network noise the app handles deliberately: the CDN lucide/Chart
       fetches and the api-client's own 4xx logging are not app defects. */
    if (/favicon|net::ERR_|Failed to load resource/i.test(t)) return;
    errors.push('console: ' + t);
  });
  return () => errors;
}

module.exports = { loginAs, loginViaForm, collectErrors };
