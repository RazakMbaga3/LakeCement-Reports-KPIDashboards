# Kanban — Lake Cement Dashboard

Markdown checklist columns — the same `[x]`/`[ ]` idiom `docs/PROGRESS.md`
already used, renders on GitHub with no tooling, diffable in commits. Cards
cite a `WBS.md` ID. Maintained by the `project-manager` skill's
`plan-next-phase` and `validate` modes. `Done` is pruned each planning pass;
history lives in `DEFINITION_OF_DONE.md` and git log.

**Planned 2026-09-14** (`plan-next-phase`). Work is sequenced in waves
because the e2e harness is single-tenant — shared `e2e_<role>` accounts and
fixed sandbox years (2001 / 1999) mean two suites running at once interfere
and produce false failures. Only one agent holds the sandbox at a time.

## Planned 2026-10-15 — completing the Production report & Daily MIS from Odoo

Unlocked by the read-only Odoo database login (verified 2026-10-15; shared
connector `backend/services/odooDb.js`, committed). Order: build → validate →
connect the server → people actions → next data streams.

**Built and pushed 2026-10-16** (backend `npm test`: 37 suites, 452 assertions, 0 failed; eslint clean; smoke OK — run on the full tree before commit):
- [x] [WBS-DATA-7] Crusher TPH on apron-feeder hours (403616f) — live via the production_report feed; history needs `node scripts/odoo-crusher-apron-backfill.js 2026-04-01 <today>` on the droplet
- [x] [WBS-DATA-8] CPP autofill + overburden + Quarry page (ad54dd3) — needs WBS-DEPLOY-3 on the droplet
- [x] [WBS-DATA-9] Stock ledgers + Coal for CPP + MIS stock/mining lines (e9fe1ea) — needs WBS-DEPLOY-3; until then the MIS stock lines from 1 Jul say "not connected"
- [x] [WBS-DATA-10] Power row copied from the Power Consumption form (b236356) — live; idle until Electrical resumes entry
- [ ] Security + load review of the new pulls — dispatched 2026-10-16, result pending; apply its fixes before WBS-DEPLOY-3

**To Do — next, in order:**
- [ ] [WBS-QA] Validation gate on the four: full `npm test`, `accept:odoo-production-autofill`, scoped e2e on daily forms (one suite at a time), page check of Production report / Daily MIS / Quarry / CPP pages
- [ ] [WBS-SEC] Security + load review of `odooDb.js` and the new pulls (`security-performance-auditor`) — live ERP, measure query time and memory before scheduling (lesson of I-32)
- [ ] Commit in reviewed, self-contained commits; push to `main` (auto-deploys; new pulls are inert on the droplet until WBS-DEPLOY-3)
- [ ] [WBS-DEPLOY-3] Droplet → Odoo DB (blocked on I-60)

**Waiting on people:**
- [ ] I-60 Odoo admin: narrower login, firewall, revoke CREATE (owner: Razak → Odoo team)
- [ ] I-61 Production/Stores: limestone rule, clay source, approve 7 stuck Odoo entries, confirm clinker stock
- [ ] I-62 Electrical: resume Power Consumption entry, catch up Jul–Oct
- [ ] Plant head: told that crusher TPH now uses apron-feeder hours (~15–20% higher than the old report)

**Next data streams (after the above):**
- [ ] [WBS-DATA-11] Quality from Odoo lab entries
- [ ] [WBS-DATA-12] Packing-plant stoppages from Odoo
- [ ] [WBS-DATA-13] Quarry stockyard stock

## In Progress

_Nothing in flight. The overnight run of 2026-09-14/15 cleared wave 1 and 2
and most of the backlog; everything below is either waiting on someone, or
waiting on a decision about how to land it._

**All work described as Done below is sitting in the working tree, NOT
committed.** Claude was not asked to commit, and another session pushed
straight to `main` mid-run that night (which auto-deploys), so nothing was
landed unilaterally. Review `git status`, then commit.

## To Do — next

- [ ] [WBS-QA-1] Wire e2e + the audits into CI. **Now unblocked** — the gate
      condition was "audits pass locally", and on 2026-09-15 responsive
      (72/72) and a11y (0 violations) passed. Perf and design-consistency
      exit 1 by design, so wire those two as reporting-only, not as gates.
      Needs a push to verify, and a push deploys — so do it with a human watching
