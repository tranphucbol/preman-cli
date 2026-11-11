# The test suite

## Running it

```sh
bun run test                          # everything
bun run test -- test/e2e.test.ts      # one file
bun run test -- -t "given a proto"    # one name across the suite
bun run test:watch                    # re-run on change
```

One vitest project covers every package (`vitest.config.ts`). The parts worth knowing:

- include is `test/**/*.test.ts` (`vitest.config.ts:15`). A test placed next to the source it
  covers is not run. All tests live under `test/`.
- environment is `node` (`vitest.config.ts:46`), including the renderer suites. They test modules,
  not a DOM.
- the per-test timeout is 20 seconds (`vitest.config.ts:16,47`).
- `NO_COLOR=1` is forced (`vitest.config.ts:48`) because several suites assert exact CLI output and
  vitest sets `CI=1`, which would otherwise turn colour on.
- `@preman/core`, `@preman/cli` and `@preman/desktop` resolve to `src/`, not `dist/`
  (`vitest.config.ts:32-39`). The suite tests source; it does not need a build.

Names read `givenX_whenY_thenZ`. Match the file you are adding to.

## What covers what

| Group                   | Files                                                                                                                                                             | Notes                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| End to end              | `test/e2e.test.ts`, `test/http-e2e.test.ts`, `test/tls-e2e.test.ts`                                                                                               | Boot a real in-process server and call the exported `main(argv)` from `@preman/cli/main.js`. Assert the bytes that reached the wire, not just the printed output. |
| Engine                  | `test/grpc.test.ts`, `test/http.test.ts`, `test/tls.test.ts`, `test/vars.test.ts`, `test/sandbox.test.ts`, `test/bodies.test.ts`, and neighbours                  | The units behind the run path.                                                                                                                                    |
| Workspace               | `test/workspace.test.ts`, `test/catalog.test.ts`, `test/groups.test.ts`, `test/select.test.ts`, `test/inherit.test.ts`                                            | Discovery, the catalog, selection and ambiguity.                                                                                                                  |
| CLI                     | `test/commands.test.ts`, `test/render.test.ts`, `test/cli-entrypoint.test.ts`, `test/reporter.test.ts`, `test/junit.test.ts`                                      | Golden output. A change to a rendered line fails here first, which is the point.                                                                                  |
| Desktop main and engine | `test/desktop.store.test.ts`, `test/desktop.hosts.test.ts`, `test/desktop.diagnostics.test.ts`, `test/desktop.protocol.test.ts`, `test/desktop.workspace.test.ts` | The processes that are not the window.                                                                                                                            |
| Renderer                | `test/renderer/*.test.ts`                                                                                                                                         | Pure modules: stores, appearance, themes, the template language, response formatting. No window, no pixels.                                                       |
| Performance             | `test/perf.test.ts`, `test/renderer/perf.app.test.ts`                                                                                                             | See below.                                                                                                                                                        |
| App                     | `test/app/smoke.test.ts`, `test/app/media/readme.media.test.ts`                                                                                                   | Gated behind `PREMAN_APP=1`; launch the built app. See below.                                                                                                     |

## Fixtures

Defined once in `test/helpers.ts`:

- `FIXTURE_WS` = `test/fixtures/ws` (`test/helpers.ts:13`) - the gRPC workspace. Five requests
  under `payment`: `Ping`, `Echo`, `Descriptor Only`, `Deep Echo` (nested), and `Legacy Http`,
  which is a websocket request and is deliberately unsupported. One environment, `LOCAL`.
- `FIXTURE_HTTP_WS` = `test/fixtures/http-ws` (`test/helpers.ts:15`) - the HTTP workspace, with no
  `.postman/` at its root on purpose.
- `SSL_DIR` = `test/fixtures/ssl` (`test/helpers.ts:21`) - committed certificates. Regenerate with
  `test/fixtures/ssl/generate.sh`, by hand, never as part of a build. The client key passphrase is
  `preman-test` and must match the script (`test/helpers.ts:23`).
- `FIXTURE_PROTO`, `FIXTURE_INCLUDE_DIR` (`test/helpers.ts:16-17`) - the proto and its include root.

`cloneFixtureWorkspace()` (`test/helpers.ts:61`) copies the fixture into a temp directory and hands
back `{ root, workspace, cleanup }`. Call it before anything that writes. A suite that mutates the
committed fixture in place corrupts every suite that runs after it.

Do not add a request file to `test/fixtures/ws`. Several suites assert the exact five-request list
and its group statuses. Add a script, a variable or an event to a request that already exists.

`test/support/big-workspace.ts` generates an N-request workspace in a temp directory for the perf
suites. It is never committed, and it reads every file back once after writing so the filesystem
cache cost is paid before measurement starts.

## The two performance gates

They are split because one needs a clock and the other needs a window.

