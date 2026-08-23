# 017: Interaction budgets measure blocking time, attributed, at the median

Status: Accepted

## Decision

The tab-switch, keystroke and long-task rows are asserted by a probe that measures **main-thread
blocking time**, not time to paint.

Each block is **attributed** to the interaction that caused it: `keydown` timestamps itself in the
capture phase, and the tab-switch driver marks its own clicks, so a case reports the cost of its
own interaction rather than the worst thing that happened while it ran.

The two tight rows — tab switch ≤16ms, keystroke ≤8ms — assert the **median** interaction. The tail
is held by the 50ms long-task row instead.

## Rationale

**Blocking, not paint, because of vsync.** An app that did one microsecond of work and one that did
four milliseconds both paint at the next refresh. Timing to the next frame gates on the display,
not on the app. The sidebar scroll row already had to be phrased this way; these rows have the same
problem and now the same answer.

**Attribution, because a global maximum measures the environment.** Two intermediate versions of
these tests failed on exactly that: a global max at 8ms failed at 14.5ms, and a global max at 16ms
failed at 20.7ms. Both were dominated by ambient work with no interaction in flight.

**The median, because the idle floor is above the budget.** Measured with nobody touching the app,
the renderer still blocks its own main thread for 6.8ms and 15.6ms in two separate runs. Against
that floor, a max-based gate on an 8ms budget is testing whether a GC happened to land inside one
of thirty windows. Attributed medians are comfortably inside: tab switch p50 2.7ms (p90 6.9,
worst 20.7), keystroke p50 5.8ms (p90 8.2, worst 9.0).

## Consequences

**A regression that slows some interactions without slowing the typical one will not fail this.**
That is the concession, stated plainly. The 50ms long-task row is what stops the tail becoming
unbounded, and it asserts both the renderer and the main process.

The probe is not free to write: it reposts a task ~550,000 times a second, so samples under 1ms are
dropped at the source. An early version shipped 600,000 numbers over CDP. `ticks` is exposed as a
getter so a case can prove the probe ran even when nothing blocked.

Per-keystroke cost is CodeMirror's own — bracket matching, selection-match highlighting, syntax
highlighting, line wrapping. `CodeEditor.onCommit` fires on blur and unmount, not per keystroke, so
there is no React round-trip per character to blame or to optimise.
