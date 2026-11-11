# 058: The window is islands on a frame

Status: Accepted

## Decision

The window gains a second style, **Islands**, and it is the default. The panes — sidebar, editor,
console — become rounded `canvas` cards with a small gap between them, floating on a `frame` that
the title bar and the status bar sit on too. The other style, **Classic**, is today's window: flat
panes, 1px rules between them, no radius. One preference, `windowStyle`, switches between the two
live, without remounting anything.

**The frame is derived, not themed.** `appearance/islands.ts` computes three colours from the theme
it is given:

- `frame` starts at `panel` and steps 1% at a time away from `canvas` — toward white on a dark
  theme, toward black on a light one — until it reaches **1.2:1** against `canvas`.
- It stops early, short of 1.2:1, at the last step where `ink` and `ink-dim` drawn on it still meet
  the floors `scripts/audit.ts` holds every theme to. Text in the title bar and the status bar is
  read on the frame, and a frame nobody can read on is not a frame.
- `island-edge` is `canvas` when the frame reached 1.2:1, so the island needs no outline. When the
  cap stopped it first, `island-edge` falls back to `line`, and the island is drawn with the 1px
  rule Classic already uses. A theme that cannot separate the two surfaces by tone separates them
  by edge.

`frame-raised` is stepped the same way, until it sits as far from `frame` as `hover` sits from
`panel`, so a hovered control in the chrome reads as far from its row as one in a pane does.

**Density gains two numbers.** `density.ts` grows from eight to ten: `islandGap` and
`islandRadius`, compact 4/8, default 5/10, comfortable 6/10. They are presets for the reason ADR
021 gives for the rest — a radius that has to agree with a row height belongs to the same choice as
the row height — and they reach CSS the way the other eight do, as `--spacing-island-gap` and
`--radius-island` written by `appearance/apply.ts`. Under Classic the radius is 0.

**Floating surfaces round on a ladder.** Every surface that floats takes a named radius, never a
Tailwind step:

| Surface | Islands                     | Classic |
| ------- | --------------------------- | ------- |
| Dialog  | the island radius (8 or 10) | 8       |
| Island  | the island radius (8 or 10) | 0       |
| Popover | 8                           | 6       |
| Tooltip | 4                           | 4       |

Classic's column is what `Dialog`, `Menu`, `Select` and `Tooltip` draw today — `rounded-lg`,
`rounded-md` and `rounded-sm` — so Classic's corners do not move. A popover is 8 because 8 is the
smallest radius concentric with its 4px-radius rows inside a 4px inset; a dialog never steps above
the island, because in compact that would be a fourth radius on screen for no reason anyone could
name. Popovers and dialogs carry one of two shadows, `--shadow-popover` and `--shadow-dialog`, and
which pair is written depends on the theme's colour scheme, not on the window style.

The macOS window background takes the frame colour, over the `setWindowChrome` channel ADR 021
already opened for the title bar's height, so a resize that outruns the renderer shows frame and
not a black band.

## Rationale

**This is TableCraft's decision, ported.** TableCraft records it as its decisions 141 and 150 and
specifies it in its design system under §Islands. The arguments carry over because the two apps
share the shape that made them true: dense panes of rows, a canvas darker than its panels, and
dozens of generated themes. What follows is what preman chose differently or had to settle again.

**The panes need a boundary that is not a line.** Classic separates panes with the same 1px `line`
it uses between rows, so the outermost structure of the window and the innermost structure of a
list are drawn with the same stroke. A gap of a different tone says "these are separate things" at
a level a rule cannot, and it is the shape JetBrains' Islands theme has already taught people to
read.

**A frame token was rejected because there are 43 themes.** ADR 020 makes themes generated, audited
data, and 42 of the 43 are generated from upstream palettes that have no colour for this. A token
would mean inventing a frame 43 times by hand, adding a contrast pair to the audit, and then
regenerating — while a derivation from `panel` gives every theme, including the next one, a frame
on the day it is added. A token is not closed off: if a theme ever wants its own frame, an optional
override is additive, and nothing that reads `--color-frame` would notice.

