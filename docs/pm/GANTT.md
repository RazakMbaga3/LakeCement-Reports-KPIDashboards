# Schedule — Lake Cement Dashboard

Maintained by the `project-manager` skill's `plan-next-phase` mode. Tasks
reference `WBS.md` IDs; `crit` marks the critical path. GitHub renders this
Mermaid block natively.

**Set 2026-09-13 from the first full audit.** Durations are working
estimates for a solo developer, not commitments. The recovery cluster is
short — the P0 fix itself is small; what gates it is a decision, not effort.

```mermaid
gantt
    title Lake Cement Dashboard — Path to Verifiable Green
    dateFormat  YYYY-MM-DD
    axisFormat  %b %d

    section Recovery (critical path)
    Decide power-cons approver (you)          :crit, milestone, dec, 2026-09-15, 0d
    WBS-CODE-2 Restore backend boot           :crit, code2, after dec, 1d
    WBS-QA-2 Test the single-owner invariant  :crit, qa2, after code2, 1d
    WBS-QA-3 Re-run full gate table, fill DoD :crit, qa3, after qa2, 1d
    Backend verifiably green                  :crit, milestone, green, after qa3, 0d

    section Then measurable again
    WBS-UI-1 Close design-audit items         :ui1, after green, 4d
    WBS-QA-1 Wire e2e + audits into CI        :qa1, after green, 3d

    section Data
    WBS-DATA-2 Quality KPI validation         :data2, after green, 4d
    WBS-DATA-5 Fix odoo:test reporting        :data5, after green, 1d
    WBS-DATA-3 Odoo onto production instance  :data3, 2026-09-15, 1d

    section Ops / Security
    WBS-DEPLOY-2 Backup + restore drill       :deploy2, after green, 1d
    WBS-SEC-1 Verify/rotate openpg password   :crit, sec1, 2026-09-15, 1d
    WBS-SEC-2 Set DIGEST_TO recipients        :sec2, 2026-09-15, 1d
    WBS-DEPLOY-1 Refresh runbook + banners    :deploy1, after deploy2, 2d

    section Milestones
    Go-Live Cutover Ready                     :milestone, golive, after data3, 0d
```

## Reading this honestly

- **The critical path starts with a decision, not a task.** `WBS-CODE-2`
  cannot start until you answer who approves power-cons. Everything in
  "Then measurable again" is gated on it, because those gates literally
  cannot execute against a server that won't boot.
- **Three bars are not really yours to schedule.** `WBS-DATA-3` (production
  Odoo), `WBS-SEC-2` (digest recipients) and, in practice, `WBS-SEC-1`
  (`openpg` rotation) are owned outside this repo — they're drawn as 1-day
  tasks on their raise date because the work *here* is small; the waiting is
  the real duration, and that's tracked in `RAID_LOG.md`, not padded into
  this chart.
- **Go-Live Cutover Ready** depends on the production-Odoo item, so it
  cannot be dated from inside this repo. Treat it as a milestone with a
  dependency, not a date.
