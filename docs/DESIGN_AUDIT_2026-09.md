# Enterprise visual design audit — September 2026

> What was measured, what was found, what changed, and what is still open.
> Re-run the whole thing with `docs/UI_UX_ENTERPRISE_DESIGN_AUDIT_PROMPT.md`.

---

## 1. The premise, confirmed on the first command

Before a single fix, the three audits that already gate this repo were run:

```
audit:responsive   ✓ all 72 page/viewport checks passed
audit:a11y         ✓ no serious or critical violations
audit:perf         ✗ 1 page over budget (quarry, 1616KB — pre-existing)
```

**Every defect in this report was invisible to all three.** That is not a
criticism of them; it is what they are for. `responsive-audit.js` proves a
page FITS — no overflow, nothing under 12px, tap targets big enough.
`a11y-audit.js` proves it is READABLE. Neither proves it is COHERENT: that
the same kind of thing looks the same on every page, that colour is spent
on meaning rather than decoration, that the six values in a KPI strip land
on one baseline. Those are the things a procurement design review actually
comments on, and they are all measurable — you just have to measure across
pages instead of within one, and you have to look at pixels.

## 2. What was added to measure it

Two new executable standards, both `cd e2e && node <file>`:

**`design-audit-screenshots.js`** — frames every page at **six** viewports:

| | width × height | why |
|---|---|---|
| small | 360 × 740 | Android floor |
| phone | 390 × 844 | iPhone 14/15 |
| tablet | 820 × 1180 | iPad portrait |
| **laptop** | **1280 × 800** | **new** — the gap where awkward reflow hides |
| desktop | 1440 × 900 | control-room PC |
| **wall** | **1920 × 1080** | **new** — management office / wall display |

It captures viewport-sized **frames at successive scroll offsets**, never
full-page. A full-page PNG of a long form is 360 × 34,000; anything that
later fits it to a screen squashes the type to nothing. Device scale factor
is inverse to width (phone 2×, wall 1×) for the same reason — a 1920 frame
is already at the ceiling, a 390 frame needs the upscale to stay legible.

**`design-consistency-audit.js`** — six cross-page checks: component
geometry drift, spacing-scale adherence, colour inventory, text on a brand
fill, conflicting signals, radius/elevation inventory.

Its signal check measures **hue disagreement (≥40° apart), not a count of
coloured parts**. A status chip legitimately spends a background, a border
and a dot on one reading; counting those as three faults just teaches you
to ignore the check. What breaks a reader is two signals in *different*
hues on the same element.

## 3. Measured before → after

`design-consistency-audit.js`, 24 pages, run at **1440 and 1280** —
identical results at both:

| | before | after |
|---|---|---|
| spacing declarations off the 4px scale | **11,668** (17 distinct values) | **59** (6 values) |
| distinct corner radii | 16 | **9** |
| text on a brand fill below 4.5:1 | 1 reported, **9 more found by probe** | **0** |
| elements carrying conflicting hues | `.kt` at 4 signals, 8 patterns | **0** |
| in-flow elements overlapping a sibling | not measured | **0** |
| component classes with >1 geometry | 5 | **3, all artefacts** |
| distinct painted background colours | 73 | 64 |

After the second pass (§7) the same audit reports, at 1440 / 820:

| | 1440 | 820 |
|---|---|---|
| spacing off the 4px scale | 15 | 78 |
| component classes with >1 geometry | 2 | 2 |
| in-flow collisions | 0 | 0 |
| text on a brand fill below 4.5:1 | 0 | 0 |
| elements carrying conflicting hues | 0 | 0 |

Read the residue honestly rather than as a score. **Every remaining
spacing value is a deliberate constant or a computed one — none is an
arbitrary choice:**

- `44px` (×39) is `--tap`, the WCAG touch-target size.
- `68px` (×24) is `--header-h`, the sticky header offset.
- `78px` (×11) is `.sk-status` clearing an ~85px corner badge — measured
  against that badge and commented as such at the source.
- `376 / 399 / 95px` are `margin-top: auto` on page footers resolving to
  a number. Nobody wrote them.

Both remaining "drifting" components are **artefacts of the check**:
`button.sec-tab` differs only in font-weight between its active and
inactive states, which is the point of an active state, and
`button.adm-btn` by 2px on the one instance whose icon differs.

The three audits that already gated the repo, re-run after the final
commit of both passes:

```
audit:responsive   ✓ all 72 page/viewport checks passed
audit:a11y         ✓ 0 serious or critical violations
audit:perf         ✗ 1 page over budget (quarry, 1635KB) — see §8
```

A note on the perf number: FCP is **noisy under machine load**. A "login
FCP regression" during this work reproduced at 2272ms on a quiet re-run
with byte-identical payload and request count. Re-run before believing
one.

## 4. The headline defect

**KPI tiles painted two unrelated dimensions in the same two hues.**

`.kt` encoded RAG status on a top bar, a body tint, a border and a bar
fill — and data provenance on a bottom bar and a badge. Because
provenance-formula was green and status-concern was red, a *failing
formula KPI showed a red top edge and a green bottom edge on the same
card*, and the reader had no way to know which to believe. Six colour
signals for two facts is not emphasis, it is noise.