**JetBrains' frame was rejected as-is because it does not clear its own floor.** 1.2:1 is the
contrast JetBrains states for its islands, and its own dark frame measures about 1.18:1 against its
island — just under. Copying its colours would import a separation the author of the rule did not
quite achieve. The number is kept; the colours are derived until they meet it.

**The cap is on text, not on taste.** Stepping until 1.2:1 regardless would, on a light theme with
a pale panel, walk the frame into a grey that `ink-dim` cannot be read on, and the status bar and
title bar would fail the audit every theme already passes. So the step stops where the text would,
and the edge fallback makes up the lost separation with a rule. The themes that need the fallback
are visible in a test, not discovered in a screenshot.

**Islands is the default, and a saved choice is kept.** Islands costs width and height (below), and
some people will prefer the denser flat window, which is why it is a setting at all rather than a
replacement. TableCraft shipped it the other way round first — Classic by default, Islands opt-in —
and moved the default once the style had settled; preman starts where TableCraft ended up. The
preference is stored like every other appearance preference under ADR 022: global, and synchronous
at first paint, so there is no flash of the wrong style.

**The gutter stays 12px; pane inset is not tied to the radius.** TableCraft sets its pane inset
equal to the island radius, so content clears the corner curve. preman does not need to: its
`--spacing-gutter` is already 12px, wider than the 10px radius, and it is deliberately outside the
density presets. Tying it to the radius would shrink it to 10 or 8, move the 33 `px-gutter` sites,
and change Classic — three costs for a corner that is already cleared.

**The floating ladder is part of the same decision, not a later one.** A rounded island with a
6px menu over it and an 8px dialog over that reads as three unrelated radii. TableCraft amended its
islands record to fix exactly that, and preman takes the amendment with the original. The shadows
change for the reason TableCraft found: Tailwind's `shadow-lg` with a black tint barely shows on a
dark canvas, which is the default scheme here, and a shadow keyed on the colour scheme can be
stronger where it needs to be and gentler where it does not.

**No control moves.** TableCraft pairs its islands with stripes down each side of the window that
hold the tool-window toggles. That was drafted here too: the sidebar and console toggles would move
to stripes, and the environment picker to the title bar. It was dropped before it shipped. Islands
changes how the window looks, not where anything is. The toggles stay in the status bar, the picker
stays at the end of the tab row, and nobody's muscle memory pays for a new look.

## Consequences

**Every existing user gets Islands on update.** Nobody has a stored `windowStyle` yet, so "a saved
choice is kept" protects only choices made from now on. Someone who preferred the flat window has
to pick Classic once, in Settings; that is the price of the default being the style we think is
better rather than the one that was there first.

**About 10px of width and 10px of height go to gaps.** At the default density that is a gap at each
outer edge, plus the difference between a 1px handle and a gap at each split. Compact gives a
little back. It is the reason Classic exists, and the reason it stays a first-class style rather
than a legacy one.

**Rounded clipping is new work for the virtualized panes.** An island clips its content to its
radius, which puts a rounded clip over the sidebar's virtualized tree, the editor and the console.
That is checked against the budgets in `docs/performance.md` with
`PREMAN_PERF=1 bunx vitest run test/renderer/perf.app.test.ts` before the panes become islands, not
after; the 5000-node sidebar budget was already marginal under ADR 037, so it is the one to watch.
Focus outlines inside an island draw 2px inward, because a clip would otherwise cut them.

**Classic's corners stay; its shadows do not.** The radius ladder leaves Classic's numbers as they
are, but the two shadows are keyed on the colour scheme under both styles, because the reason for
them is the dark canvas and not the islands. `Theme.shadowFloat` stays — it is the drag ghost's,
and the comment calling it the one elevation in the app stops being true and is rewritten.

**The README's media is stale until it is re-recorded.** Every GIF shows Classic. They are
re-recorded with `bun run readme:media` as the last step of the work rather than per change, so the
media is recorded once against the finished window.

**A test refuses the old radii.** Once the ladder exists, a floating surface reaching for
`rounded-lg`, a Tailwind shadow step or a literal black shadow is a bug, and a test says so — the
same move TableCraft made, so the ladder does not erode one popover at a time.