**In the normal suite.** `test/perf.test.ts` holds the budgets that are a function call: catalog
build, workspace switch, console merge. It takes the best of three runs rather than the first, and
its three clock budgets are skipped when `PREMAN_SKIP_PERF=1` (`test/perf.test.ts:46,85,114,152`).
CI sets that (`.github/workflows/ci.yml:25`) because a shared runner cannot hold a millisecond
budget. A regression there is yours to catch locally. The `engine boot graph` block in the same
file is not a clock and is never skipped.

**Gated, needs a build.**

```sh
bun run build && PREMAN_PERF=1 bunx vitest run test/renderer/perf.app.test.ts
```

`test/renderer/perf.app.test.ts` launches a real Electron window repeatedly, which is why it is
behind `PREMAN_PERF=1` (`test/renderer/perf.app.test.ts:64-65,858`) instead of in the suite. It
fails with a clear message if `dist/main/main.js` or the Electron binary is missing
(`test/renderer/perf.app.test.ts:463-467`).

The interaction budgets in it are blocking time attributed to the interaction that caused it, and
they are asserted against the median rather than the worst. The idle app blocks its own main thread
for 7-16ms every so often, which is above the tab-switch and keystroke budgets both, so a
worst-case assertion would fail on a correct build.

`docs/performance.md` is the budget itself and what each number counts. Read the number there
rather than from a copy.

## The app suites

`test/app/` launches the built desktop app through Playwright's `_electron` and clicks through it.
Every file there is behind `PREMAN_APP=1` (`test/app/harness.ts`), so `bun run test` skips them.

```sh
bun run test:app                                   # build, then the smoke suite on this machine
bun run test:app:linux                             # the same, in a Linux box under Xvfb
bun run test:app:linux -- test/app/smoke.test.ts -t palette
```

- `harness.ts` is the only launcher: `launchApp(root)` seeds a throwaway `--user-data-dir` whose
  `state.json` reopens `root`, pins the content size to 1200x800, turns the update check off, and
  waits for a sidebar row. Always pair it with `closeApp` in `afterEach`.
- `fixtures.ts` `httpWorkspace()` copies `test/fixtures/http-ws` to `<tmp>/admin-api` and points its
  `QC` environment at an in-process server, because the app has no `--var`.
- The renderer has no `data-testid`. Select by role and label: rows are `[role="treeitem"]`, open
  tabs are `[role="tablist"][aria-label="Open requests"] [role="tab"]`, and shortcuts are
  `ControlOrMeta+…` since the renderer reads `metaKey || ctrlKey`.
- The root program has no `lib.dom`, so code that runs in the page is a string passed to `evaluate`.

**The Linux box** is `test/app/docker/`: `node:22-bookworm` with Xvfb on `:1`, openbox, ffmpeg, and a
`fonts.conf` mapping `system-ui` to Liberation Sans and `ui-monospace` to JetBrains Mono so text has
macOS metrics. `run.ts` calls `docker compose run --rm --build`; `command.ts` turns the arguments
into the `bash -c` line, and is unit tested in `test/app-box.test.ts`. The repository is bind
mounted at `/work`, with every `node_modules` in a named volume so the host's macOS binaries are
never loaded. The box runs as root, so `PREMAN_HEADLESS=1` adds `--no-sandbox`.

**README media.** `test/app/media/readme.media.test.ts` records `docs/media/<scene>.gif`, gated by
`PREMAN_README_MEDIA` as well (`1` for every scene, `send,palette` for some):

```sh
bun run readme:media                    # in the box (the default)
bun run readme:media -- --media=import  # one scene
bun run readme:media:host               # on this machine; needs ffmpeg on PATH
```

`recorder.ts` takes frames from the DevTools screencast and encodes them with ffmpeg; `timeline.ts`
turns frame timestamps into the concat list and is unit tested in `test/readme.test.ts`, which also
checks that every relative link and image in the README exists. `pace.ts` draws the pointer and the
shortcut badge, because a screencast shows neither. A failed scene leaves
`<tmpdir>/preman-readme-<scene>-failure.png`; in the box that is the container's `/tmp`, so rerun on
the host to see it.

## Matching CI

CI runs static analysis once on Linux, and the suite on both Linux and macOS, because filesystem
behaviour, port binding and certificate handling differ (`.github/workflows/ci.yml:58-81`). It sets
`PREMAN_SKIP_PERF=1` and `ELECTRON_SKIP_BINARY_DOWNLOAD=1` (`.github/workflows/ci.yml:19-25`), and
it builds before it tests. Locally, the equivalent of a green CI run is:

```sh
bun run format:check && bun run lint && bun run typecheck && bun run typecheck:core && bun run build && bun run test
```

`typecheck` and `typecheck:core` are both required: the second proves the engine compiles without
the CLI or the window in the program.

## Flakes

The sandbox suite runs scripts under a real timeout (`--timeout-script`, 5000ms by default). Under
heavy machine load those tests can time out and fail. Before treating one as a regression, run the
file alone:

```sh
bun run test -- test/sandbox.test.ts
```

If it passes alone and the full suite passes on a second run, it was load, not code.