- [ ] [WBS-DATA-6] Make `GET /api/quarry/tickets` stop returning every row
      (RAID I-19) — needs a data-model decision: MTD/YTD must move server-side,
      since the page computes fiscal-year YTD client-side and a cap would
      silently corrupt it
- [ ] [WBS-UI-4] Fix the design audit's false positives (RAID I-20) — compare
      declared not computed values; exclude state classes from drift grouping
- [ ] [WBS-DEPLOY-2] Set `BACKUP_DIR`, run one backup + one `restore:drill`
      (RAID I-7) — **needs a decision from you: where backups live on this machine**

## Blocked

- [ ] [WBS-SEC-4] Email delivery — blocked on IT enabling SMTP AUTH for the tenant (RAID R-6)
- [ ] [WBS-SEC-1] Verify/rotate `openpg` password — blocked on live DB access (RAID R-4)
- [ ] [WBS-SEC-2] Set `DIGEST_TO`/`ALERT_TO` — blocked on Management naming recipients (RAID D-2)
- [ ] [WBS-DATA-3] Odoo onto the production instance — blocked on Odoo Team (RAID R-1) — partly unblocked 2026-09-20: production, sales, purchases live on production; dispatch and mining still test-only
- [ ] [WBS-DATA-4] Purchases field names, unstub `fetchCategoryGrid()` — blocked on Odoo Team (RAID D-1)

## Backlog

- [ ] [WBS-DATA-2] Quality KPI multi-month validation — build `verify-quality.py` (RAID I-2) — **needs the source Excel from you**
- [ ] [WBS-DATA-1] Stoppage report deferred items — insights UI page, cost-of-stoppage (needs Finance TZS/hr rate), EN/SW labels

## Done — earlier (validated 2026-09-13)

- [x] **[WBS-CODE-2] Restore backend boot — `power-cons` approval ownership** — validated 2026-09-13 (`smoke` OK, `access:matrix` shows `power-cons → ei APPR`). Decision: DEC-003
- [x] **[WBS-QA-2] Test the single-owner invariant** — validated 2026-09-13 (`test:approval` 5/5, incl. proof the guard still throws on an undeclared overlap)
- [x] **[WBS-QA-3] Re-run the gate table, populate DoD with real evidence** — validated 2026-09-13 (160 acceptance checks pass, 3 fail; all 3 traced to RAID R-6, not to this code)

## Done — overnight 2026-09-14/15 (in tree, uncommitted)

- [x] **[WBS-SEC-5]** forgot-password oracle (RAID R-7) — the committed fix closed
      only the status/body half; a ~100x **timing** oracle remained (~1.9s known vs
      ~20ms unknown). Now equal: delta -0.037ms over 200 iterations
- [x] **[WBS-CODE-5]** Invite resend no longer destroys a valid invite link (RAID I-15)
- [x] **[WBS-QA-4]** Regression test for the non-throwing `sendMail` contract (RAID I-16) — 4/4, wired into `npm test`
- [x] **[WBS-CODE-4]** Log rotation actually rotates, with a 10MB cap (RAID I-13) — one file had held 71 days / 26MB / 433 boots
- [x] **[WBS-CODE-3]** `audit_log` writes on sales targets + quarry import (RAID I-9)
- [x] **[WBS-CODE-1]** 2 lint warnings cleared (RAID R-5) — `eslint .` at zero
- [x] **[WBS-SEC-3]** dotenv banners silenced via one `config/env.js` (RAID I-11) — also fixed scripts run from the repo root silently loading no `.env` at all
- [x] **[WBS-CODE-6]** Dead `.catch` clauses removed from watchdog (RAID I-17)
- [x] **[WBS-UI-1]** Four audits re-run and recorded — responsive 72/72, a11y 0 violations
- [x] **[WBS-UI-3]** approvals.html empty state clears the tbody (RAID I-12)
- [x] **[WBS-UI-2]** `.kt-val.is-empty` styled (RAID I-8) — also fixed on power-plant-report.html
- [x] **[WBS-DEPLOY-1]** RUNBOOK/GO_LIVE banners refreshed; `DEPLOYMENT_DIGITALOCEAN.md` §3 rewritten against the real workflow (RAID I-1, I-10, I-14)
