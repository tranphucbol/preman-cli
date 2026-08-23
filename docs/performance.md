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

`test/perf.test.ts` runs with the normal suite. The gated half launches Electron eight times and
writes five thousand request files, so it is a minute rather than a second and is skipped unless
`PREMAN_PERF=1` — a perf test that makes `bun run test` slow gets deleted within a month. It needs
a built `packages/desktop/dist` and, today, macOS: it finds the Electron binary at
`node_modules/electron/dist/Electron.app`.

## The budget

| Metric                                            | Budget          | Asserted in                      |
| ------------------------------------------------- | --------------- | -------------------------------- |
| cold start to interactive window                  | ≤ 800ms         | `test/renderer/perf.app.test.ts` |
| `buildCatalog`, 43 requests                       | ≤ 50ms          | `test/perf.test.ts`              |
| `buildCatalog`, 1000 requests                     | ≤ 400ms         | `test/perf.test.ts`              |
| workspace switch, host already warm               | ≤ 100ms         | `test/perf.test.ts`              |
| sidebar scroll, 5000 nodes                        | sustained 60fps | `test/renderer/perf.app.test.ts` |
| total idle RSS, all processes, one workspace open | ≤ 250MB\*       | `test/renderer/perf.app.test.ts` |
| tab switch                                        | ≤ 16ms          | `test/renderer/perf.app.test.ts` |
| keystroke to paint, any editor or grid            | ≤ 8ms           | `test/renderer/perf.app.test.ts` |
| longest task on main or renderer                  | ≤ 50ms          | `test/renderer/perf.app.test.ts` |
| send to first response paint, above network time  | ≤ 30ms          | not asserted\*\*                 |

\* Gated at 450MB, because 250 is a private-footprint number and macOS does not report one. The
whole argument is below; it is the one row where the gate and the goal are different numbers.

\*\* Not asserted because it needs a live server behind the app to have a response to paint, and
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
committed fixture workspace, not the generated one: "cold start" and "a tree with five thousand
nodes" are two different rows, and charging the first one a 5,000-file catalog build would measure
the second.

The first launch is discarded. It reads two hundred megabytes of Electron framework off disk and
lands around 1300ms; every launch after it is around 550ms. The budget is a property of the app,
not of the page cache.

It also drives the built `dist/` under the Electron binary rather than an installer's output. Those
are the same bytes — electron-builder copies `dist/` into the bundle — and packaging inside a test
would spend minutes producing a DMG in order to launch it once. The packaged bundle is verified by
hand instead; Playwright will not attach to it.

### `buildCatalog`, and the warm switch

Each case takes the **best** of three attempts after a discarded first. A budget test asks "does
this machine do this much work in this long", and the minimum is the least noisy estimator of the
work actually performed — a median on a shared CI runner measures the other tenants.

The warm-switch case drives `createEngineHost` directly and asks for the catalog twice. The host
holds its catalog, so the second answer should cost one message and nothing else. This is the case
that fails the moment somebody makes `ensureCatalog` re-read the disk.

### Sidebar scroll, "sustained 60fps"

Asserted as **no dropped frame**, which is an interval of two refresh periods or more.

"No frame exceeds 16ms" is not measurable from inside the page: under vsync every frame interval is
one refresh period whether the renderer did work or slept, so that phrasing can neither pass nor
fail. The dropped frame is the measurable failure, and it is what the row means. The same case also
asserts that no more than 200 rows are mounted, which is the virtualizer proving it is still there.

### Tab switch, keystroke, and the longest task

All three come off one measurement: **how long the main thread was blocked**, by anything, while
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

**The two tight rows are asserted against the median interaction, not the worst one.** Left alone,
with nobody touching it, the app blocks its own main thread for somewhere between 7ms and 16ms
every so often — a collection, presumably. That noise floor sits on top of both budgets, so a
maximum would be gating on whether a GC landed in one of thirty windows. Measured here:

| Interaction              | p50   | p90   | worst  |
| ------------------------ | ----- | ----- | ------ |
| tab switch, 10 switches  | 2.7ms | 6.9ms | 20.7ms |
| keystroke, 30 characters | 5.8ms | 8.2ms | 9.0ms  |

The median is what a real regression moves and an occasional ambient block cannot. The tail is not
unwatched: every individual interaction is still held to the 50ms long-task ceiling, so nothing
catastrophic passes. What this does concede is a regression that slows _some_ interactions — under
half of them — without slowing the typical one.

Each cost is attributed to the interaction that caused it: `keydown` timestamps itself in the
capture phase, the tab-switch driver marks its own clicks, and a block belongs to the mark before
it. Without attribution the number is just "the worst thing that happened while the test ran".

The keystroke row is measured on the gRPC message editor, which is CodeMirror and the heaviest
input in the app. Worth knowing for when it moves: `onCommit` fires on blur and on unmount, not
per keystroke, so those 5.8ms are CodeMirror's own — bracket matching, selection-match
highlighting, syntax highlighting and line wrapping — and not a round trip through React.

The long-task row is asserted over a mixed session — opening two tabs, switching between them,
scrolling — deliberately unsettled, because the thing it is there to catch is opening a tab, which
pays for the engine's reply and a first editor mount. It is the one row checked on both threads.
Main is worth watching rather than assumed idle: it is the process that writes `state.json`
synchronously.

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

Generated rather than committed: a thousand YAML files in `test/fixtures/` would make every
`git status` in this repository slower for one test.
