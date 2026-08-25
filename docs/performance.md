# preman performance

The desktop app has a performance budget, and it is asserted rather than hoped. This file is the
contract: the numbers, what each one actually measures, and where it fails when it fails.

The CLI has no budget. It runs one selector and exits, and the thing a user waits for is the
network. Everything here is about the app, plus the two core functions it leans on hardest.

## Running the gate

```sh
bun run test                                        # the half that needs no window
bun run build && PREMAN_PERF=1 bunx vitest run test/renderer/perf.app.test.ts
```

`test/perf.test.ts` runs with the normal suite. The gated half launches Electron twelve times and
writes five thousand request files, so it is a minute rather than a second and is skipped unless
`PREMAN_PERF=1` — a perf test that makes `bun run test` slow gets deleted within a month. It needs
a built `packages/desktop/dist` and, today, macOS: it finds the Electron binary at
`node_modules/electron/dist/Electron.app`.

## The budget

| Metric                                            | Budget          | Asserted in                      |
| ------------------------------------------------- | --------------- | -------------------------------- |
| cold start to interactive window                  | ≤ 800ms         | `test/renderer/perf.app.test.ts` |
| open a 5000-request workspace, to first row       | ≤ 4000ms\*      | `test/renderer/perf.app.test.ts` |
| the same open, to the window saying it is opening | ≤ 2000ms        | `test/renderer/perf.app.test.ts` |
| `buildCatalog`, 43 requests                       | ≤ 50ms          | `test/perf.test.ts`              |
| `buildCatalog`, 1000 requests                     | ≤ 400ms         | `test/perf.test.ts`              |
| workspace switch, host already warm               | ≤ 100ms         | `test/perf.test.ts`              |
| console merge, 5000 rows in each of three streams | ≤ 10ms          | `test/perf.test.ts`              |
| sidebar scroll, 5000 nodes                        | sustained 60fps | `test/renderer/perf.app.test.ts` |
| total idle RSS, all processes, one workspace open | ≤ 250MB\*\*     | `test/renderer/perf.app.test.ts` |
| tab switch                                        | ≤ 16ms          | `test/renderer/perf.app.test.ts` |
| keystroke to paint, any editor or grid            | ≤ 8ms           | `test/renderer/perf.app.test.ts` |
| open a request tab, editor mounted                | ≤ 8ms           | `test/renderer/perf.app.test.ts` |
| theme switch                                      | ≤ 16ms          | `test/renderer/perf.app.test.ts` |
| density switch                                    | ≤ 50ms          | `test/renderer/perf.app.test.ts` |
| longest task on main or renderer                  | ≤ 50ms          | `test/renderer/perf.app.test.ts` |
| send to first response paint, above network time  | ≤ 30ms          | not asserted\*\*\*               |

\* Gated at 4000ms against a goal of 2500ms, because this is the one row that cannot discard its
first launch: a second launch would find the catalog already built and would measure the warm
switch row instead. The gate sits above the worst of three observed runs rather than beside the
goal.

\*\* Gated at 450MB, because 250 is a private-footprint number and macOS does not report one. The
whole argument is below. This and the row above are the two where the gate and the goal are
different numbers, and both say why in the section that reads them.

\*\*\* Not asserted because it needs a live server behind the app to have a response to paint, and
separating the paint from the network means instrumenting from the `response-head` push rather
than from the click. That is a fixture, not an assertion, and it has not been built. It is
feasible — `test/e2e.test.ts` already boots a real gRPC server in-process — so this row is
outstanding work rather than something the design makes unnecessary.

## How each number is read

A budget row is worthless if two people read it differently, so each of these says what it counts.

### Cold start, ≤ 800ms

Measured from the main process's own `performance.timeOrigin` to the moment the first
`[role="treeitem"]` exists in the renderer. That is the window being usable, not the window being
visible.

It excludes roughly fifty milliseconds of process spawn before any JavaScript runs, and all of
Playwright's launch scaffolding — neither of which the app can affect. It is measured against the
committed fixture workspace, not the generated one: "cold start" and "open a 5000-request
workspace" are two different rows, and charging the first one a 5,000-file catalog build would
measure the second.

The first launch is discarded. It reads two hundred megabytes of Electron framework off disk and
lands around 1300ms; every launch after it is around 550ms. The budget is a property of the app,
not of the page cache.

