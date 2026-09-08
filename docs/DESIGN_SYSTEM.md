# Design system & UX standard

How this dashboard is allowed to look and behave, why, and how the rules are
enforced. The short version: **the standard is executable**. Every claim below
is asserted by one of three audits, each of which fails if the app drifts.

```bash
cd e2e && npm run audit:responsive        # 18 pages x 4 viewports, 72 checks
cd e2e && npm run audit:a11y              # 19 pages x 2 viewports, WCAG 2.2 AA
cd e2e && npm run audit:perf              # 10 pages, throttled to a plant connection
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
| WCAG 2.2 AA violations (axe-core) | **859** across 5 rules | **0** |
| Transfer per page, average | 1,679 KB | **648 KB** |
| Load on a 1.6 Mbps connection, average | 6,610 ms | **3,354 ms** |

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
| `forms/mobile-entry.js` | Shift grids as per-parameter cards on a phone; entry progress |
| `chart-theme.js` | Chart.js defaults and the validated data palette |
| `a11y.js` | Accessible names for form controls; keyboard reach into scroll regions |
| `e2e/responsive-audit.js` | Layout/legibility criteria, as runnable checks |
| `e2e/a11y-audit.js` | WCAG 2.2 AA, via axe-core |
| `e2e/perf-audit.js` | Page weight and load time against a budget |
| `lucide-icons.js` | **Generated.** The 93 icons this app uses, self-hosted |
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

**A brand colour is a fill, not a text colour.** The same lesson in a second
place. Measured against AA, Nyati orange as *text* is 2.27:1 on white and white
*on* that orange is also 2.27:1; brand green as text is 3.81:1. Together they
caused 379 of the 859 accessibility violations found. So each brand colour has
an "ink" sibling — same hue, stepped dark enough to read — while the fills stay
exactly as they were:

```
--orange-ink #A85C14   4.99:1 on white · 4.55:1 on its own tint
--green-ink  #12703F   6.15:1 on white · 5.48:1 on #E8F5EE
--amber-ink  #B45309   5.02:1
--red-ink    #C0271F   5.91:1
--on-orange  #173158   5.71:1 — brand navy is what goes ON a brand-orange fill
--on-navy    rgba(255,255,255,.55)   5.04:1 on #173158
```

A button is still Nyati orange; its label is navy rather than white. Darkening
the orange enough for white text would have cost the brand hue — this keeps it.

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

Tables are deliberately exempt. **Report tables stay wide.** A 40-column
shift report is a grid, and stacking a *read* table into cards destroys the
row-to-row comparison that is the entire reason it exists. Those get a sticky
first column, a scroll-affordance fade, and a one-time swipe hint.

**Entry grids are the exception to that exception** — see §5.

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

## 5. Mobile entry — `forms/mobile-entry.js`

Reading a wide grid on a phone is awkward. *Typing into* one is not workable:
the parameter you are entering a value for has scrolled off the left edge
while you type. So below 960px each **row becomes a card** — parameter as the
title, its spec range beside it, each entry cell a labelled field, and the
computed cells a read-back strip underneath that updates as you type.

Every card block keeps a **Table view** toggle. This is not a one-way door:
some checks genuinely need row-and-column comparison, and the grid is only
hidden, never destroyed.

### The one rule this file cannot break

**It moves the real `<input>` nodes. It never clones them.**

`form-persist.js`, `report-rollup.js` and `formula-registry.js` all bind by
attribute — `[data-field]`, `[data-kpi]`, `.ci` — and never by row or cell
position, which is what makes relocation safe. A clone would produce two
elements carrying the same `data-field`; the officer would fill one and the
form would save the other, silently. Every moved node's original parent and
next-sibling are recorded, so restoring on resize is exact.

Verified both ways: a value typed into a card field saves to the server and
comes back after a reload still in the card; resizing to desktop returns all
84 inputs to their `<td>`s with values intact and **zero duplicate
`data-field`s** in either direction.

The one positional selector in the codebase, `checkCao()` in
`pile-quality-form.html`, was hardened to tolerate the move.

### Other things worth knowing

- **Every `.rt` grid converts**, not just ones measured as too wide. The first
  rule here tested `scrollWidth`, which reports **0** inside a collapsed
  section — that left 48 inputs stranded in table cells on `stoppage-form.html`.
- **Progress counts the report, not the page.** `0 of 84 filled` excludes the
  toolbar's date and Prepared By, which are never disabled — counting them made
  a report the role cannot edit read `1 of 1 filled` instead of **View only**.
- **Disabled fields are not work outstanding.** A form disables every input when
  the role does not own the report, or the day is already submitted.

### Accessibility — WCAG 2.2 AA, enforced

`npm run audit:a11y` runs axe-core over 19 pages at two viewports. It went from
**859 violations across 5 rules to 0**. What was wrong, and the standing rules:

- **400 unlabelled form controls.** Not an oversight — a consequence of the
  shape. In a shift grid a field's meaning comes from its row heading ("LSF")
  and its column heading ("04:00–08:00"); a sighted officer reads both, a screen
  reader announced "edit text, blank" 84 times on one report. `a11y.js` composes
  the name from exactly what a sighted user reads. It **only fills a gap** — a
  control with a real label is left alone, and a name it added is withdrawn if a
  real one appears later. It never invents: no source, no name.
- **379 contrast failures** — the brand-as-text problem above.
- **58 keyboard-unreachable scroll regions.** A region that scrolls but holds
  nothing focusable cannot be reached at all; you can see there is more table to
  the right and have no way to get there. Note that *disabled* controls are not
  focusable, so a form a role does not own is full of them and still needs the
  region itself to be a tab stop.
- **A 18px-wide password toggle**, under the 2.5.8 target-size minimum.

What axe cannot check stays a review job: whether alt text is *accurate*,
whether a heading structure is *meaningful*, and whether colour is the *only*
thing carrying a signal. The design system's standing answer to the last one is
that a status colour always ships with a label or an icon.

### Performance — budgeted, on the plant's own connection

`npm run audit:perf` drives ten pages throttled to 1.6 Mbps / 300ms RTT.
Measuring on a LAN beside the server would say everything is instant and tell
us nothing.

| | Before | After |
|---|---|---|
| Transfer per page (avg) | 1,679 KB | **648 KB** |
| Load, throttled (avg) | 6,610 ms | **3,354 ms** |

Three things accounted for nearly all of it:

- **The logo was 641 KB.** A 5,357 × 6,230 px PNG, rendered at 42px tall, on
  every page. Now 20 KB at 240px tall; the original is kept as
  `NYATI-LOGO-full.png`. If you ever need print resolution, use that one.
- **The whole Lucide library, 424 KB, from unpkg, on 24 pages** — 2,045 icons
  to draw the 93 this app uses. `lucide-icons.js` is a generated subset at
  22 KB, self-hosted. That removes bytes *and* a hard dependency on a third-
  party CDN being reachable from a plant whose internet is not always good.
- **No compression and no cache headers in nginx.** Both added; gzip alone
  takes roughly 75% off every text response.

Also: the Inter request asked for weight 300 on 25 pages, and nothing in the
app uses weight 300.

**Budgets are set just above measured reality and are meant to ratchet down.**
A budget nothing can breach is not a budget. They are held against
*uncompressed* numbers, because `preview-server.js` does not gzip — production
is materially better than what the audit reports.

**If you add an icon**, rebuild the subset — the generator is recorded in the
file header, and `lucide-icons.js` warns to the console on an unknown name.
There is a verification pass worth re-running: load every page and assert that
no `[data-lucide]` placeholder survives. That is how the subset was proven, and
how a real pre-existing bug surfaced — four pages rendered the sidebar but never
loaded the icon library at all, so their icons had always been invisible.

**If you edit a shared asset, bump its `?v=` in every page that loads it.**
JS and CSS are cached for a day.

### Motion & accessibility

One duration set and one easing. `prefers-reduced-motion` is honoured. Every
page has a skip link and a visible `:focus-visible` ring (light on dark
surfaces). The drawer is a real modal: focus trap, Esc, scroll lock, restore.

---

---

## 6. Working in this codebase

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

Needs both servers and an `e2e_admin` account. **The Playwright suite's
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

## 7. Known open items

- **`forgot-password` returns 500 for a known address and 200 for an unknown
  one when SMTP is unset**, which leaks whether an account exists — the exact
  thing the endpoint is written to avoid. It is masked once `SMTP_HOST` is
  configured, but the failure mode should be a 200 either way.
  (`e2e/tests/account-activation.spec.js:116`)
- Dark mode is not implemented. The tokens are structured for it; the dark
  steps must be *selected and validated against the dark surface*, not
  generated by flipping the light ones.
- The daily entry forms have no **save affordance within reach** on a long
  card list: an officer 60 fields down must scroll back to the toolbar to save
  a draft. A sticky save action is the obvious next step, but it has to be
  designed around the bottom tab bar rather than competing with it.
- `mobile-entry.js` rebuilds cards only on the rows present when it runs.
  Forms that add rows later (`materials`, `limestone`, the pile log) show those
  rows in Table view until the page is reloaded.
