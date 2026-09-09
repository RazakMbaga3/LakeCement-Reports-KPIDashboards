# ENTERPRISE UI/UX DESIGN AUDIT — Lake Cement Dashboard (Nyati)

> Paste this entire document as the opening prompt of a new Claude Code session (or hand it
> to any capable design/coding agent). It is self-contained: role, method, rubric, success
> criteria, and guardrails. Do not skip the guardrails section — this dashboard already
> passed one design overhaul with hard-won rules; violating them silently regresses work
> that took real effort to fix.

---

## 1. ROLE

You are acting as the **design review lead** for a Fortune-500-grade software procurement
committee. Your job is not to make this dashboard "nice for an internal tool" — that bar is
explicitly rejected below. Your job is to make every screen, at every size, indistinguishable
in polish from what ships out of Stripe, Linear, Datadog, Salesforce Lightning, SAP Fiori, or
Palantir Foundry — the tier of enterprise software that gets evaluated by procurement
committees comparing vendors side by side. If a screen would draw a comment in that review
("why does this table look different from that one," "why is this button taller here"), it
fails, regardless of whether it is functionally correct.

You are auditing **Lake Cement Ltd's** (Nyati Cement, Tanzania) internal Management
Information System: an Express + PostgreSQL app, ~28 static HTML pages at the repo root and
in `forms/`, used by plant department heads, mines/quarry staff, and management on a mix of
control-room desktops, laptops, tablets, and phones.

## 2. CONTEXT — DO NOT REDESIGN FROM SCRATCH

This app already went through one full UI/UX overhaul (2026-09-07/08, see
`docs/DESIGN_SYSTEM.md`). That work is real and load-bearing — re-verify it, then build on
top of it:

- `design-system.css` owns the design tokens (spacing, type, status colors, chart palette),
  a 12px legibility floor, a 44px touch-target floor, and the mobile shell CSS. It is loaded
  **last** in every `<head>`, after `styles.css` and after each page's inline `<style>`.
- `mobile-shell.js` (off-canvas drawer, app bar, role-derived bottom tab bar),
  `forms/mobile-entry.js` (cards entry-form rows below 960px by *moving*, not cloning,
  inputs), `chart-theme.js` (Chart.js defaults + validated series palette),
  `a11y.js` (accessible names), `lucide-icons.js` (generated icon subset).
- Three automated audits already exist and must stay green:
  `cd e2e && npm run audit:responsive` (18 pages × 4 viewports, structural),
  `npm run audit:a11y` (axe-core, WCAG 2.2 AA), `npm run audit:perf` (transfer/load budget).

**What those audits do NOT check, and what this pass is for:** they catch overflow, sub-12px
text, and axe violations — mechanical failures. They do not catch a page that is *correct and
still looks amateurish*: inconsistent card heights, a chart with an unreadable axis, a button
that's 2px taller than its sibling, four different shades doing the job of one, a table that
technically fits but reads as cramped. That gap is this audit's job. Read `docs/DESIGN_SYSTEM.md`
in full before starting.

## 3. METHOD — SCREENSHOT EVERY SCREEN AT EVERY SIZE, THEN LOOK AT THEM

Do not judge the design by reading the CSS. Render it and look at the pixels — that is the
only way visual defects (misalignment, inconsistent shadows, awkward reflow) actually surface.

**3.1 — Build the capture script.** Write `e2e/design-audit-screenshots.js` (Playwright,
alongside the existing `responsive-audit.js` — reuse its `PAGES` list and login/session
helpers rather than re-deriving them). Capture a **full-page PNG** for every combination of:

- **Page** — every page in `responsive-audit.js`'s `PAGES` array, plus any it omits that a
  real user reaches by daily use (check `sidebar.js` for the full nav manifest; at minimum
  add `admin-users.html`, `reports-export.html`, `memory.html`, `power-plant-report.html`,
  `coming-soon.html`, `login.html`, `forgot-password.html`).
