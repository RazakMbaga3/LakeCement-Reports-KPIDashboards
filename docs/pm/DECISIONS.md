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

---

_Further decisions (RACI names confirmed, WBS priority calls, DoD criteria
changes) get appended here as they're made, starting with the outcomes of
the first `audit` run._