It also drives the built `dist/` under the Electron binary rather than an installer's output. Those
are the same bytes — electron-builder copies `dist/` into the bundle — and packaging inside a test
would spend minutes producing a DMG in order to launch it once. The packaged bundle is verified by
hand instead; Playwright will not attach to it.

### Opening a five-thousand-request workspace, gated at 4000ms

The row the cold-start row keeps pointing at. Same axis — the main process's own
`performance.timeOrigin` — but against a generated workspace, and read to the moment the sidebar
has actually painted rows rather than to the moment one exists in the DOM.

It is read from the app's own `performance.mark` calls rather than from Playwright's view of the
page, because the number is only useful if it says where the time went, and three processes are
involved of which one is a page. Fourteen phases are marked: four in the main process, three in the
engine host, seven in the renderer. `PHASES` in `packages/desktop/src/engine/protocol.ts` is the
list; decision 027 is why the marks ship rather than living behind a build flag, and why the engine
host answers a `phases` request even after it has been disposed. The perf suite joins the three
reports on their `timeOrigin`s and asserts a named causal order over them, so a phase that stops
firing — or starts firing in the wrong place — fails a case rather than quietly leaving a gap.

One of the fourteen is optional, and it is the only one whose absence is the good outcome:
`renderer.skeleton-shown` fires when the window gives up waiting and draws a placeholder, and a
workspace that opened fast enough never drew one. So the case that reads every declared phase skips
it, and the two causal edges it sits on are skipped with it.

Measured 2563, 2742 and 3167ms over three runs. One of them, phase by phase:

| span                                                        | cost   |
| ----------------------------------------------------------- | ------ |
| process spawn to `main.start`, which is after `whenReady()` | 310ms  |
| store, host registry, IPC and menu, to `main.prewarm`       | 182ms  |
| window created, `did-finish-load`, port posted              | 240ms  |
| port reaches the renderer                                   | 187ms  |
| engine host's own process finishes booting                  | 175ms  |
| **`buildCatalog`, 5000 requests**                           | 1258ms |
| catalog crosses the port, re-index, first paint             | 31ms   |

Half of it is one call, and that call is close to its floor: read and parsed in isolation, the same
five thousand files cost 424ms of `readFileSync` and 274ms of `parseYaml`. The engine host's boot
and the build are already back to back, so there is nothing there to overlap either. What is left
is the 900ms before the catalog is even asked for, which is four processes' worth of start-up and
is the same 900ms the cold-start row spends.

This row does not discard its first launch, and cannot: a second launch of the same workspace finds
the engine host's catalog already built, which is the warm-switch row and not this one. So the
number carries the two hundred megabytes of Electron framework that the cold-start row gets to
leave out. The goal is 2500ms; the gate is 4000ms, set above the worst of the three runs rather
than beside the goal. What it defends is the shape — an open linear in the number of requests. A
change that makes it quadratic blows straight through 4000; a change that costs three hundred
milliseconds is a review comment rather than a red suite.

One thing this row does **not** measure, and did until the instrument said otherwise. On macOS the
first read of a just-written tree costs an order of magnitude more than every read after it: over
five thousand request files, pass one is 6121ms where passes two and three are 458ms and 433ms.
`writeBigWorkspace` generates the workspace immediately before the launch, so that bill landed on
this row and on no other — `test/perf.test.ts` discards a first attempt and never saw it. Charged,
the open read as twelve seconds. `writeBigWorkspace` now reads every file back before it returns,
which costs the same wall clock it always did and puts it somewhere it cannot be mistaken for the
app.

### The same open, to the window saying it is opening, gated at 2000ms

The half of the row above that the row above used to hide. Four seconds to a usable tree is
defensible for five thousand requests; four seconds of "No workspace open." was not, and the
difference between the two sentences is one phase.

`renderer.skeleton-shown` closes it. The placeholder cannot appear before the port that told the
renderer to expect a workspace — the first four spans of the breakdown above, 919ms — and is held 150ms
behind it, so the measurement is around 1100ms and is bounded by process start-up rather than by the
size of the workspace. The gate is 2000ms, which is roughly twice that, because what it defends is
"the wait is announced before the user has decided the app is broken" and not a number: the
start-up it is made of is already gated by the cold-start row.

The delay is why there is a second case against the committed fixture asserting the phase never
fires at all. A 43-request workspace is on screen well inside 150ms, so no placeholder is drawn, no
pulse starts and no extra commit happens — which is the whole justification for the delay existing.
Drop it to zero and that case is what fails, rather than a screenshot nobody takes.

