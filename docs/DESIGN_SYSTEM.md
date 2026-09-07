# Design system & UX standard

How this dashboard is allowed to look and behave, why, and how the rules are
enforced. The short version: **the standard is executable**. Anything claimed
here is asserted by `e2e/responsive-audit.js`, which fails if the app drifts.

```bash
cd e2e && npm run audit:responsive        # 18 pages x 4 viewports, 72 checks
```

---

## 1. What was wrong

An audit on 2026-09-07 drove every significant page at four viewports. The
desktop app was in good shape. On a phone it was, in practice, unusable:

| Measure | Before | After |
|---|---|---|
| Navigation above the first number, per page | **1,409–1,585px** (≈2 screens) | **56px** |
| Pages overflowing the viewport horizontally | 9 (up to 524px) | **0** |
| Text below 12px | **84–97%** of all text nodes | **0** of 14,400 |
| Smallest rendered text | 7.5px | 12px |
| Tap targets under 44px | 163 of 174 on one page | **0** of 2,111 |
| Form controls under 16px (iOS zooms on focus) | 384 | **0** |

The root cause of the navigation figure: the `<960px` rule in `styles.css`
turned the sidebar into a static full-width block **above** the content. Every
page therefore opened to the same wall of navy menu, and you could not tell
which page you were on without scrolling past all of it.

---

## 2. The files

| File | Owns |
|---|---|
| `design-system.css` | Tokens, legibility floor, touch floor, mobile shell CSS, containment |
| `mobile-shell.js` | Drawer, app bar, bottom tab bar, filter disclosure, scroll affordances |
| `chart-theme.js` | Chart.js defaults and the validated data palette |
| `e2e/responsive-audit.js` | The acceptance criteria, as runnable checks |
| `styles.css` | Everything desktop. **Nothing below 960px is styled here any more.** |

`design-system.css` is loaded **last** in every `<head>` — after `styles.css`
and after each page's own inline `<style>`. That is deliberate: it lets one
file settle equal-specificity ties across 28 pages instead of losing them.

---

## 3. The rules

### Type — one floor, 12px

Nothing renders below 12px, anywhere. This is enforced **at the source**: a
codemod raised 1,845 declarations that sat between 7.5px and 11.5px across the
HTML, CSS and JS, plus 3 SVG `font-size` attributes and 30 Chart.js font sizes
the CSS pass could not see.

Merging the old 8/9/10/11px tiers into one cost no legible structure, because
below roughly 12px size stops functioning as a hierarchy cue at all (Johnson,
*Designing with the Mind in Mind*). **Hierarchy comes from weight and colour
first, size second.** The scale:

```
--fs-xs   12px   THE FLOOR — badges, axis ticks, dense cells
--fs-sm   13px   secondary labels, captions
--fs-base 14px   body copy, data cells
--fs-md   15px   emphasised body
--fs-lg   17px   card titles
--fs-xl   20px   section titles
--fs-2xl  25px   KPI tile values
--fs-3xl  31px   hero number
--fs-4xl  39px   single headline figure
```

Density is *correct* on a 1440px desktop for a seated analyst (Few) and *wrong*
on a 390px phone in daylight. So mobile lifts data cells to 13px and values to
14px, and every form control to **16px** — under 16px, iOS Safari zooms the
page on focus, which is the single most-hated mobile form behaviour there is.

### Touch — 44px, 40px inside data grids

Keyed off `pointer: coarse`, not viewport width: a touchscreen laptop needs it
too, and a phone in desktop mode does not stop being a phone. Controls inside
`td`/`th` get the 40px "cozy" target instead — a 44px row would double the
height of a 40-column shift report.

Inline links inside a sentence are exempt (WCAG 2.5.8): enlarging them pushes
the words apart and makes the sentence harder to read, not easier to use.

### Colour — three separate palettes, one of them machine-checked

1. **Brand** (`--navy`, `--orange`, `--green`) — identity. Headers, nav, logo.
2. **Status** (`--st-good/warn/bad/neutral`) — reserved. A status colour is
   **never** reused as a chart series colour, and always ships with a label or
   icon, never colour alone.
3. **Series** (`--series-1..8`) — data identity only.

The brand palette must not do the data palette's job. Run against the
validator, the brand trio **fails**: `#173158` has OKLCH lightness 0.315
(outside the 0.43–0.77 band) and chroma 0.077 (below the 0.1 floor), so it
reads as grey rather than as a hue. A brand colour identifies a company; a
series colour has to identify a series to a reader with colour-vision
deficiency, on a projector, in a print-out.

The series palette is Nyati-anchored and validated, not chosen by eye:

