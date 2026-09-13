# RACI Matrix — Lake Cement Dashboard

Kept to the real, small set of parties actually involved — no invented org
chart. Names in **bold-italic placeholders** need confirming with the user
(asked via `AskUserQuestion` during the first `audit` run); do not guess
them.

## Parties

| Role | Who | Notes |
|---|---|---|
| You | razakmbaga3@gmail.com | Sole developer, de facto PM/Tech Lead |
| Plant Head | _pending confirmation_ | Real authority behind `docs/ACCESS_MODEL.md`'s adoption |
| Managing Director (MD) | _pending confirmation_ | Real authority behind the cloud-hosting pivot (`docs/TECHNICAL_SPEC.md` §10) |
| Odoo Team | (contact: `teckzilla007` per TECHNICAL_SPEC) | External party — owns hosting infra + Odoo credentials/data |
| Department HODs | Production, Power Plant/CPP, Mechanical/PM, Mining, Stores, E&I, Packing, Sales, Purchase | Data owners for their own numbers, per `docs/ACCESS_MODEL.md` |

## Matrix

R = Responsible, A = Accountable, C = Consulted, I = Informed

| Activity | You | Plant Head | MD | Odoo Team | Dept HODs |
|---|---|---|---|---|---|
| Code/architecture change | R,A | I (if user-facing) | — | — | — |
| KPI formula change | R,A | I | C (headline KPIs) | — | C (verify against their reality) |
| UI/UX redesign | R,A | C (plant-floor usability) | — | — | — |
| Security change | R,A | — | I | C (if hosting/network) | — |
| Deployment / go-live cutover | R | I | **A** | C | I |
| Access/RBAC policy change | R | **A** | I | — | C |
| Data-accuracy dispute | R,A | I | — | — | C (disputed dept) |

---

_Placeholders for Plant Head and MD names are asked for during the first
`audit` run and recorded here once confirmed — never guessed._
