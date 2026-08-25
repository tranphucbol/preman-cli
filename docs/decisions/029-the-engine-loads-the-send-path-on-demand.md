# 029: The engine loads the send path on demand

Status: Accepted

## Decision

The engine host imports `@preman/core/api/run.js`, `api/preview.js` and `api/protos.js` **where they
are used**, with `await import(...)`, rather than at the top of `packages/desktop/src/engine/host.ts`.
Three `dispatch` cases and one lazily-constructed `ProtoCache` are the whole change.

`countTests`, `TestResult` and `TestSummary` move out of `packages/core/src/scripts/sandbox.ts` into
`packages/core/src/scripts/tests.ts`. `sandbox.ts` re-exports all three, so no caller breaks;
`report/json.ts` imports from the new module, which is the import that mattered.

`ensureCatalog` schedules a background `import()` of all three, 250ms after the first catalog, on an
`unref`'d timer cleared by `dispose`. The first Send therefore still pays nothing.

`main.ts` forks the engine **above** `createWindow()` instead of below it.

`test/perf.test.ts` walks the static import graph from `engine/entry.ts` and asserts it reaches none
of `@faker-js/faker`, `@grpc/grpc-js`, `@grpc/proto-loader`, `chai` or `csv-parse`. It prints the
chain, not just the package.

`@preman/core` stays synchronous. Decision 003 is untouched: `EngineHost.handle` was already async,
so this is a change to when modules load and not to any interface.

## Rationale

**The measurement came first, and it was not where anyone would have looked.** Opening the app on a
real 33-request workspace, cold, took 6.8 seconds to the first sidebar row. Decision 027's phase
marks put 4.8 of them in one gap — `renderer.catalog.asked` at 2197ms, `engine.start` at 6281ms —
which reads as the engine host being slow to spawn. It was not: the utilityProcess's own
`timeOrigin` was 1490ms, about 180ms after `main.prewarm`, and the 4791ms that followed was inside
its own module evaluation, before `entry.ts` reached line 37.

**What it was evaluating, per package, on a cold page cache:**

| package              | cold, 3 rounds       | warm  | needed to paint a sidebar |
| -------------------- | -------------------- | ----- | ------------------------- |
| `yaml`               | 195 / 275 / 189ms    | 13ms  | **yes**                   |
| `@grpc/proto-loader` | 68 / 41 / 49ms       | 122ms | no                        |
| `@faker-js/faker`    | 2109 / 2007 / 2017ms | 85ms  | no                        |
| `csv-parse/sync`     | 27 / 47 / 157ms      | 2ms   | no                        |
| `@grpc/grpc-js`      | 327 / 347 / 834ms    | 24ms  | no                        |
| `chai`               | 24 / 23 / 149ms      | 2ms   | no                        |
| total                | 2755 / 2741 / 3397ms | 251ms |                           |

Faker is 9.7MB across 458 files and is three quarters of it. Warm it is 85ms, which is why nothing
in the budget suite had ever seen this: decision 016's cold-start row **discards its first launch**
by design, and every other row runs against a page cache the row before it warmed. The one number in
`docs/performance.md` that was ever going to catch this is the one that is defined not to.

**Most of faker's 2.0s was never ours to pay.** `vars/dynamic/faker.ts` imported the barrel,
`@faker-js/faker`. That entry is 8KB of re-exports which statically pull in all 71 locales plus
`base` and construct a `Faker` for each at module scope — 81 files and 3.8MB, against 4 files and
478KB for `@faker-js/faker/locale/en`. Measured with the package's files evicted between every run,
the barrel is 3355 / 3403 / 5430ms and the locale entry 83 / 99 / 100ms; warm, 65-102ms against
11-12ms. Nothing was bought with it. `locale/en.js` and `index.js` re-export `faker` from the same
chunk, so the binding is literally the same object — `root === en` is `true` in one process, and
seeded output is identical across all 99 faker methods preman calls. Nor is the optionality wanted:
Postman's dynamic variables have no locale syntax, so `{{$randomLastName}}` is en and there is
nothing to be compatible with. `$randomLocale` looks like a counterexample and is not — it reads a
71-row ISO language table that lives inside the `en` definitions. The specifier is `FAKER_MODULE` in
`scripts/module-names.ts` because all three bundlers externalise it and none may disagree, and
`test/perf.test.ts` fails if any source names the barrel again. Should a locale ever be asked for,
load that one by tag; loading all 71 to serve one is not a design, it is a default.

