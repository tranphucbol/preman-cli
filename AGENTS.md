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
  src/runner.ts                  orchestration: scripts -> interpolate -> invoke -> writeback
  src/workspace/                 discovery, resources, collections/groups, environments, zod schemas
  src/vars/                      scoped store, {{token}} interpolation, dynamic vars
  src/scripts/                   node:vm sandbox (pm shim), chai + gRPC assertions
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
  src/preload/                   contextBridge surface; relays the engine port into the page
  src/engine/                    the utility process: Catalog, BodyStore, watcher, proto cache
    protocol.ts                  the typed contract; the only module engine and renderer share
  src/renderer/                  the pure view: React 19, Zustand, Tailwind v4, CodeMirror 6
    app.css                      the design system; every token is contrast-audited
    stores/                      catalog, tabs, runs, session - one file per subscription surface
    model/request.ts             reads and writes request fields without importing the engine
    ui/                          cn, icons, Menu, Controls, Dialog, CodeEditor
    panes/                       Sidebar, TabStrip, RequestEditor, KeyValueGrid
vitest.config.ts                 the one test project, shared by every package
packages/*/vite.*.config.ts      per-package build; the desktop has one config per process
eslint.config.js                 lint, import layering, and the two purity fences
test/fixtures/ws/                a real Postman workspace + .proto used by every suite
test/fixtures/http-ws/           the HTTP workspace; `Legacy Http` in `ws/` is a skipped websocket
test/fixtures/ssl/               committed certificates; regenerate with `generate.sh`
```

## Conventions

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