Now: **status owns the left rail, the vs-line and the pct. Provenance is a
neutral pill whose dot alone carries hue.** One dimension, one channel.

Alongside it, measured rather than eyeballed: the six values in the
dispatch strip were landing at **y=283 or y=296** depending on whether
their label wrapped to three lines — the single thing a KPI strip exists
to prevent. Reserving three label lines at the six-across breakpoint puts
all six on one baseline.

## 5. Everything else, by theme

### Colour saying the wrong thing
- MIS drew the **expat headcount column in `--red-ink` on every row**, and
  the local/expat totals in green/red — a pass/fail palette on a neutral
  demographic fact. Vehicle classes and ABC stock classes likewise.
- **Zero is not failure.** "0 Not Achieved" in red, "0 Not Complied" in
  red, and an unentered month rendering as 0/0/0 in green-red-blue all
  made *no news* read as *bad news*.
- The concerns strip already asked for a green chip when nothing had
  missed target — **no green style was ever written**, so the all-clear
  appeared in the amber alert container.
- **Weight the exception, not the norm.** Analytics coverage chips and the
  completeness heatmap both made the streams *with* data loud and the gaps
  quiet — backwards for widgets whose whole job is finding gaps.
- Five different greens meant "good" (`#F0FDF4`, `#BBF7D0`, `#DCFCE7`,
  `#ECFDF5`, `#E7F5ED`), four reds meant "bad", three ambers "warn".

### Things the reader was never told
- The **sales/purchases failure state** printed one line of grey 12px text
  and left seven empty captioned boxes below it. There is now a shared
  `.ds-state` panel: what happened, what it means, and a retry.
- **balance.html** destroyed its chart on a date missing one source form
  and left a 220px empty white box under a navy header — three of four
  cards. Each now explains itself in the slot the chart would have used.
- **approvals.html** stranded one sentence under eight column headings for
  rows that were not there. An empty queue is the *good* state for an
  inbox and now looks like one.
- **mines-report** put raw exception text in a toast: *"Could not load
  quarry data from the server: submitForm(mines) failed: HTTP 403"* —
  an internal function name and a status code, and not the one fact that
  mattered. `humanError()` now maps the common failures onto sentences and
  logs the original to the console.

### Rules that were held by a list of names
Three separate bugs, one shape. **Never find elements by a hardcoded list.**
- `mobile-shell.js`'s scroll affordance listed four wrapper classes and
  missed `.adm-wrap` — **157px of the user-administration table hidden at
  1440px with nothing on screen to say so.** Now found by computed overflow,
  the correction `a11y.js` had already made for the same reason.
- `applyReadOnly` swept the DOM once for action buttons; `excel-import.js`
  injects its Import button afterwards, so **every view-only user got a
  write button.** Read-only is now a body state with a CSS rule.
- `design-system.css` corrected white-on-orange through a list of
  selectors; **every orange fill added after that list was written escaped
  it** — nine of them, at 2.27:1. Fixed at source instead.

### Things only looking could find
- **Chart category labels were overprinting each other** on the reliability
  Pareto. Canvas text is a bitmap; no audit in this repo can see it.
  `chart-theme.js` now wraps long labels as a Chart.js *default*, because
  every page writes its own `scales.x.ticks` and a default is the only
  place that reaches all of them.