**Deferring belongs at the host, not in core.** The alternative was to make `runner.ts` load faker
lazily, which is where the dependency actually is. That reopens decision 003 — core is synchronous,
and `interpolate()` is called from inside a synchronous chain that would all have to become async —
in order to fix a problem that only exists because a GUI process boots before it knows what it will
be asked. The engine host is the seam where "what this process might do" and "what this process is
doing" differ, and `handle` is already `async`. Nothing in the CLI changes: `preman run` loads the
run path because it is about to run something, which is correct.

**`countTests` is the interesting half of the change.** Deferring the three `api/` modules did not
work on its own. `host.ts` also imports `report/json.js`, which imported `countTests` from
`scripts/sandbox.js` — six lines of arithmetic over an array, living in a 660-line module that opens
with `node:vm` and reaches chai, grpc-js and faker. Six hops from a reporter to a fake-name
generator, and no reviewer would ever have seen it in a diff. The function moved to its own file
because counting test results is not running them, and the module boundary should say so.

**The prefetch is 250ms late on purpose.** Warming the send path the instant the catalog is built
would put the same 2.5s of reads back on the same disk the renderer is using to paint the rows the
catalog just gave it. A quarter of a second is long enough for the rows to land and short enough
that no human has reached the Send button. It is `unref`'d because a cache is not a reason to keep a
process alive, and cleared in `dispose` so a test that closes a host does not import three modules
into a torn-down environment.

**The fork moved above `createWindow` because the window was in front of it.** Decision 016 already
established that `utilityProcess.fork` must not queue behind Chromium, and moved it off
`did-finish-load`; it left it below `createWindow()`, which reads a 792KB icon, constructs a
`BrowserWindow` and calls `loadFile`. Measured cold that is 400–550ms in which the engine does not
exist. Nothing between `createHostRegistry` and the fork touches the window.

**The guard is a source-graph assertion, not a timing one.** The regression this invites is a
one-line static import that nobody notices, and its cost is invisible on any warm machine — which
is every machine in CI and every machine a developer measures on. A millisecond budget cannot catch
it. Walking the import graph can, in eleven milliseconds, with no build step, and it fails with the
chain rather than with a number. Reintroducing the `countTests` import fails it with all three
packages and all six hops named.

## Consequences

**Paired measurement, alternating, three rounds each.** The before column is `HEAD` built in a
detached worktree so both trees are real builds of real source rather than one tree measured twice.
Every launch is preceded by evicting the six packages _and_ that build's own `dist/`, so neither
side gets to keep its bundle in cache; "cold" is reproduced by rewriting each file in place, which
is decision 027's just-written-tree effect used deliberately. One warm-up launch is discarded so
the 200MB Electron framework is resident for all six measured runs. The workspace is the real
33-request one. Medians, with the three runs beside them:

| phase                    | before (median) | runs            | after (median) | runs            |
| ------------------------ | --------------- | --------------- | -------------- | --------------- |
| `main.start`             | 395ms           | 395 / 434 / 381 | 454ms          | 454 / 357 / 473 |
| `main.prewarm`           | 645ms           | 651 / 645 / 635 | 541ms          | 586 / 424 / 541 |
| `main.port-posted`       | 1139ms          | 1089/1139/1657  | 1136ms         | 1201/1023/1136  |
| `renderer.catalog.asked` | 1519ms          | 1519/1396/1948  | 1392ms         | 1470/1305/1392  |
| `engine.start`           | 5406ms          | 5870/4527/5406  | 1677ms         | 2317/1611/1677  |
| `engine.catalog.exit`    | 5449ms          | 6136/4577/5449  | 1715ms         | 2367/1651/1715  |
| **first sidebar row**    | **5544ms**      | 6592/4949/5544  | **1995ms**     | 2585/1905/1995  |
| engine's own module eval | 4651ms          | 5142/3849/4651  | 1152ms         | 1418/1152/1110  |

