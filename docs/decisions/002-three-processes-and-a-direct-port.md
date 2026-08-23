# 002: Three processes, and a direct port between renderer and engine

Status: Accepted

## Decision

The app is three kinds of process:

- **main** owns windows, the menu, native dialogs and the updater. It holds no workspace state.
- **an engine host per open workspace** — a `utilityProcess.fork` holding `@preman/core`, the
  catalog, the body store, the file watcher and the proto cache.
- **the renderer**, a pure view, with `contextIsolation: true`, `sandbox: true` and
  `nodeIntegration: false`.

The renderer talks to its engine host **directly**, over a `MessagePortMain` transferred at open.
Main is not in the request path.

This is enforced by lint, not by convention: nothing under `packages/desktop/src/renderer/` may
import `@preman/core`, any `node:*` module or `electron`, or name `process`, `Buffer` or
`require`. It imports types from `@preman/desktop/engine/protocol.js` and talks over the port.

## Rationale

A single-process Electron app would put a synchronous engine — `node:vm`, synchronous `fs`, a
1000-file catalog walk — on the thread that also has to paint. Every budget in
`docs/performance.md` would be unmeetable by construction.

Routing messages through main instead of transferring a port would make main a broker that must
stay responsive on behalf of every workspace, and would put the process that owns the window in the
path of every keystroke's autosave.

`utilityProcess` over `child_process.fork` is Electron's own guidance for exactly this shape, and
it is what makes `MessagePortMain` transferable in the first place.

The fence rule is the whole architecture. If the renderer can `import { runRequest }`, someone
eventually will, and then the app is a Postman-shaped monolith with an Electron window on it.

## Consequences

Every capability the UI needs must be named in `packages/desktop/src/engine/protocol.ts` — twenty
request kinds today. That is friction, and it is the point: widening the surface is a visible act.

Constants that both sides need (`EXIT_CODES`, `ORDER_STEP`, `ORDER_ABSENT`,
`BODY_FORMAT_LIMIT_BYTES`, `GROUP_DEFINITION_SUFFIX`) are duplicated in `protocol.ts` rather than
imported from core, and `test/desktop.protocol.test.ts` pins each one to its original so the copies
cannot drift.

The renderer cannot be unit-tested against core. Anything that needs both is an app-level test.
