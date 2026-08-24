# 027: The app reports its own phases

Status: Accepted

## Decision

The app marks thirteen named boundaries of a workspace open with `performance.mark`, in all three
processes, and those marks **ship**. There is no build flag and no debug build.

The names live in `packages/desktop/src/engine/protocol.ts`, beside `ENGINE_PORT_MESSAGE`, together
with `markPhase` and `readPhases`. Four are marked by the main process, three by the engine host,
six by the renderer.

The engine host's report leaves over the wire as a new `phases` engine request. That request is
answered **before** `dispatch`'s disposed check — the one request that is, and the only one that
ever will be.

The renderer parks a reader on `window` under `premanPhases` that returns its own report and the
engine's together. Nothing in the UI reads either.

`test/renderer/perf.app.test.ts` joins the three reports on their `timeOrigin`s and asserts one new
budget row: opening a five-thousand-request workspace, to first row painted, ≤ 4000ms. Wall clock.
This does not replace decision 017's blocking-time instrument; the two coexist.

## Rationale

**The marks ship because a build flag would measure a different app.** An instrument that only
exists in a profiling build makes the shipped binary the one thing nobody can profile, and puts the
measured build one flag away from the one users run. The cost is thirteen `performance.mark` calls
per workspace open — sub-microsecond each, once, against an open measured in seconds. The marks
carry timings and nothing else: no paths, no node ids, no bodies, so shipping them leaks nothing.

**The names live on the wire contract because three processes have to spell them the same way.**
`protocol.ts` is the only module the main process, the engine host and the renderer all import, for
exactly the reason decision 002 gives for `ENGINE_PORT_MESSAGE`. A name spelled twice across a
process boundary would produce a timeline that silently loses a step rather than one that fails.
The record is grouped by process rather than ordered by clock, because it is not ordered by clock:
the engine's catalog build is triggered by the renderer asking for it. The causal order is a
separate, asserted list in the perf suite, which is the only place all three reports are in hand.

**The engine host needs a wire route because a `utilityProcess` has no CDP endpoint.** Playwright
can evaluate in the main process and in the page; the engine host is reachable only over the port it
was handed. That process holds `buildCatalog`, which is the single largest phase of a slow open — so
without a route, the one phase that dominates the number is the one an external profiler is
structurally blind to.

**The disposed-host exception, scoped to one kind.** `dispatch` refuses everything after `dispose`
because a disposed host has closed its watcher and its catalog can no longer be trusted to match
the disk. A phase report is not workspace state: it is a record of something that already happened,
so there is no stale answer for it to give. And a diagnostic readout is wanted most precisely when
something has gone wrong, which includes a host that has fallen over. The hole is one request wide
and pinned by a pair of cases sitting next to each other in
`test/desktop.protocol.test.ts` — one that the report still answers, one that the catalog still
refuses.

**The reader is on `window` because nothing else can reach both reports.** The port is transferred
into the page, and the engine client is a module-scoped value in the renderer bundle that
`page.evaluate` cannot name. `PremanBridge` is the wrong home: the preload has no port. A named
`window` key is the only seam, and a reader is not a view, so "no UI reads the marks" still holds.

**Wall clock and blocking time are two instruments for two questions.** Decision 017 measures
main-thread blocking, attributed, at the median, because the question there is "does this
interaction feel instant" and under vsync a time-to-paint number gates on the display rather than
on the app. The question here is different: "the app was not usable for two seconds — where did the
two seconds go", and most of that answer is not on the renderer's main thread at all. It is process
spawn, a port handshake, and a directory walk in another process. Blocking time cannot see any of
it. So this row is wall clock, and it is a whole-open number rather than an interaction one.

## Consequences

**The instrument's first act was to disprove the number the row was written around.** The plan
this came from assumed a five-thousand-request open cost about 1200ms and set the gate at 3500.
Measured, it was 11.6 to 13.9 seconds. The phases said where: eleven of those seconds were inside
one `buildCatalog` call, which read as the engine going quadratic.

It was not. `writeBigWorkspace` generates the workspace immediately before the launch, and on macOS
the first read of a just-written tree costs an order of magnitude more than every read after it —
6121ms against 458ms and 433ms, over five thousand files. That bill can only land on this row: it
is the only one that reads a freshly generated tree without discarding a first attempt.
`writeBigWorkspace` now reads every file back before it returns, which costs the same wall clock
it always did and puts it where it cannot be mistaken for the app. The open then measured 2563,
2742 and 3167ms. Warm, `buildCatalog` over five thousand requests is 918ms, of which 424ms is
`readFileSync` and 274ms is `parseYaml`, and it is close enough to that floor that there is nothing
algorithmic left to take out.

Two things follow. The number a budget row asserts is worth as little as the instrument that
produced it, and this one was wrong by a factor of five in a direction that would have read as an
engine defect. And a fixture generator is part of the measurement: the cost of _creating_ a fixture
has to be paid before the clock starts, exactly as decision 016's cold-start row already discards
its first launch.

**The new row's gate is looser than its goal, and that is a known weakness.** Measured worst of
three is 3167ms; the goal is 2500ms; the gate is 4000ms. The reason is structural: this is the one
row that cannot discard its first launch, because a second launch of the same workspace finds the
catalog already built and would measure the warm-switch row instead. So the number carries the two
hundred megabytes of Electron framework that the cold-start row gets to leave out, and it carries
whatever the CI runner's disk was doing. What the gate defends is the shape — an open linear in the
number of requests — not the last few hundred milliseconds. A three-hundred-millisecond regression
is a review comment here, not a red suite. Decision 016's standard is that a budget is an
assertion; this row meets it, at a threshold the same document already accepted once for idle RSS.

**Thirteen names are now a maintained vocabulary.** A phase added to the record and marked nowhere
fails `givenAColdOpen_whenPhasesRead_thenEveryDeclaredPhaseFired`, which iterates the record rather
than a list. A phase that starts firing in the wrong place fails the causal-order case. Moving a
mark is therefore a two-file change, on purpose.

**A profiler can now read a shipped app without a debugger.** Open the devtools console and call
`await window.premanPhases()`. That is a supported surface for diagnosis and an unsupported one for
anything else; it has no test asserting its shape beyond what the perf suite needs.

**What this does not do.** It does not make the app faster; it made a _test_ faster by nine
seconds, which is not the same thing and should not be mistaken for it. The blank sidebar that
prompted the work is a correctness bug in the empty panes and is plan 021's problem; this decision
only makes the wait attributable. There is no phase view in the console drawer, and no phase for
`send` to first response paint — that row in `docs/performance.md` is still outstanding for the
reason it always was, which is that it needs a live server fixture and not an instrument.