The gap this record exists to close — `renderer.catalog.asked` to `engine.start`, the renderer
waiting on a process still evaluating modules — was 3887ms and is 285ms. That is 93% of it, and it
is the whole of the 2.8x on the first row. What remains in the after column is `yaml`, the node
builtins and the engine's own bundle, which is the floor.

`main.prewarm` moving 645ms to 541ms is the second change, forking above `createWindow` rather than
below it: the fork's own queue time went from 254ms to 68ms.

Warm, the first row is 906ms and the engine's module evaluation is 82ms against 241ms before — and
`engine.start` now lands at 316ms, _before_ `main.port-posted` at 456ms, so the catalog build starts
the instant the port arrives rather than after a boot the port was waiting on.

The runs within a column still spread by more than a second, because the disk is still busy from
the eviction that made the run cold. That spread is the honest reason there is no new budget row:
the number this change moves is only observable on a machine whose page cache has just been
destroyed, and a gate set on that is a gate on the runner's disk. The guard asserts the property
instead. It is also why the gated suite must be run from a settled disk — measured immediately
after these probes it failed two rows, and passed 14 of 14 ninety seconds later with nothing
changed.

**The built engine is no longer one file.** `dist/engine/` was `entry.js` at 365KB; it is now
`entry.js` at 77KB plus ten chunks. Everything reachable before the first catalog — 211KB across six
of them — imports `yaml` and node builtins and nothing else; faker, grpc-js, proto-loader, chai and
csv-parse appear only in chunks no static import reaches. electron-builder copies the directory, so
decision 018 does not change, but "the engine host is a file" is now "the engine host is a file with
siblings", and `HostRegistry` forks a module that resolves relative imports next to itself.

**Rolldown's chunking became load-bearing, and it is guarded indirectly.** What lands in the eager
set is decided by the bundler, not by us; the test asserts the source graph instead, on the
reasoning that a chunk can only be eager if some module in it is statically reachable. That is true
of rolldown today and is not a documented guarantee. If the chunking strategy changes, the guard
will pass while the bundle regresses — the check that would catch that has to read `dist/`, which
means the gated suite, which means CI-only. It has not been written.

**There are now two import paths to `countTests`, and only one of them is cheap.** `sandbox.ts`
re-exports it so that a caller already holding the sandbox needs no second import, which is the
right ergonomics and the wrong affordance: the expensive path is the one that autocompletes first.
The comment on the re-export says so. The guard is what actually enforces it.

**A Send inside the first quarter-second pays the import inline.** Before the prefetch fires, or
before the first catalog exists at all, the first `run` awaits up to the same 2.5s the boot used to
spend — once, and only with a cold cache. That is a worse worst case for one interaction in exchange
for a better one for every launch, and it is the trade this decision is: the sidebar is what the
user waits for with nothing to look at, and the send path is what they wait for having just clicked
something.

**It exposed a weakness in the gated suite rather than causing one.** The documented invocation is
`bun run build && PREMAN_PERF=1 bunx vitest run test/renderer/perf.app.test.ts`, and the build
rewrites `dist/`, so the suite's first launch reads a tree macOS has just written — the same effect
decision 027 found in `writeBigWorkspace`, from the other direction. The cold-start row discards its
first launch and survives; `givenTheCommittedFixture_whenOpened_thenNoSkeletonIsEverPainted` launches
once and does not. Measured on this machine, immediately after a build: before this change the run
fails twice, cold start at 976ms against 800 and a skeleton at 846ms; after it, once, with the
skeleton at 616ms. Run a second time, with `dist/` warm, both revisions pass all fourteen. So the
change moves that case toward passing and does not fix it. The fix is the one `writeBigWorkspace`
already uses — read the tree back before the clock starts — and it belongs to that file, not here.

**What this does not fix.** The engine still spends around 1000–2200ms cold before `engine.start`,
against 82ms warm. That is `yaml`, its own 211KB of chunks, and Electron's ESM loader, and none of
it is obviously removable. `docs/performance.md`'s note that a large open spends 900ms before it
asks for anything is unchanged — this decision moves the wall behind that 900ms, not the 900ms.