### `buildCatalog`, and the warm switch

Each case takes the **best** of three attempts after a discarded first. A budget test asks "does
this machine do this much work in this long", and the minimum is the least noisy estimator of the
work actually performed — a median on a shared CI runner measures the other tenants.

The warm-switch case drives `createEngineHost` directly and asks for the catalog twice. The host
holds its catalog, so the second answer should cost one message and nothing else. This is the case
that fails the moment somebody makes `ensureCatalog` re-read the disk.

### The console merge, ≤ 10ms

`mergeConsole` folds script logs, `pm.sendRequest` summaries and main calls into one `seq`-ordered
list, and the drawer re-derives it on every console event — thousands of times in a long run. The
case builds `CONSOLE_MAX_LINES` rows in each of the three streams with round-robin `seq`s, so no
finger is exhausted early and every comparison is paid for, and merges 15,000 rows. It measures
around 2ms on the development machine; the budget is set at 10ms because what it is really guarding
is the shape of the function. It is a three-finger merge over three already-sorted inputs, and the
obvious one-liner — concat and sort — is O(n log n) per log line and would blow this by an order of
magnitude while still looking correct.

### Sidebar scroll, "sustained 60fps"

Asserted as **no dropped frame**, which is an interval of two refresh periods or more.

"No frame exceeds 16ms" is not measurable from inside the page: under vsync every frame interval is
one refresh period whether the renderer did work or slept, so that phrasing can neither pass nor
fail. The dropped frame is the measurable failure, and it is what the row means. The same case also
asserts that no more than 200 rows are mounted, which is the virtualizer proving it is still there.

### Tab switch, keystroke, editor mount, and the longest task

All four come off one measurement: **how long the main thread was blocked**, by anything, while
the interaction happened. A task that reposts itself runs continuously in the renderer — and in
the main process, where `setImmediate` is the equivalent — and the interval between two of its
runs is how long something else held the thread.

That is not the literal reading of "keystroke to paint", and the substitution is deliberate.
Waiting for the next frame after a keystroke measures mostly the wait for the display, for the
same reason the scroll row cannot be read literally: under vsync, an app that did one microsecond
of work and an app that did four milliseconds of work both paint at the next refresh. Gating on
that would gate on the refresh rate of whoever runs the suite. Blocking time is the part the app
controls, and it catches everything — an event handler, a React commit, a style and layout pass,
an engine reply being deserialized — whoever scheduled it.

It misses compositing, which is off-thread, and it cannot cover start-up, since the page has to
exist before the probe can be installed. The start-up row covers that window as a whole.

**The tight rows are asserted against the median interaction, not the worst one.** Left alone,
with nobody touching it, the app blocks its own main thread for somewhere between 7ms and 16ms
every so often — a collection, presumably. That noise floor sits on top of each budget, so a
maximum would be gating on whether a GC landed in one of thirty windows. Measured here:

| Interaction              | p50   | p90   | worst  |
| ------------------------ | ----- | ----- | ------ |
| tab switch, 10 switches  | 4.7ms | 6.9ms | 13.8ms |
| keystroke, 30 characters | 6.1ms | 7.4ms | 10.9ms |
| tab open, 10 opens       | 3.7ms | 8.6ms | 32.4ms |

The tab-switch row was 3.4/5.2/7.6ms before the active section tab's underline became a projected
element. Switching open requests remounts the section tabs, so each switch now measures two
`getBoundingClientRect` calls and a `transform` animation that did not exist. The median moved
1.3ms and the worst 6.2ms — and the worst is the _first_ switch of the ten, 13.8ms against 3.4ms for
the last, which is what paying for a projection tree once looks like. Still inside 16ms, and worth
knowing which end of the distribution it landed on: a second `layoutId` on this interaction is the
one that would push it over.

The median is what a real regression moves and an occasional ambient block cannot. The tail is not
unwatched: every individual interaction is still held to the 50ms long-task ceiling, so nothing
catastrophic passes. What this does concede is a regression that slows _some_ interactions — under
half of them — without slowing the typical one.

Each cost is attributed to the interaction that caused it: `keydown` timestamps itself in the
capture phase, the tab-switch driver marks its own clicks, and a block belongs to the mark before
it. Without attribution the number is just "the worst thing that happened while the test ran".

