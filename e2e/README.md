# End-to-end harness

Drives the real dashboard in a real browser against the real Postgres, and
asserts that every figure on screen came from the API.

```bash
cd e2e
npm install
npx playwright install chromium   # once
npm test                          # everything
npm run test:kpi                  # just the KPI dashboard + write paths
npm run test:roles                # just the role matrix
npm run report                    # open the HTML report of the last run
```

`playwright.config.js` boots both servers itself:

| port | process | why |
|------|---------|-----|
| 5000 | `backend/server.js` | the real API against the real database |
| 3000 | `preview-server.js`  | the static frontend (nginx's job in production) |

The frontend **must** be served from `localhost:3000` — `auth.js` only points
`_API_BASE` at localhost when the page itself came from a localhost origin, so
opening the HTML over `file://` would silently target the production API.

## What it will and won't touch in your database

It creates its own accounts and its own sandbox, and removes both:

- **Accounts** — one `e2e_<role>` user per role in `fixtures/roles.js`, created
  in `global-setup.js`, dropped in `global-teardown.js`. The seeded staff
  accounts are never used: most still carry `must_change_password = true`
  (which 403s every non-auth route), and several have had their real password
  changed by the people using them.
- **Writes** — two sandboxes, both far outside any real record: **year 2001**
  for `kpi_monthly` (valid per `routes/kpi.js`'s `zYear`, min 2000) and
  **1999 dates** for `daily_reports`. Teardown clears both.
- **Incidental writes** — teardown also removes anything a harness account
  authored anywhere, because a test does not only write where it means to:
  merely opening `mines-report.html` persists a month-config record (it seeds
  April 2026 opening stocks the first time it finds none). Nothing a real
  person does is ever attributed to an `e2e_*` account, so those rows are
  test artifacts by definition.

Nothing else is written. If a run is killed mid-way, re-running it cleans up
(`global-setup.js` clears the sandbox before it starts).

**Run one suite at a time.** Setup and teardown share one set of `e2e_*`
accounts and one year-2001 sandbox, so a second concurrent run will have its
accounts deleted out from under it by the first run's teardown — every test
after that point fails with a login error that has nothing to do with the code.

`AUTH_RATE_LIMIT` is raised to 1000 for the servers Playwright starts, so a
suite run never depends on request order. The per-account lockout — the control
that actually stops password guessing — is untouched and is asserted directly
in `tests/roles.spec.js`.

## The specs

| file | covers |
|------|--------|
| `tests/kpi-dashboard.spec.js` | index.html: no fabricated figures, every row reaches a defensible verdict, stored data reaches the screen, Concerns chips match the formula engine |
| `tests/kpi-write.spec.js` | the modal and inline-cell write paths: round-trip, remarks, explicit clear, transaction integrity, audit trail, per-department authorisation, offline warning |
| `tests/standalone-pages.spec.js` | analytics / completeness / balance / insights / reliability: clean load, real content, stale-data fallback, no stale charts |
| `tests/roles.spec.js` | all 16 roles: sidebar contents, Fill-button visibility, `switchDept()` refusal, override authorisation, account lockout, no rate-limiting of ordinary browsing |
| `tests/daily-reports.spec.js` | the submission pipeline: partial payloads merge, `replace:true` still overwrites, drafts stay drafts, HOD self-certification, per-department authorisation, drafts and rejected reports stop counting as data, the approvals queue |
| `tests/daily-forms-ui.spec.js` | all 11 form pages load clean for their owning role, view-only roles get the banner, forms open on the local date, and the four report states (draft / awaiting sign-off / approved / rejected) each render and lock correctly |

## Adding a spec for the next section

`fixtures/auth.js` gives you `loginAs(page, role)` and `collectErrors(page)` —
`role` may carry a level suffix (`production` is the HOD, `production_officer`
the same role at level `officer`, which is what the approval workflow needs);
`fixtures/db.js` gives you a pool for asserting what actually landed in
Postgres. Keep writes inside the year-2001 sandbox, or add a teardown for
whatever new table you touch.
