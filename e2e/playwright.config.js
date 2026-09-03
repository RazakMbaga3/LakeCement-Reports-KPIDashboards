/*
  Playwright config — boots BOTH servers the app needs:

    :5000  backend/server.js      the real Express API against the real Postgres
    :3000  preview-server.js      the static frontend (nginx's job in production)

  auth.js only points _API_BASE at localhost when the PAGE ITSELF is served
  from a localhost origin, so the frontend must come from :3000 — opening the
  HTML over file:// would silently target the production API instead.

  Serial, single worker: every spec talks to one shared Postgres, and the
  write specs assert exact row counts. Parallel workers would interleave.
*/
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

module.exports = defineConfig({
  testDir: './tests',
  globalSetup: require.resolve('./global-setup.js'),
  globalTeardown: require.resolve('./global-teardown.js'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node server.js',
      cwd: path.join(ROOT, 'backend'),
      url: 'http://localhost:5000/api/health',
      /* 16 role logins is over the 30-per-5-minutes credential limit, so the
         harness raises it. It no longer needs to: the limiter is now scoped
         to /login and /change-password (server.js), not to every page's GET
         /api/auth/me — but a suite run should never fail on request ORDER, and
         a developer reusing an already-running server should not have to
         remember this. The per-account lockout, which is what actually stops
         password guessing, is untouched and asserted in roles.spec.js. */
      env: { ...process.env, AUTH_RATE_LIMIT: '1000' },
      reuseExistingServer: true,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'node preview-server.js',
      cwd: ROOT,
      url: 'http://localhost:3000/login.html',
      reuseExistingServer: true,
      timeout: 30_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