The keystroke row is measured on the gRPC message editor, which is CodeMirror and the heaviest
input in the app. Worth knowing for when it moves: `onCommit` fires on blur and on unmount, not
per keystroke, so those 6.1ms are CodeMirror's own — bracket matching, selection-match
highlighting, syntax highlighting, the masked parse from [decision
023](decisions/023-the-parser-is-fed-a-masked-document.md), and line wrapping — and not a round trip
through React.

**The editor-mount row is the same editor, opened rather than typed into.** Opening a request tab is
the only interaction in the app that constructs a CodeMirror instance, and it is also the one that
waits on the engine, so it was worth attributing rather than leaving inside the long-task row. Ten
gRPC rows are clicked in turn, 250ms apart — longer than the 50ms the other interaction cases idle,
because a tab open is not finished when the click returns and a shorter window would charge half of
each open to the next one.

The interesting number is the shape, not the median. The first open of a session costs 32ms and every
one after it costs about 3.5ms: the first pays once, for CodeMirror's module graph, the JSON grammar,
and the engine's first reply on a cold port. So the row is held to 8ms at the median — what one
keystroke in the same editor costs — and the first mount is caught by the 50ms ceiling instead. It
has 18ms of headroom there, and it is the number to watch, because everything that gets added to an
editor is paid for once in that first mount.

Masking for `{{token}}` does not move either row. Measured directly: the regex pass is 1–4% of the
parse it wraps — 5µs on a 2KB body, 0.2ms on a 118KB one — against 0.13ms and 5.5ms for the parse
itself. There is no row for it, because a row that measures 4% of another row's work only tells you
the other row moved.

The long-task row is asserted over a mixed session — opening two tabs, switching between them,
scrolling — deliberately unsettled, because it is the one place a cost nobody thought to attribute
still has to fit inside fifty milliseconds. It is also the one row checked on both threads. Main is
worth watching rather than assumed idle: it is the process that writes `state.json` synchronously.

### Theme switch, ≤ 16ms — and density switch, ≤ 50ms

Both are measured the same way as a tab switch: blocking time on the renderer's main thread,
attributed to the click that caused it, driven from the settings pane. Ten themes and six densities
are chosen in turn, with the probe marking each click.

They are two rows and not one because they are two different amounts of work, and pretending
otherwise would hide a regression in the cheap one.

A theme switch writes 58 custom properties onto `:root` and nothing else. No component re-renders
for the colours — CodeMirror is not reconfigured, no editor remounts — so what is being paid for is
one style recalculation, a repaint, and one forced flush, which is what stops the 58 writes from
starting a colour transition on every mounted control at once (decision 26). That is a tab switch's budget, 16ms at the median with the
same 50ms ceiling on every individual switch, for the same reason: the ambient 7–16ms noise floor
described above sits on top of it.

A density switch writes eight and then invalidates the layout of six virtualized lists, each of
which re-measures. It is held only to the 50ms long-task ceiling, on the worst switch rather than
the median. Holding it to 16 would be asserting that reflowing every list in the app costs what
swapping a colour costs, which is not true and not worth making true: density is changed once and
then lived with, unlike a tab, which is switched all day.

**There is no cold-start row for this.** Themes are bundled statically into the renderer's chunk and
the preferences read is a `sendSync` before first paint, so the feature adds bytes to a bundle that
is already measured and no new I/O to a start-up path that is already gated at 800ms. If either
assumption changes — a theme loaded from disk, an async preferences read — this is the row that
would have to appear.

### The motion library, +126kB of renderer chunk

Not a budget row — a recorded number, because [decision
026](decisions/026-the-app-is-allowed-to-move.md) spends bytes on a start-up path that is already
gated, and the only thing worse than paying that would be paying it without writing down what it
was.

`motion` behind `LazyMotion features={domAnimation} strict` took the renderer chunk from 1,190,365
to 1,258,614 raw bytes at the gate — **+68,249, or +5.7%** — and to 1,269,059 once the banner and
overlay surfaces were actually wired to it, so **+78,694 all in, +6.6%**. That was the
`domAnimation` feature bundle.

The projection engine was then bought too, for the tab underline that travels between triggers.
`domMax` in place of `domAnimation`, same source otherwise, is 1,315,874 — **+46,815 bytes** — and
the underline and the console's height animation add 482 on top, for a chunk of **1,316,356: +125,991
over the pre-Motion baseline, +10.6%**. Decision 026 estimated the projection engine at "another
10kB" and refused it partly on that basis. That estimate was gzipped and from an older major, and
nothing in the real path gzips — Electron loads this chunk over `file://` — so the honest figure is
4.7x the one the ADR was written against. It is recorded here rather than fixed there, because the
estimate being wrong is the interesting part.

