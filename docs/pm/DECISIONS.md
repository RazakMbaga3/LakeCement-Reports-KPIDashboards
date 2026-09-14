# Decision Log — Lake Cement Dashboard

Append-only. Never edit or delete a past entry — a reversal is a new entry
that links back to the one it reverses. This is the single source of truth
for *why* things are the way they are, so a new session or a new person can
catch up fast without re-deriving history. Written only via the
`project-manager` skill's `decide` mode.

## Format

```
### DEC-### — <short title>
**Date:** <date>
**Decider (RACI Accountable):** <role/person>
**Context:** <what prompted this>
**Options considered:** <brief>
**Decision:** <what was decided>
**Consequences:** <what this changes — DoD/WBS/RACI cross-references>
```

---

### DEC-001 — Adopt cloud hosting via the Odoo team's DigitalOcean infrastructure
**Date:** (per `docs/TECHNICAL_SPEC.md` §10, date as recorded there)
**Decider (RACI Accountable):** Managing Director
**Context:** Original plan (`docs/RUNBOOK.md`) was an on-prem plant-LAN
Windows server deployment.
**Options considered:** On-prem Windows server vs. cloud hosting under the
Odoo team.
**Decision:** Production hosting moved to cloud infrastructure managed by
the Odoo team; `docs/RUNBOOK.md` superseded (banner added), `docs/
DEPLOYMENT_DIGITALOCEAN.md` is now the live deployment guide.
**Consequences:** `WBS-DEPLOY-1` (RUNBOOK rewrite) is low priority while the
banner points to `TECHNICAL_SPEC.md`; `deployment-engineer` treats
`RUNBOOK.md`/`GO_LIVE_CHECKLIST.md` as reference only.

### DEC-002 — Adopt this project-management system as the live source of truth
**Date:** 2026-09-13
**Decider (RACI Accountable):** You (razakmbaga3@gmail.com)
**Context:** Project status was scattered across `docs/PROGRESS.md`,
`docs/TECHNICAL_SPEC.md`, and session memory — static and going stale.
Requested a standing PM/tech-lead/QA-lead system built on Claude Code's real
primitives (a skill + specialist subagents), auditing what's really built
rather than starting over.
**Options considered:** Keep updating `docs/PROGRESS.md` manually vs. build
a structured, evidence-gated system (`docs/pm/` + `.claude/skills/
project-manager` + six specialist agents).
**Decision:** Built the system described in `.claude/skills/
project-manager/SKILL.md`. `docs/PROGRESS.md` superseded (banner added,
kept as seed evidence) by `docs/pm/PROJECT_STATE.md`.
**Consequences:** All future status/DoD/RAID/RACI/schedule tracking happens
in `docs/pm/`; nothing is marked Done without a `validate`-mode evidence
citation.

### DEC-003 — E&I's HOD approves Power Consumption; approval ownership becomes explicit
**Date:** 2026-09-13
**Decider (RACI Accountable):** You (razakmbaga3@gmail.com), on behalf of the Plant Head — access/RBAC policy is Accountable to the Plant Head per [`RACI.md`](RACI.md), so this should be confirmed with them.
**Context:** Commit `fa3d5ae` (2026-09-11) gave E&I submit rights on `power-cons` while P&M still held them. `middleware/approval.js` derives exactly one approving role per form type from the submit map and throws at module load on an overlap — so the backend stopped booting entirely (RAID I-3). Nine of ten acceptance suites, `access:matrix` and the whole e2e suite were blocked, while all ten unit suites still passed green.
**Options considered:** (a) P&M HOD approves, E&I submit-only; (b) **E&I HOD approves, P&M keeps submit**; (c) revert `fa3d5ae` and take E&I's access away again.
**Decision:** (b). Both departments keep submit rights; **E&I's HOD approves**, since E&I owns the kWh/meter readings being signed off. Approval ownership is now declared explicitly in `FORM_APPROVAL_OWNER` (`forms/access-registry.js`) rather than inferred from who can submit.
**Consequences:** Submitting and approving are now separate concepts in the access model. `approval.js` still throws on an *undeclared* overlap — the guard is intact, not removed, and `backend/test/approval-owner.test.js` proves it still fires. `docs/ACCESS_MODEL.md` updated, since it previously documented a single-owner model with no exception. Closes RAID I-3, I-4, I-5.

### DEC-004 — Packing Plant may submit Dispatch & SO; Logistics still approves it
**Date:** 2026-09-14
**Decider (RACI Accountable):** You (razakmbaga3@gmail.com), on behalf of the Plant Head — access/RBAC policy is Accountable to the Plant Head per [`RACI.md`](RACI.md), so this should be confirmed with them.
**Context:** Packing Plant reported that the Dispatch & SO report (`forms/dispatch-form.html`) is the report they actually fill each day, but `dispatch` was owned solely by `logistics` in `FORM_ACCESS`, so the form was permanently view-only for them and never appeared in their Daily Reports nav. Same shape as DEC-003, and the second shared form type in the system.
**Options considered:** (a) **Packing submits, Logistics keeps submit + approval**; (b) Packing submits and Packing's HOD approves, moving sign-off off Logistics; (c) transfer `dispatch` to `packing` outright, taking it from Logistics.
**Decision:** (a). `packing` gains `dispatch` submit rights and the form in its nav; `logistics` keeps submit rights and remains the approver, declared in `FORM_APPROVAL_OWNER`. The ask was to let Packing *fill* the report, not to move sign-off, so no existing right is removed — and it leaves the author in one department and the approver in another, which is the Separation-of-Duties rule the access model already states. (b) is a one-line change to `FORM_APPROVAL_OWNER` if the Plant Head wants sign-off to follow the data.
**Consequences:** `dispatch` is now a shared form type, so the `approval.js` boot guard required a declared approver — supplied, and covered by a new assertion in `backend/test/approval-owner.test.js` so it can't regress the way DEC-003's overlap did. `GET /api/approvals` now scopes an HOD's queue by **who approves** (`OWNING_ROLE_BY_FORM_TYPE`) rather than by who may submit; it previously listed by submit rights, which since 2026-09-11 had been showing P&M's HOD `power-cons` reports that `requireApprover` 403s, and would have done the same to Packing's HOD for `dispatch`.

---

_Further decisions (RACI names confirmed, WBS priority calls, DoD criteria
changes) get appended here as they're made._
