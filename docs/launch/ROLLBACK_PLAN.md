# Rollback Plan — Nyati Cement MIS

**Version:** 1.0 · **Date:** 2026-09-30

> **The premise of this document:** application rollback is easy here.
> **Database rollback is not.** Treat them as two separate decisions with
> two different risk profiles, and never assume undoing a migration is
> safe.

---

## 1. Why database rollback is the hard part

The deployment runs `npm run migrate` on every deploy
(**VERIFIED**, `deploy/deploy.sh`). There are 30 sequential migrations and
**no `down` migrations exist**. Once a migration has run:

- Reverting the application code does **not** revert the schema.
- Data written in the new schema may have no home in the old one.
- Restoring a pre-deploy backup discards **every report filed since that
  backup was taken** — which during working hours is real plant data
  somebody typed.

This is why §4 separates the two paths, and why the default for a
data-affecting problem is **fix forward, not roll back**.

---

## 2. What triggers a rollback

### Immediate rollback (no deliberation)

| Trigger | Why |
|---|---|
| Application will not start / site unreachable | Total loss of service |
| Login broken for all users | Nobody can work |
| **Any figure on a management dashboard is provably wrong** | Wrong numbers are worse than no system — decisions get made on them |
| Data loss or corruption observed | Business record integrity |
| A permission boundary has failed (a user sees another department's data) | Confidentiality breach |
| Reports can be silently overwritten | Loss of the audit trail |

### Consider rollback (assess first)

| Trigger | Assess |
|---|---|
| One module broken, rest working | Can the module be hidden instead? |
| Degraded performance | Is it usable while being fixed? |
| Odoo sync failing | Data becomes stale, not wrong — usually fix forward |
| Email not sending | Already a known open issue — never a rollback trigger |

### Never a rollback trigger

Cosmetic defects, layout problems on one screen, a single user's login
issue, a missing convenience feature, or a report that is empty **because
nobody filed it**. That last one matters: "no data" on a KPI is currently
expected for 21 of 32 KPIs and is not a software fault.

---

## 3. Who authorises

| Situation | Authoriser | Escalation |
|---|---|---|
| Total outage | **Technical owner may act immediately**, then inform | Notify Plant Head + MD within 30 min |
| Wrong figures on management dashboards | **Technical owner may act immediately** | Notify Plant Head immediately |
| Confidentiality/permission breach | **Technical owner acts immediately** | Notify Plant Head + MD + IT immediately |
| Partial functional failure | **Plant Head** decides, technical owner advises | MD if launch date is affected |
| Anything involving restoring a database backup | **Plant Head or MD must approve** — it discards user work | Must be a written decision |

**Principle:** a developer may always stop the bleeding without asking. A
developer may **never** discard other people's data without an explicit
authorisation on record.

---

## 4. Procedures

### Path A — Application-only rollback (no migration in the release)

Use when the release added no migration, or the migration is additive and
harmless to leave in place. **This is the normal path.**

The deployment is a git-reset-to-origin/main on the droplet
(**VERIFIED**, `deploy/deploy.sh`), so rollback is a revert commit through
the same gated pipeline:

```bash
# On the developer machine
git revert --no-commit <bad-commit>..HEAD
git commit -m "Revert to <last-known-good>: <one-line reason>"
git push origin main
```

CI then runs the full test + acceptance suite and, on green, deploys the
reverted state. **This keeps the test gate in the loop**, which is the
whole reason it exists.

If CI itself is the obstacle and the site is down, deploy by hand as the
`deploy` user on the droplet:

```bash
cd /home/deploy/lake-cement-dashboard
git fetch origin main
git reset --hard <last-known-good-sha>
cd backend && npm ci --omit=dev
pm2 reload /home/deploy/lake-cement-dashboard/deploy/ecosystem.config.js --update-env
```

**Note:** `npm run migrate` is deliberately omitted above — do not re-run
migrations during a rollback.

**Verify:** `curl -sS https://smr.lakecement.co.tz/api/health` →
`db.ok: true`, then log in and load one dashboard.

---

### Path B — Rollback with a schema change in the release

1. **Stop and think before touching the database.** Ask: does the old code
   actually break against the new schema? An additive migration (a new
   table, a new nullable column) usually leaves old code working fine.
2. **If old code tolerates the new schema:** do Path A only. Leave the
   schema. This is the preferred outcome and usually available, because the
   migrations in this project are overwhelmingly additive.
3. **If old code cannot run against the new schema:** this is a genuine
   incident. Do **not** hand-write a reverse migration under pressure.
   - Take a backup of the **current** state first (you may need to return
     to it).
   - Put the site into a maintenance state so no further data is written.
   - Escalate for authorisation per §3 — this now involves potential data
     loss.
   - Only then consider restoring the pre-deploy backup.

---

### Path C — Database restore (last resort)

**Requires written authorisation. Discards all data written since the
backup.**

1. Announce an outage to users — they must stop entering data.
2. **Back up the current broken state before overwriting it.** Skipping
   this makes the incident unrecoverable.
3. Restore using the project's own tooling (`backend/scripts/restore.js`;
   `npm run restore:drill` exercises the same path).