```
--series-1 #1F5FA8  blue    (brand navy, stepped into the usable band)
--series-2 #EB6834  orange  (brand orange, chroma raised)
--series-3 #1BAF7A  aqua      --series-6 #008300  green
--series-4 #EDA100  yellow    --series-7 #4A3AA7  violet
--series-5 #E87BA4  magenta   --series-8 #E34948  red
```

Worst adjacent CVD ΔE **9.1** (target ≥8); worst adjacent normal-vision ΔE
**19.6** (floor ≥15). Slots 3–5 fall below 3:1 against white, so any chart
using them owes **visible direct labels or a table view**.

**Rules that do not bend:** categorical hues are assigned in fixed order and
never cycled — a 9th series takes the neutral rather than repainting slot 1,
which would claim two unrelated things are the same thing. Sequential is one
hue light→dark. Diverging is two hues with a **neutral grey** midpoint, never a
rainbow. Never a dual-axis chart.

### Layout — nothing may exceed its column

Each page's `<main>` is a flex item of `.main`, and a flex item defaults to
`min-width: auto` — "never shrink below your own min-content". One nowrap table
cell or one Chart.js canvas sized for a wider layout could therefore drag an
entire page wider than the screen. This was **not** mobile-only:
`completeness.html` overflowed by 170px on a 1440px desktop.

`design-system.css` §3b pins `min-width: 0; max-width: 100%` on `.main`'s
children at every width, lets `repeat(N, 1fr)` grids re-flow via `auto-fit`,
and turns control strips that would spill into horizontal scrollers.

Tables are deliberately exempt. **Wide data tables stay wide.** A 40-column
shift report is a grid, and stacking it into cards destroys the row-to-row
comparison that is the entire reason it exists. What they get instead is a
sticky first column, a scroll-affordance fade, and a one-time swipe hint.

### Motion & accessibility

One duration set and one easing. `prefers-reduced-motion` is honoured. Every
page has a skip link and a visible `:focus-visible` ring (light on dark
surfaces). The drawer is a real modal: focus trap, Esc, scroll lock, restore.

---

## 4. The mobile shell

- **App bar** — hamburger, page name, avatar. The page name matters: before
  this, every page opened identically.
- **Drawer** — the full role-aware sidebar, off-canvas, over a scrim.
- **Bottom tab bar** — 3–4 role-derived destinations plus Menu. Derived from
  the same permission accessors `sidebar.js` uses (`getAllowedKPIDepts`,
  `getMyFormAccess`, `canViewMIS`, `canViewSales`), so a permission change in
  `auth.js` moves the tab bar with it — there is no second copy of the rules.
  Capped at 5: past that a tab bar stops being scannable and becomes a second,
  worse menu (Tidwell).

---

## 5. Working in this codebase

**Do**

- Use the tokens. Spacing from `--sp-*`, type from `--fs-*`, colour by role.
- Put anything below 960px in `design-system.css`, not in a page.
- Reach for `LCL_CHART.series[i]` / `LCL_CHART.status.*` in charts.
- Run `npm run audit:responsive` before you push.

**Don't**

- Write a `font-size` below `--fs-xs`. The audit will fail.
- Use a brand colour as a chart series colour, or a status colour as either.
- Add a `@media (max-width: …)` block to `styles.css`.
- Turn a wide data table into stacked cards.

### Running the audit

Needs both servers and an `e2e_admin_hod` account. **The Playwright suite's
global teardown drops every `e2e_*` account**, so after running `npx playwright
test` you must recreate it or the audit exits 2:

```bash
cd backend && AUTH_RATE_LIMIT=1000 node server.js &   # :5000
node preview-server.js &                              # :3000
cd e2e && node -e "require('./global-setup.js')()"    # accounts
npm run audit:responsive
```

`AUTH_RATE_LIMIT=1000` matters: the audit signs in four times per run, and a
default-limited server will start refusing logins and the suite will fail with
"Too many attempts from this device" that has nothing to do with the code.

### What the audit cannot see

**Canvas text.** Chart labels are a bitmap, so a 9px axis label is invisible to
a DOM audit. The font sizes in `chart-theme.js` are the only guard — change
them there, not per chart.

---

## 6. Known open items

- **`forgot-password` returns 500 for a known address and 200 for an unknown
  one when SMTP is unset**, which leaks whether an account exists — the exact
  thing the endpoint is written to avoid. It is masked once `SMTP_HOST` is
  configured, but the failure mode should be a 200 either way.
  (`e2e/tests/account-activation.spec.js:116`)
- Dark mode is not implemented. The tokens are structured for it; the dark
  steps must be *selected and validated against the dark surface*, not
  generated by flipping the light ones.
- The daily entry forms work on a phone but are not yet *designed* for one —
  they remain wide grids with a sticky first column.
