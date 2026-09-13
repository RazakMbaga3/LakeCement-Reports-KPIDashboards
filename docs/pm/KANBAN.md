# Kanban — Lake Cement Dashboard

Markdown checklist columns — the same `[x]`/`[ ]` idiom `docs/PROGRESS.md`
already used, renders on GitHub with no tooling, diffable in commits. Cards
cite a `WBS.md` ID. Maintained by the `project-manager` skill's
`plan-next-phase` and `validate` modes. `Done` is pruned each planning pass;
history lives in `DEFINITION_OF_DONE.md` and git log.

**Updated 2026-09-13** from the first full audit.

## In Progress

- [ ] **[WBS-CODE-2] Restore backend boot — `power-cons` dual ownership** 🔴 **P0**
      *Awaiting your decision: who approves power-cons, P&M HOD or E&I HOD?*
      (RAID I-3 · blocks WBS-QA-1, QA-2, QA-3, UI-1, and all DoD verification)

## To Do

- [ ] [WBS-QA-2] Unit-test the single-owner invariant in `approval.js` (RAID I-5) — do this *with* the CODE-2 fix so the outage can't recur silently
- [ ] [WBS-DEPLOY-2] Set `BACKUP_DIR`, run one backup + one `restore:drill`, record evidence (RAID I-7)
- [ ] [WBS-CODE-3] Add `audit_log` writes to `sales.js POST /targets` + `quarry.js POST /tickets/import` (RAID I-9)
- [ ] [WBS-DATA-5] Fix or retire `npm run odoo:test` so it reports per-connector health (RAID I-6)

## Blocked

- [ ] [WBS-QA-3] Re-run the full gate table, populate DoD with real evidence — blocked by WBS-CODE-2 (RAID I-4)
- [ ] [WBS-UI-1] Close remaining `DESIGN_AUDIT_2026-09.md` items — blocked by WBS-CODE-2 (audits need a live backend)
- [ ] [WBS-QA-1] Wire e2e + the three audits into CI — blocked by WBS-CODE-2
- [ ] [WBS-SEC-1] Verify/rotate `openpg` password — blocked on live DB access (RAID R-4)
- [ ] [WBS-SEC-2] Set `DIGEST_TO`/`ALERT_TO` — blocked on Management naming recipients (RAID D-2)
- [ ] [WBS-DATA-3] Odoo onto the production instance — blocked on Odoo Team (RAID R-1)
- [ ] [WBS-DATA-4] Purchases field names, unstub `fetchCategoryGrid()` — blocked on Odoo Team (RAID D-1)

## Backlog

- [ ] [WBS-DATA-2] Quality KPI multi-month validation — build `verify-quality.py` (RAID I-2)
- [ ] [WBS-UI-2] Style `.kt-val.is-empty` on `daily-report.html` (RAID I-8)
- [ ] [WBS-SEC-3] Silence `dotenv`'s promotional log banners (RAID I-11)
- [ ] [WBS-DEPLOY-1] Refresh RUNBOOK/GO_LIVE banners; fix `DEPLOYMENT_DIGITALOCEAN.md:267` (RAID I-1, I-10)
- [ ] [WBS-CODE-1] Clear the 2 standing lint warnings (RAID R-5)
- [ ] [WBS-DATA-1] Stoppage report deferred items — insights UI page, cost-of-stoppage (needs Finance TZS/hr rate), EN/SW labels

## Done (recent)

_(empty — nothing has passed a `validate` gate under this system yet. The
gates cannot run while WBS-CODE-2 is open, and a stale historical green does
not count as evidence.)_
