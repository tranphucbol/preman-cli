# preman - Agent Guidelines

CLI that runs requests from a Postman filesystem-format workspace (`.postman/` + `postman/`).
Unary gRPC and HTTP. See `README.md` for behaviour; this file is about how to change the code.

Three workspace packages: `@preman/core` is the engine, `preman` is the terminal in front of it,
and `@preman/desktop` is the window in front of it. Both front ends read and write the same files.

## Commands

- `bun install`
- `bun run typecheck` - `tsc --noEmit` over the whole tree, must be clean
- `bun run typecheck:core` - the engine alone; proves it compiles without the CLI
- `bun run test` - Vitest, all must pass
- `bun run test -- test/e2e.test.ts` - single file
- `bun run build` - every package; `packages/cli/dist/preman.js` is the shipped CLI artifact
- `bun run desktop` - build the Electron app and launch it
- `bun run desktop:package` - build it, then wrap it with electron-builder into `packages/desktop/release`
- `bun run lint` - ESLint, must be clean
- `bun run lint:fix` - apply ESLint fixes
- `bun run format` - apply Prettier formatting
- `bun run format:check` - verify Prettier formatting
- `bun run packages/cli/src/bin.ts <args>` - run the CLI from source

Never mark work done without clean `typecheck`, `lint`, `format:check`, and a full green `test` run.

## Layout

```
packages/core/                   @preman/core - the engine, private, bundled from source
  src/index.ts                   the declared public surface; widen it deliberately
  src/api/                       the interface-agnostic seam: what a CLI or a GUI calls
    run.ts                       runSelection: resolve, run, return outcomes and warnings
    select.ts                    SelectionPort + failOnAmbiguity, the only ambiguity escape
    inspect.ts                   describeWorkspace -> WorkspaceSnapshot
    environments.ts              read/write one environment value
    specs.ts                     declare a .proto: plan links, load-check, write resources.yaml
  src/runner.ts                  orchestration: scripts -> interpolate -> invoke -> writeback
  src/workspace/                 discovery, resources, collections/groups, environments, zod schemas
    links.ts                     the shared proto root and its symlinks; 038 says why a spec runs
                                 through one, 042 when it does not - a link naming the workspace's
                                 own checkout is read out of it - and resources.ts stops its
                                 include-dir climb at whichever root answered
  src/vars/                      scoped store, {{token}} interpolation, dynamic vars
  src/scripts/                   node:vm sandbox (pm shim), chai + gRPC assertions
  src/json/comments.ts           the comment mask every body preman parses runs through; 047 says
                                 which bodies those are and 023 why the mask preserves length
  src/grpc/                      schema resolution, target/TLS, unary invoke
  src/http/                      target/URL, bodies, cookies, redirects, auth, compression, invoke
  src/tls/certs.ts               --ssl-* layering, secure context, gRPC credentials, handshake hints
  src/report/json.ts             machine-readable reports
  src/errors.ts                  PremanError, EXIT codes
packages/cli/                    preman - the published CLI
  src/bin.ts                     shebang and process wiring; the build entry
  src/main.ts                    main(argv): arg parsing, help, exit codes
  src/prompt.ts                  the TTY SelectionPort; the only @inquirer/prompts consumer
  src/render/                    outcome, list and env painting
  src/reporters/                 reporter registry, cli/json/junit, xml
packages/desktop/                @preman/desktop - the Electron app, private, three processes
  src/main/                      lifecycle, one window, menu, dialogs; holds no workspace state
    hosts.ts                     one utilityProcess per open workspace; MessageChannelMain transfer
    store.ts                     app data: workspaces, tabs, drafts, window bounds
    diagnostics.ts               the one log file and the host output tail; 035 fences it, 036 levels it
  src/preload/                   contextBridge surface; relays the engine port into the page
  src/engine/                    the utility process: Catalog, BodyStore, watcher, proto cache
    protocol.ts                  the typed contract; the only module engine and renderer share
  src/renderer/                  the pure view: React 19, Zustand, Tailwind v4, CodeMirror 6
    app.css                      the tokens and their why; docs/design-system.md picks between them
    appearance/                  what the tokens resolve to: theme.ts, density.ts, fonts.ts,
                                 themes/ (43, all but one generated), and apply.ts - the one
                                 module allowed to touch documentElement.style
    stores/                      catalog, tabs, runs, session, appearance - one per subscription
    model/                       pure, no React: request fields, drop plans, body windows, responses
    ui/                          cn, icons, Menu, Controls, Banner, Dialog, CodeEditor, highlight,
                                 editorTheme (the editor's chrome, reaching nothing so it is
                                 testable), template (the {{token}}-aware JSON language)
    panes/                       Sidebar, TabStrip, RequestEditor, KeyValueGrid, ResponsePane,
                                 BodyViewer, ResponseFailure, ConsoleDrawer, SettingsPane, ProtosPane
  scripts/                       run by hand, never at build time
    audit.ts                     the contrast arithmetic; also asserted by test/renderer/themes
    generate-themes.ts           palettes/*.json -> src/renderer/appearance/themes/
    palettes/                    vendored upstream palettes; see NOTICE, prettier-ignored
  resources/                     the app icon; macOS masks nothing, so the rounding is in the art
    generate.swift               icon.source.png -> icon.png on Apple's grid; regenerate by hand
  electron-builder.yml           packs the built dist/ into release/; compiles nothing
.github/workflows/               ci.yml gates every push; release.yml turns a `v*` tag into an
                                 npm publish and a DMG. The tag is the only version; see ADR 030
.bun-version                     the bun the workflows install; the one place it is pinned
vitest.config.ts                 the one test project, shared by every package
packages/*/vite.*.config.ts      per-package build; the desktop has one config per process
eslint.config.js                 lint, import layering, and the two purity fences
test/fixtures/ws/                a real Postman workspace + .proto used by every suite
test/fixtures/http-ws/           the HTTP workspace; `Legacy Http` in `ws/` is a skipped websocket
test/fixtures/ssl/               committed certificates; regenerate with `generate.sh`
test/support/big-workspace.ts    generates an N-request workspace in a temp dir; never committed
test/perf.test.ts                the catalog and workspace-switch budgets; runs with the suite
test/renderer/perf.app.test.ts   the budgets that need a window; gated behind PREMAN_PERF=1
```

