# 037: The sidebar starts open again

Status: Accepted

## Decision

The sidebar panel's `defaultSize` is `SIDEBAR_OPEN` — the 22% it was before 034 — rather than
`SIDEBAR_COLLAPSED`. On a fresh install the window opens with the tree showing.

**This reverses 034.** Everything else 034 built stays exactly as it is: the pane is still
`collapsible` with a `collapsedSize` of zero, the footer `IconButton` and `Cmd+B` are still the two
controls and still call one `toggleSidebar`, the sidebar's own header still has no toggle, and the
pane still animates by `flex-grow` at `--duration-panel` on `--ease-drawer`. What changes is one
number and the `useState` seeded to agree with it.

`test/renderer/perf.app.test.ts` no longer clicks the toggle as part of launching. It waits for the
button by its "Hide" label instead, so a launch that stopped rendering the footer would still fail
rather than quietly measure something else.

## Rationale

034 argued that a navigator is a thing you use to arrive, and that once a request is open the tree
is a column of names next to the pane that most wants the width. That argument is not wrong, and
this record does not claim it is. It was outweighed by the counter-argument 034 itself stated and
then answered: a tree that is not there is a tree nobody finds. The three answers 034 gave — the tab
strip, `Cmd+K`, and a toggle in the footer — all describe the app on day two. They describe the
first launch badly, and the first launch is the one where a window with no tree in it reads as a
workspace that failed to load rather than as a pane you can open.

The honest summary is that this was a preference dressed as an argument in both directions, and the
preference changed. Keeping 034's file and reversing it in a new one is the point of the convention:
the next reader finds both halves and can see that the pane's default has been argued twice.

## Consequences

It costs start-up on a large workspace, and the cost is real rather than theoretical. The 5000-node
budget in `docs/performance.md` — first row painted under 4000ms — was comfortable at roughly 2.1s
with the pane shut and is now marginal: one run of `perf.app.test.ts` measured 4393ms and failed it,
a second measured inside the budget and passed. The tree's virtualizer now mounts in the first React
render instead of after a click, so the work that used to overlap the engine's catalog build is on
the critical path to the first paint. `givenARequestRow_whenOpenedAsATab_thenTheEditorMountsInsideItsBudget`
is marginal for the same reason: 9.5ms against an 8ms budget on the failing run.

That is the bill 034 was paying and this record stops paying. Two things follow, and neither is done
here: the 4000ms row wants re-measuring against the pane-open app and re-baselining if it is now
routinely over, and the editor-mount budget wants the same. Until then a failing run of either is a
known consequence of this decision and not a new regression — which is exactly the sentence a
performance budget exists to make unnecessary, so it should not stay true for long.

Nothing about 034's controls or its motion rules is affected, so `docs/design-system.md` needs no
change: a pane that starts open still collapses, still animates the same property, and still arms
`data-sliding` only for the length of a toggle.
