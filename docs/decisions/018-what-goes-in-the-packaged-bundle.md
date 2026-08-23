# 018: What goes in the packaged bundle

Status: Accepted

## Decision

electron-builder packs `packages/desktop/dist` — the four Vite outputs — and writes its own
artifacts to `packages/desktop/release`, which is gitignored.

The desktop manifest's `dependencies` are exactly the engine's runtime externals: `@grpc/grpc-js`,
`@grpc/proto-loader`, `yaml`, `@faker-js/faker`, and the twelve sandbox packages. Everything the
renderer bundle absorbs — React, CodeMirror, Radix, Tailwind, dnd-kit, TanStack, Zustand — is a
`devDependency`.

`npmRebuild: false`. macOS `dmg` only, signed ad hoc (`identity: null`).

## Rationale

`dist/` is the packer's _input_, so it cannot also be its output; the plan's "the artifact is
`packages/desktop/dist`" would have had electron-builder writing a 300MB app bundle into the
directory it was reading from.

The dependency split is what makes default pruning correct. electron-builder ships `dependencies`
and drops `devDependencies`, and the engine host is the only thing that resolves packages at run
time — everything else was already inlined by Vite. Getting this wrong in the safe direction costs
tens of megabytes of React that nothing requires; getting it wrong in the other direction produces
an app that throws on the first script that calls `cheerio`.

`npmRebuild: false` because nothing here is a native addon, so there is no ABI to match and the
rebuild is pure latency.

Ad-hoc signing because a real Developer ID belongs to whoever ships this, not to the repository.

## Consequences

`bun run desktop:package` produces `release/preman-<version>-arm64.dmg` (~128MB) and
`release/mac-arm64/preman.app` (~317MB).

**Playwright will not attach to the packaged binary** — `_electron.launch` hangs with no output,
while the same call against `dist/main/main.js` under the Electron binary works. So the gated perf
suite drives `dist/`, which is the same bytes electron-builder copies, and the packaged artifact is
smoke-tested by hand.

Linux and Windows targets are absent rather than broken. Adding them is a `target` entry plus a
runner that can produce them; nothing in the config assumes macOS beyond the `mac` block.

The manifest carries no `author`, which electron-builder warns about. Left alone rather than
inventing identity metadata for someone else's release.
