# 059: The pane toggles move to stripes, and the environment to the title bar

Status: Accepted

## Decision

Two controls move, in both window styles.

**The pane toggles leave the status bar for stripes.** A narrow stripe runs down each side of the
window, outside the panes, a tab's height plus one island gap wide. The left stripe holds the
sidebar toggle at its top, beside the sidebar. The right stripe holds the console toggle at its
bottom, level with the console. Each keeps its label, its `aria-pressed` state and its shortcut —
Cmd+B is still the sidebar — and the console's unread-line count goes with the console toggle,
because it describes what that toggle would open. The open toggle is drawn as a small island:
`canvas` with an `island-edge` ring, at the island radius. Under Classic the stripes are flat
`panel` with a `line` rule toward the panes, and the open toggle is drawn the way an `aria-pressed`
icon button is drawn today.

The status bar keeps the branch name and loses the toggles. Its doc comment, which says it exists
for the two pane toggles, is rewritten to say what it exists for now.

**The environment picker leaves the tab bar for the title bar.** It joins the title bar's trailing
group, between the update chip and the Settings gear: chip, environment, gear. The tab bar becomes
the tab strip and its `+` and nothing else.

## Rationale

**It amends ADR 034's placement and keeps its rule.** 034 put the sidebar toggle in the status bar
for two reasons: a toggle inside the pane it hides can only ever hide it, and the status bar already
owned the console's toggle. Its rule was that each toggle sits in the corner nearest the pane it
opens — sidebar left, console right — outside that pane. A stripe meets every part of that rule
better than the footer did: it is outside both panes, the sidebar toggle is beside the sidebar
rather than below it, and the console toggle is beside the console rather than under the editor's
right edge. What the footer gave 034 was a row that already existed; under Islands the frame
already exists, and a stripe is a strip of it. ADR 037 changed what the sidebar starts as, not
where its toggle is, and nothing here changes it back.

**Under Islands the footer stops being a good home for a toggle.** The status bar sits on the frame,
and a pressed icon button there is a `frame-raised` square on `frame` — a difference too small to
read as "this pane is open", which is exactly what TableCraft found and why it draws the open stripe
button as a small island instead. A stripe is the place that drawing makes sense: a toggle that
looks like a miniature of the pane it opens, next to that pane.

**The environment is a fact about the workspace, not about the tab.** The picker writes the
session's environment; every tab in the window runs against the same one. Sitting at the end of the
tab row it read as a property of the active tab — the picker's own comment says "the tab says which
request, the picker says against what" — and that adjacency was a claim the data never made. The
title bar is where ADR 055 put the other window-wide fact, and ADR 034's line that the title bar is
about which workspace and nothing else has already been widened once by 055 to "facts about the
window rather than about the request". Which environment the workspace runs against is one of
those. It also puts the selector top-right, where ADR 007's reading of Postman's layout said it
belonged.

**Chip, environment, gear — in that order — keeps 055's promise.** 055 placed the chip before the
gear so that the gear never moves, and the chip's arrival grows into the empty run on its left.
Putting the picker between them keeps both properties: the gear stays pinned to the right edge, the
picker stays pinned against the gear, and a release appearing or disappearing moves nothing but
the empty run. Putting the picker before the chip would make the chip's arrival shove the picker
sideways twice a release, which is the bug 055's first draft shipped and a screenshot caught.

## Consequences

**Classic stops being pixel-identical here.** ADR 058 keeps Classic as today's window; this record
moves controls in both styles, deliberately. A setting that also moved controls would make
`windowStyle` a layout choice, give every test that finds a toggle two answers, and teach two sets
of muscle memory. Classic keeps its flat panes and its corners; it does not keep its footer.

**The stripes cost width.** A tab's height on each side — less the island gap that was there
already under Islands, all of it under Classic. That is on top of 058's gaps, and it is the larger
of the two costs.

**The tests that find these controls find them by name, and the names do not change.**
`test/renderer/perf.app.test.ts` waits for `Hide the sidebar (Cmd+B)`, and `test/app/smoke.test.ts`
and `test/app/media/readme.media.test.ts` find the `Environment` combobox by role and name. Keeping the labels is
what keeps those selectors; the move must not rename either.

**The title bar now has four kinds of thing in it**, and 055's chip borrowed the workspace picker's
geometry so that two of them read as one strip. The environment picker is a chrome-tier `Select`
already, and it keeps that tier, so the row stays one strip with more in it rather than becoming a
toolbar.

**A status bar holding one fact is a question this record leaves open.** The branch name has no
other home yet, so the row stays. If it later gains nothing, folding it into the frame is a
reversal of a row, not of this decision.