Warm cold start did not move. Measured three times each, in isolation rather than after the other
eight cases in that file: 914/724/771ms without the library and 841/733/691ms with it. The gated
case, which takes the best of its own repeats, reads 835ms without and 875ms with — so it fails on
this machine either way, and it failed before any of this landed.

That is the reason the comparison here is a delta and not an absolute. This machine does not reach
the 518–582ms quoted above, and a row that cannot pass on the machine in front of you can still
answer the only question a byte delta raises: whether the library is what pushed it over. It is not
— 40ms of a 220ms spread — and the 800ms gate is what will catch it if that stops being true. The
eight interaction budgets in the same file, including the theme switch the `data-retheme` guard was
added for, pass with the animations in.

### Idle RSS, gated at 450MB

The 250MB row and the "~120MB idle" Electron floor from [decision
001](decisions/001-electron-not-tauri.md) are both private-footprint numbers.
What Electron can report on macOS is `workingSetSize`; `privateBytes` is `0` there. Resident pages
are counted once per process, so the shared Chromium framework is charged five times over —
browser, GPU, network service, the tab, and the engine host.

Measured idle total is about 372MB: browser 105, GPU 61, network 25, tab 100, engine host 81.

The gate is therefore set above the measured value rather than above the plan's, because a gate
that cannot pass is not a gate. What it still catches is what the row was defending: a leak, or a
sixth process nobody meant to spawn.

## Known headroom

**`buildCatalog` at 1000 requests is the thinnest row: 294ms best, 380ms worst, against 400ms.**

Of that, the directory walk is 28ms and parsing 644KB of request headers is 200–270ms — roughly two
thirds of the total, at about 3MB/s. `readRequestHeader` reads four fields and parses the whole
file to get them.

It was left alone deliberately. A partial or regex header reader would be a second YAML parser with
its own fallbacks, free to drift from the real one, and `order` legitimately appears at the end of a
request file, so it cannot stop early either. This is the first row that will fail if the request
format grows, and when it does the fix is a cache keyed on mtime, not a faster guess at the syntax.

**A five-thousand-request open spends 900ms before it asks for anything.** That is the span from
process spawn to `renderer.catalog.asked`, and it is four processes starting up: `whenReady`, the
store and the menu, a Chromium document, and the engine host's own Node boot. It is the same 900ms
the cold-start row spends and it is not specific to a large workspace, which is why the fix is not
in this row.

It is also the noisiest part of the number. On one run in three, `resume()` takes about 690ms
between receiving the port and asking for the catalog — it reads app state back over IPC first —
where the other two take under two milliseconds. Nothing has been changed for it yet; the phase
marks are new and one anomaly in three runs is not yet a pattern.

## Changes made to meet the budget

**Cold start was 1750ms.** The breakdown was 534ms to a renderer context, 252ms of HTML and
JavaScript, then about 600ms of blank window waiting for the engine — because `openWorkspace`, and
therefore `utilityProcess.fork`, ran on `did-finish-load`. That serialises a whole Node boot after
Chromium's for no reason: the engine host is a Node process and the window is a Chromium one, and
nothing orders them.

`HostRegistry.prewarm(root)` now forks at launch and only the port transfer waits for a document
that has run its script. Warm launches are 518–582ms.

**The sandbox's script libraries are already lazy.** `packages/core/src/scripts/modules.ts` resolves
them through `createRequire` on first use; only `chai` is eager, at 6ms. Making them eager would
cost 1281ms for cheerio alone, and 2.2s for the set — on every engine host, for scripts most
workspaces never write.

## Where the fixtures come from

`test/support/big-workspace.ts` — `writeBigWorkspace(n)` writes an n-request workspace into a temp
directory and returns `{root, requests, nodes, cleanup}`. Ten requests per folder, five folders per
collection, alternating gRPC and HTTP, each request carrying a realistic message, metadata and two
scripts.

It reads every file back before it returns. That looks like waste and is not: the first read of a
just-written tree costs six seconds where the second costs four hundred milliseconds, and a
generator that leaves that bill unpaid hands it to whichever case reads first. The argument is in
the section on the five-thousand-request open, and in the function's own comment.

Generated rather than committed: a thousand YAML files in `test/fixtures/` would make every
`git status` in this repository slower for one test.
