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

| | before | after |
|---|---|---|
| spacing declarations off the 4px scale | 11,668 (17 distinct values) | see `consistency-final.txt` |
| distinct corner radii | 16 | — |
| distinct painted background colours | 73 | — |
| elements carrying conflicting hues | 8 patterns, `.kt` at 4 signals | — |
| text on a brand fill below 4.5:1 | 1 reported, **9 more found by probe** | — |
| component classes with >1 geometry | 5 | — |

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

## 7. Still open

- **`quarry` is 1626KB against a 900KB transfer budget** — the one perf
  failure. It **predates this work** (confirmed against `64691b4`) and is
  ticket-store data volume, not assets. Fixing it is a pagination change,
  not a design one.
- **Single-series trend charts each use their own hue** (`analytics.js`
  CHART_STYLE: teal `#0d9488`, purple `#7c3aed`, red `#e53935`) rather
  than the validated series palette. Colour there is metric *identity*
  used consistently across pages, which is defensible — but it is drift
  from the validated set. This is a design-direction call, not a defect,
  and was left alone deliberately.
- **Dark mode** remains out of scope, as before.
- `form-materials` is **34,000px tall on a 360px screen** in card view —
  inherent to one-card-per-row, but worth a section-level disclosure.