## Conventions

- `docs/decisions/` holds the ADRs. Read the record before changing the process model, the
  synchrony of core, how files are written, or how the perf budget is read. Make a decision of that
  weight — one with a real alternative, or one the next reader would otherwise reopen — and add the
  next-numbered file from `TEMPLATE.md`, listed in the index, stating what it cost and not only what
  was chosen. Numbers are never reused; a reversal keeps its file and changes its status.
- `docs/design-system.md` says which token to reach for. Read it before adding a control, a
  toolbar or a list row. Tokens are configurable: TypeScript owns the value and `appearance/apply.ts`
  writes it, so a height a virtualizer needs is read from `useDensityTokens()` and never hardcoded,
  and a colour is a token and never a hex. Regenerate the themes with
  `bun run packages/desktop/scripts/generate-themes.ts`; never hand-edit a generated file.
- TypeScript strict, ESM. Import with explicit `.js` specifiers; cross a directory with
  `@preman/core/…` or `@preman/cli/…` (including inside core), stay relative within one, and use
  `import type` for types.
- The engine may not know what is in front of it: nothing under `packages/core/` imports
  `picocolors`, `@inquirer/prompts` or `electron`, or touches `process` beyond `env`. Terminal and
  window concerns are arguments.
- The renderer may not reach the engine in process: nothing under
  `packages/desktop/src/renderer/` imports `@preman/core`, `node:*` or `electron`, or names
  `process`, `Buffer` or `require`. It talks over the transferred port and imports types from
  `@preman/desktop/engine/protocol.js`. That one rule is the whole architecture; if the renderer
  can `import { runRequest }`, the app becomes Postman.
- No magic literals in logic: hoist to a named module-scope `const`/`Set`/`Record`.
- Errors are `PremanError` with an `exitCode` and actionable `details[]`. Never throw a bare
  string, never swallow a cause.
- Ambiguity is an error that lists the candidates - never guess what the user meant.
- Exit codes: `0` ok, `1` usage/config, `2` transport, `3` business `return_code`, `4` failed
  `pm.test`. Collection runs report the worst outcome in that order.
- Comments explain _why_ (especially deliberate deviations from Postman), not _what_.

## Tests

- Vitest 4, names read `givenX_whenY_thenZ`.
- `test/e2e.test.ts` boots a real in-process `@grpc/grpc-js` server and calls the exported
  `main(argv)` from `@preman/cli/main.js`; assert the bytes that reached the wire, not just the
  output.
- Prefer adding scripts/vars to existing fixtures over adding request files: several suites
  assert the exact 5-request list and its group statuses.
- Use `cloneFixtureWorkspace()` before anything that writes to the workspace.
- Performance budgets live in `docs/performance.md`. `test/perf.test.ts` holds the ones that
  are a function call, and takes the best of three runs rather than the first. Its three clock
  budgets are skipped when `PREMAN_SKIP_PERF=1`, which `ci.yml` sets — CI cannot hold them, so a
  regression there is yours to catch locally (ADR 030). The ones that need a real window are
  `test/renderer/perf.app.test.ts`, gated behind `PREMAN_PERF=1` because it launches Electron
  twelve times against a built `dist/`; run it with
  `bun run build && PREMAN_PERF=1 bunx vitest run test/renderer/perf.app.test.ts`.
- The interaction budgets there are blocking time, attributed to the interaction that caused it,
  and asserted against the median rather than the worst: the idle app blocks its own main thread
  for 7-16ms every so often, which is above the tab-switch and keystroke budgets both.