4. Verify: row counts per table, and spot-check three recent reports
   against what users remember filing.
5. **Identify exactly what was lost** — which dates, which departments —
   and tell those departments what they must re-enter. Do not leave users
   to discover a gap themselves.
6. Bring the site back and confirm `/api/health`.

> ⚠️ **As of 2026-09-30 a restore has never been demonstrated on
> production**, and backups sit on the same disk as the application
> (**VERIFIED** from live `/api/health`). Path C is therefore currently
> **unproven**. Fixing that is launch blocker B-5, and it is the reason a
> restore drill is a launch gate rather than a nice-to-have.

---

## 5. Protecting data integrity during a rollback

The system has three mechanisms that make a rollback far safer than it
would otherwise be. Use them:

| Mechanism | What it gives you |
|---|---|
| `report_revisions` (append-only) | What a report said before any change — survives the change that broke things |
| `audit_log` | Who did what, when |
| `kpi_overrides` | Keeps the computed value alongside any manual override, so an override never hides the real figure |

**During an incident:** before changing anything, capture what the affected
reports currently say. If the incident turns out to be a calculation defect
rather than data loss, those captures are how you prove which figures were
published wrongly and to whom.

**Never** repair figures by editing the database directly. Use the
correction-request workflow, so the change is attributed and reversible.

---

## 6. Communicating a rollback

Users must not be left guessing. Announce quickly, in plain language, with
no jargon and no blame.

**During:**

> The reporting system is temporarily unavailable while we correct a
> problem. Please do not enter reports until we confirm it is back. Any
> report you submitted before [TIME] is safe. We will update you by [TIME].

**If data was lost:**

> The system has been restored to its state at [DATE, TIME]. Reports
> submitted between [TIME] and [TIME] were not preserved and need to be
> entered again. The affected departments and dates are: [LIST]. We are
> sorry for the rework.

**Honesty rule:** if data was lost, say so explicitly and name the dates.
A user who re-enters a report they did not need to has lost an hour. A user
who does *not* re-enter one they should have has left a permanent hole in
the plant's records.

---

## 7. Incident documentation

Every rollback produces a written record, within 24 hours:

| Field | Content |
|---|---|
| Incident ID | Sequential |
| Detected | When, and by whom |
| Symptom | What users actually experienced |
| Trigger matched | Which §2 row |
| Path taken | A / B / C |
| Authorised by | Name and role |
| Data lost | Exact dates/departments, or "none" |
| Root cause | The real cause, not the first plausible one |
| Why testing missed it | **Mandatory** — the answer becomes a new test |
| New gate added | The test or check that would now catch it |

The last two rows are the point of the exercise. This project's own history
shows the value: a full green unit suite once coexisted with a completely
unbootable application, and the fix was a new boot-dependent gate, not a
resolution to be more careful.

Log the incident in `docs/pm/RAID_LOG.md` with a permanent ID.

---

## 8. Pre-launch rollback readiness

Confirm **before** launch day, not during it:

- [ ] Last-known-good commit SHA written down and accessible offline
- [ ] Backup taken immediately before launch, **off the application disk**
- [ ] That backup successfully restored at least once (blocker B-5)
- [ ] Droplet SSH access confirmed working for whoever is on call
- [ ] Rollback authority named and reachable on launch day
- [ ] User announcement templates ready to send (§6)
- [ ] Whether the release contains a migration — known in advance, so the
      Path A/B decision is not made under pressure

---

*This plan uses only commands read from `deploy/deploy.sh`,
`deploy/ecosystem.config.js` and `backend/package.json`. No commands are
invented.*
