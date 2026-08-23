# 001: Electron, not Tauri

Status: Accepted

## Decision

The desktop app is Electron. Tauri was considered and rejected.

## Rationale

`@preman/core` is Node, and not incidentally. It runs `@grpc/grpc-js`, evaluates scripts in
`node:vm`, and exposes `chai`, `cheerio`, `crypto-js`, `xml2js`, `lodash`, `moment` and
`@faker-js/faker` to those scripts because Postman does. That set is the product, not an
implementation detail — a workspace whose `pm.test` blocks fail to run is not a Postman client.

Tauri offers two routes and both are worse:

- **Rewrite in Rust.** Reimplementing Postman's `pm.*` semantics, including the exact behaviour of
  the sandbox libraries, is a project of its own with no end state where it is provably correct.
- **Ship a Node sidecar.** Then Tauri's binary size advantage is gone, its complexity is still
  paid, and `utilityProcess` and `MessagePort` — the two things decision 002 is built on — are
  replaced with hand-rolled IPC over a pipe.

## Consequences

The Electron floor is roughly 150MB installed and ~120MB idle in private footprint. This is named
so that nobody reopens the question in six months on size grounds alone: the route below that floor
is a TUI, not Tauri.

Measured idle resident memory is higher again — see 016 — because macOS charges the shared
framework once per process.
