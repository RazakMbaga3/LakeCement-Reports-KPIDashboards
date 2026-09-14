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

## In Progress — wave 1

- [ ] **[WBS-SEC-5]** Close the forgot-password address oracle (RAID R-7) — `security-performance-auditor`. *Holds the e2e sandbox.*
- [ ] **[WBS-DATA-5]** Make `odoo:test` report per-connector health (RAID I-6) — `kpi-data-analyst`. *No server, no sandbox.*

## To Do — wave 2 (no sandbox needed, safe to run together)

- [ ] [WBS-CODE-3] Add `audit_log` writes to `sales.js POST /targets` and `quarry.js POST /tickets/import` (RAID I-9)
- [ ] [WBS-CODE-1] Clear the 2 standing lint warnings (RAID R-5)
- [ ] [WBS-UI-3] Clear `tbody.innerHTML` in `approvals.html`'s empty state (RAID I-12)

## To Do — wave 3 (needs the sandbox exclusively)

- [ ] [WBS-UI-1] Re-run the four UI audit scripts and record real numbers — first measurement since the outage
- [ ] [WBS-DEPLOY-2] Set `BACKUP_DIR`, run one backup + one `restore:drill`, record evidence (RAID I-7) — **needs a decision from you: where backups should live on this machine**

## Blocked

- [ ] [WBS-SEC-4] Email delivery — blocked on IT enabling SMTP AUTH for the tenant (RAID R-6)
- [ ] [WBS-SEC-1] Verify/rotate `openpg` password — blocked on live DB access (RAID R-4)
- [ ] [WBS-SEC-2] Set `DIGEST_TO`/`ALERT_TO` — blocked on Management naming recipients (RAID D-2)
- [ ] [WBS-DATA-3] Odoo onto the production instance — blocked on Odoo Team (RAID R-1)
- [ ] [WBS-DATA-4] Purchases field names, unstub `fetchCategoryGrid()` — blocked on Odoo Team (RAID D-1)
- [ ] [WBS-QA-1] Wire e2e + the three audits into CI — deliberately sequenced after WBS-UI-1 confirms they pass locally; wiring a red gate into CI only blocks deploys

## Backlog

- [ ] [WBS-DATA-2] Quality KPI multi-month validation — build `verify-quality.py` (RAID I-2) — **needs the source Excel from you**
- [ ] [WBS-UI-2] Style `.kt-val.is-empty` on `daily-report.html` (RAID I-8)
- [ ] [WBS-SEC-3] Silence `dotenv`'s promotional log banners (RAID I-11)
- [ ] [WBS-DEPLOY-1] Refresh RUNBOOK/GO_LIVE banners; fix `DEPLOYMENT_DIGITALOCEAN.md:267` (RAID I-1, I-10)
- [ ] [WBS-DATA-1] Stoppage report deferred items — insights UI page, cost-of-stoppage (needs Finance TZS/hr rate), EN/SW labels

## Done (recent)

- [x] **[WBS-CODE-2] Restore backend boot — `power-cons` approval ownership** — validated 2026-09-13 (`smoke` OK, `access:matrix` shows `power-cons → ei APPR`). Decision: DEC-003
- [x] **[WBS-QA-2] Test the single-owner invariant** — validated 2026-09-13 (`test:approval` 5/5, incl. proof the guard still throws on an undeclared overlap)
- [x] **[WBS-QA-3] Re-run the gate table, populate DoD with real evidence** — validated 2026-09-13 (160 acceptance checks pass, 3 fail; all 3 traced to RAID R-6, not to this code)