- The **header accent rule drew its first 55% at 1.2:1** against its own
  navy ground — over half the device invisible, the orange reading as a
  stray dash. (The first correction, #2C5288, was still only 1.67:1;
  #4A78B8 clears 2.86:1.)
- Mobile app-bar titles truncated to **"Dispatch & Sto…"** and
  **"KPI Dashb…"** — the one piece of chrome whose entire job is telling
  you where you are.
- A **100%-full progress bar labelled "View only"** on forms nobody can
  fill, directly above the banner already saying the same three words.
- An **em-dash at 28px/800 is a solid black bar** and reads as a redacted
  figure, not an absent one.
- `[hidden]` **did not hide**: the UA rule has the lowest possible
  specificity and every `display:flex` in this app beat it.

## 6. Regressions this pass caused, and what they taught

Kept deliberately, because each one is a rule now:

1. **A circular custom property.** The token pass rewrote
   `--st-bad-bg: #FDECEA` into `var(--st-bad-bg)`, silently unsetting the
   token everywhere. Never rewrite a hex on the right-hand side of a
   custom-property *definition*.
2. **Provenance merged into status.** The same pass mapped the formula
   tint onto `--st-good-bg`, making calculated cells look like passing
   ones. They are supposed to differ.
3. **An a11y failure from a 2px padding change.** Trimming `.in-card` gave
   its table 4px more room, sliding a scrolling region into the gap
   between axe's definition of "scrolls" and a 4px grace band in
   `a11y.js`. The band is now 1px — and any table overflowing its wrapper
   by two or three pixels was silently unreachable by keyboard before.
4. **The scroll affordance unstuck what it decorated.** Widening it to
   find scrollers by computed overflow correctly caught the stoppage
   form's section tab bar — and `.ms-scroll-x { position: relative }`
   overrode its `position: sticky`, turning `top: 121px` into a 121px
   downward shift that dropped the tabs through the six KPI cards below.
   Nothing overflowed and no contrast changed, so responsive and axe both
   stayed green. **Check 7 was written afterwards and validated against
   this exact defect** — reverted, it reports
   `121px div.sec-nav over main.fm-main`; restored, zero.
5. **The audit passed while it was broken.** One run exited 0 with an
   empty summary because the in-page collector was throwing on all 24
   pages. An empty findings list is indistinguishable from a clean sweep
   unless failures are counted. It now exits 2 and says so — the worst
   failure mode a check can have is looking like a pass.

## 7. Second pass — the pages the first pass never opened

The first pass reviewed roughly a dozen pages closely and sampled the
rest. That was the wrong call, and the evidence is that **the single
worst defect of the whole audit was found by opening one screenshot of a
page I had not looked at** (§6.4, the section tabs falling through the
KPI cards at 1280px). So the second pass captured the ~19 untouched
pages at three widths and read every one.

What it found was not more polish. It was **function**:

- **The Quarry page wrote to the server on load.** `POST
  /api/reports/mines` fired on every visit to seed April 2026 openings.
  For anyone without edit rights that 403s, and because the call was an
  unguarded `await` inside the page's data loader, the rejection took the
  loader down with it — the weighbridge tickets never loaded. What the
  reader saw was a red permission toast, an empty 230px chart, and
  "No weighbridge data loaded" on a month with 3,909 tickets. It read as
  three design defects and was one functional bug.
- **Sales and Purchases reported a refusal as an outage.** A well-built
  failure panel ignored the error it was handed (Purchases was not even
  passed one) and always blamed the Odoo connection, in alarm red, with a
  retry button that could only fail the same way. A 403 now shows a lock
  and no retry.
- **The department scorecard collapsed on tablets.** `.sc-chip` is named
  like the small chip-shaped links around it, so the mobile tap-target
  rule had swept it into their selector and given it `inline-flex` — but
  it is a *tile* with a name, a percentage, a bar and a status stacked
  vertically. At six across it rendered "PROD 0 CON", all three clipped
  mid-word. Predates this work.
- **The one-per-browser swipe hint was being spent on tables that do not
  scroll**, because it was decided at wire-up time before API rows
  arrived. On Approvals it appeared above an empty state.

Method note: a scan of all 27 pages for HTTP errors and writes on load is
what caught the first two. Of 27, exactly one page wrote on load and
three 403'd — and all three were saying the wrong thing about it.

Also corrected in this pass: **twelve descriptive captions were drawn as
passing verdicts** (`.kt-vs .vs-ok` on "Own production + purchased
receipts", "42.5R · 32.5N · OPC · Jumbo"), six of them on one phone
screen; **five charts used brand navy `#173158` as a series colour**,
which design-system.css explicitly forbids because it reads as grey; and
**two pages drew button icons as system emoji** while loading the lucide
subset and never calling it.

## 8. Still open

- **`quarry` is 1634KB against a 900KB transfer budget** — the one perf
  failure. It **predates this work** (confirmed against `64691b4`) and is
  ticket-store data volume, not assets. Fixing it is a pagination change,
  not a design one.
- **`scripts/validate_palette.js` does not exist**, though the palette's
  own comment in design-system.css names it as the way to re-verify the
  categorical set. The values are unchanged and still documented as
  validated, but there is currently no way to re-run that check.
- **Dark mode** remains out of scope, as before.
- `form-materials` is **34,000px tall on a 360px screen** in card view —
  inherent to one-card-per-row, but worth a section-level disclosure.
- KPI tile values still render their "no data" placeholder as an em-dash
  at 26px/800, which is a solid bar. The hero cards on the KPI dashboard
  were fixed (`.sk-value.is-empty`); doing the same for `.kt-val` needs a
  JS pass on pages that do not currently run one, so it was left.
- `.rcard-toggle` and `button.adm-btn` still differ by 2–3px between one
  page and the rest. Real, but below the threshold worth more churn.

## 9. Worth knowing before the next pass

**Sample nothing.** The two worst findings of this audit — the section
tabs falling through the KPI cards, and the Quarry page writing to the
server on load — were both found by opening a screenshot of a page that
had been skipped. Neither was visible to any automated check, before or
after. The capture is cheap; the reading is the work.

The regressions in §6 all came from **bulk transformations run without a
guard**. The scripts kept in `scripts/` now carry those guards, and all
are dry-run by default:

```
node scripts/normalize-spacing.js       # 4px scale
node scripts/normalize-tokens.js        # radii + status tints
node scripts/fix-on-orange.js           # text on a brand-orange fill
```

Run the visual pass with:

```
cd e2e
node design-audit-screenshots.js --out design-audit/shots --frames 2
node design-consistency-audit.js --json design-audit/consistency.json
```

Both need the harness accounts and a backend started with
`AUTH_RATE_LIMIT=1000` — see `docs/DESIGN_SYSTEM.md`.