- **Viewport** — six, not four. Keep the existing four (they're real device classes) and add
  two this dashboard actually lives on:
  - `360×740` — Android floor
  - `390×844` — iPhone 14/15
  - `820×1180` — iPad portrait
  - `1280×800` — small laptop (the gap between tablet and control-room desktop is where
    awkward reflow hides)
  - `1440×900` — control-room PC (existing "desktop" baseline)
  - `1920×1080` — large monitor / wall display — plant control rooms and management offices
    run dashboards on screens this size; verify content doesn't just center in a void or
    stretch tables into unreadable ribbons.
- **State**, not just the happy path — a design that only works with ideal data isn't done:
  - Populated with realistic data (the normal case)
  - Empty state (a new department, a filter with zero results)
  - Loading state (throttle the network, capture mid-load)
  - Error/validation state (a form with invalid input submitted)
  - A stress case per page type: a table with 50+ rows, a chart with one data point, a chart
    with a large outlier, a name/label long enough to test truncation.
- **Role**, spot-checked — log in as `e2e_admin` for full-surface coverage, then repeat the
  mobile viewports for at least one non-admin role (an L2/L3 account) since `mobile-shell.js`
  derives the bottom tab bar per role and that chrome differs from admin's.

Save to `e2e/design-audit/screenshots/<page>/<viewport>__<state>.png` with a manifest
(`index.json`) listing what each file is. This produces on the order of 25 pages × 6
viewports × ~2 realistic states each — expect several hundred images. That volume is the
point: a spot check misses exactly the inconsistencies a real audit exists to catch.

**3.2 — Look at every one of them.** Open each screenshot and score it against the rubric in
§4. Do not sample — a page that looks fine at 1440px and breaks at 820px is a real defect that
sampling would miss, and this app has a documented history of exactly that failure mode (the
pre-overhaul sidebar-stacking bug). Keep a running findings log: page, viewport, state, what's
wrong, severity (blocker / major / minor / polish), which rubric category it violates.

**3.3 — Fix, re-screenshot, re-run the automated audits.** After each batch of fixes,
re-capture the affected screenshots to confirm the fix actually reads correctly at every
viewport it touches (a fix for mobile has broken desktop before, and vice versa), and re-run
all three existing `npm run audit:*` commands. Nothing in this pass may turn any of them red.

## 4. THE RUBRIC — WHAT "ENTERPRISE-GRADE" ACTUALLY MEANS

Score every page/viewport 1–10 in each category. A page below 7 in any category, or below 9
average, is not done. These are drawn from established practice (Nielsen Norman heuristics,
the *Refactoring UI* discipline of Wathan/Schoger, and the visual language of Material/Fiori/
Lightning-class enterprise systems) — not house opinion, so defend every score against them:

1. **Visual hierarchy** — does the eye land on the single most important number/action first,
   without hunting? Size, weight, and color should establish primary → secondary → tertiary
   deliberately, not as an accident of markup order.
2. **Grid & alignment** — do card edges, column starts, and icon baselines line up across the
   whole page? Is spacing built from one consistent scale (check `design-system.css`'s spacing
   tokens — flag any hand-picked pixel value that isn't on that scale)?
3. **Whitespace & density** — enough breathing room to not feel cramped, without wasting space
   a control-room "glance" reader needs filled with signal. Density should match the reading
   distance implied by the viewport (a 1920×1080 wall display is read from further away than
   a phone — text and spacing should reflect that, not just linearly scale).
4. **Typography** — one clear type scale, consistent line-height, weight used for hierarchy
   (not just size). No more than two font families in use. Verify against the 12px floor —
   already enforced, but re-verify nothing new violates it.
5. **Color discipline** — brand colors used for identity/accents only; status colors (good/
   warn/bad) reserved and never reused for anything else; text uses the ink tokens
   (`--orange-ink`, `--green-ink`, `--amber-ink`, `--red-ink`), never a raw brand hex as text
   color or as an insufficiently-contrasting fill. Every text/background pair ≥ WCAG AA.
6. **Component consistency** — every button, badge, card, input, and table header has
   *identical* treatment (radius, shadow, padding, height) everywhere it appears across all
   ~28 pages. A one-off bespoke style on a single page is a defect, not a variant.
7. **Data visualization quality** — correct chart type for the data shape, legible axis labels
   at every viewport (the automated audits cannot see canvas text — this is a human/visual
   check only you can do), consistent series colors app-wide via `chart-theme.js`, no
   chartjunk (unnecessary gridlines, 3D effects, redundant legends when direct labels would
   read faster).
8. **Iconography** — one icon set, one stroke weight, one size grid, via `lucide-icons.js`.
   No mixed styles, no missing/placeholder icons.
9. **Empty / loading / error states** — each is deliberately designed (a real illustration or
   message, not a blank div or a raw browser error), and matches the visual language of the
   populated state.
10. **Responsive integrity** — the six viewports feel like six deliberate layouts of the same
    design, not "the desktop layout, shrunk until it stopped breaking." Check the 1280px and
    1920px sizes especially — they're new to this pass and most likely to be neglected.
11. **Motion & feedback** — hover/focus/active states present and consistent on every
    interactive element; focus rings visible (accessibility, and a maturity signal); loading
    uses skeletons/consistent spinners, not layout jumps.
12. **Information architecture** — could a new plant manager find what they need within
    seconds of landing on a page? Navigation state (active item, breadcrumbs if any) always
    unambiguous.
13. **Trust & polish** — the details that separate "internal tool" from "enterprise product":
    consistent corner radii and elevation/shadow system across the whole app, no misaligned
    pixels, no truncated/overflowing text anywhere in the six viewports, no leftover debug
    output or placeholder text, favicon and branding present and correct on every page,
    printed/exported views (if any) as clean as the on-screen ones.
14. **Accessibility, visually re-verified** — axe-core already gates this, but look anyway:
    focus order makes sense, tap targets look ≥44px (not just measure ≥44px), contrast reads
    comfortably even before running a checker.

## 5. SUCCESS CRITERIA — THE BAR

This pass is complete only when **all** of the following are true, not just "most":

- Every page scores ≥ 9/10 average and ≥ 7/10 in every single rubric category, at every one
  of the six viewports, for every state captured.
- Zero instances anywhere in the app of two visually-equivalent elements (two "primary"
  buttons, two card headers, two status badges) rendering with different height, radius,
  shadow, or padding.
- Every spacing value in every page's styles traces to a token in `design-system.css` — no
  new one-off pixel values introduced, and any pre-existing ones found are fixed.
- **The blind-drop test**: for at least three representative pages (one KPI dashboard view,
  one data-entry form, one report/table view), you can honestly say — and defend in writing —
  that if this screen appeared unlabeled in a Salesforce Lightning, SAP Fiori, or Datadog
  product demo, no one would flag it as the odd one out.
- **The glance test**: for every dashboard/report page, the single most important number or
  status is legible and unambiguous within one second of looking at the screenshot, at every
  viewport including the 1920×1080 wall-display size.
- All three pre-existing automated audits (`audit:responsive`, `audit:a11y`, `audit:perf`)
  still pass after every change.
- A written before/after report exists: findings log (§3.2), what was fixed and why, and
  updated screenshots proving each fix at every viewport it touches.

"It's fine for an internal ops tool" is an explicit failure condition for this pass — the
brief is to meet the bar of vendors competing for enterprise procurement, not the bar of an
internal tool nobody outside the company will ever see.

## 6. GUARDRAILS — DO NOT REGRESS THESE

These are hard-won rules from the prior overhaul. Violating any of them to chase a rubric
score is not a fix, it's a regression:

- `design-system.css` must stay the **last** stylesheet loaded in every `<head>`. Do not
  reorder it.
- The 12px text floor is non-negotiable anywhere, at any viewport.
- Brand hex colors (`#F49545` orange, `#173158` navy, `#239557` green) are **fills only**,
  never text colors. Use the ink tokens for text. `#173158` also fails as a chart series
  color (reads as grey) — never add it to the categorical palette.
- Wide **read** tables (reports) stay wide with a sticky first column and scroll affordance —
  do not card them on mobile; that destroys the row/column comparison the table exists for.
  Only **entry** forms card below 960px, via `mobile-entry.js`, which *moves* real inputs by
  `[data-field]`/`[data-kpi]`/`.ci` attribute — never clone them; a clone desyncs from
  `form-persist`/`report-rollup`/`formula-registry`.
- Dark mode is explicitly **out of scope** for this pass. Do not partially theme anything for
  dark backgrounds — 427 surfaces are still hardcoded light and a half-migration is worse
  than the status quo.
- Never fade text with `opacity` for a "muted" look — on already-muted ink this drops below
  3:1 contrast. Use a token, not opacity.
- Before declaring done, from `e2e/`: recreate the `e2e_*` accounts if Playwright's teardown
  dropped them (`node -e "require('./global-setup.js')()"`), start the backend with
  `AUTH_RATE_LIMIT=1000` to avoid rate-limit noise in the audit run, then run all three
  `npm run audit:*` commands and confirm all green.

## 7. DELIVERABLE

1. `e2e/design-audit-screenshots.js` (the capture script) and its output under
   `e2e/design-audit/screenshots/`, kept or gitignored per the user's preference.
2. A findings log (page × viewport × state → issue → severity → rubric category).
3. The actual code fixes, committed in reviewable increments — not a rewrite in one shot.
4. Updated screenshots proving each fix, plus a final scorecard against §4 and §5.
5. Confirmation that `audit:responsive`, `audit:a11y`, and `audit:perf` are all green.
