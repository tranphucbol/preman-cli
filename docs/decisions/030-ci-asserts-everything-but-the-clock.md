# 030: CI asserts everything but the clock, and the tag is the version

Status: Accepted

## Decision

Two workflows, and nothing else.

`ci.yml` runs on pushes to `main` and on every pull request. Prettier, ESLint and the four tsc
programs run once on `ubuntu-latest`, because they read the same bytes everywhere. `bun run build`
and `bun run test` run on `ubuntu-latest` and `macos-latest` both, because the suite touches the
filesystem, binds local ports and reads certificates.

`release.yml` runs on a `v*` tag. It revalidates, builds the arm64 DMG on macOS, creates the GitHub
Release with the DMG attached, and then publishes `preman` to npm with provenance — in that order.

**The clock budgets do not run in CI.** `PREMAN_SKIP_PERF=1` skips the three timing `describe`s in
`test/perf.test.ts`. `engine boot graph` is not skipped.

**The tag is the version.** No manifest carries it between releases. Each job writes
`${tag#v}` into the one manifest it needs — `packages/desktop/package.json` for the DMG's filename,
`packages/cli/package.json` for what npm uploads — immediately before it builds.

## Rationale

016 said every budget row is a test that fails. The three clock rows still are, on a machine that
can hold them; they are simply not asserted by the runner. 016's own record is the argument: the
thinnest row is `buildCatalog` over 1000 requests at 294ms against a 400ms gate, and the tightest is
43 requests against 50ms. A two-core shared virtualised runner does not have 26% of headroom to
spare. Best-of-three, which `test/perf.test.ts` already does and already explains as a defence
against measuring the other tenants, narrows that noise rather than removing it — the minimum of
three slow runs is still slow. A gate that fails for the machine it landed on gets re-run until it
passes and then stops being read, which is worse than one that is honestly absent.

`engine boot graph` stays because it is not a clock. 029 made it a source-graph assertion precisely
so it would be machine-independent, and reading an import graph off disk gives the same answer on
every runner. It is the one perf row CI can actually hold, so it holds it.

The version comes from the tag rather than from a committed bump because there are three manifests
and the value has to reach four consumers: `npm publish`, `preman --version`, the DMG filename and
the packaged app's `Info.plist`. A committed bump means a release can be tagged at a commit whose
manifests say something else, and the first symptom is a published package whose `--version` lies.
Deriving from the tag makes that disagreement unrepresentable. `PREMAN_VERSION`, which
`packages/cli/vite.config.ts` already honoured, is not used: the manifest is written first and the
build's fallback reads it, so there is one value in one place rather than two that can drift.

npm publishes last because it is the only irreversible step. A DMG that fails to pack after the
package is public cannot be undone; a GitHub Release created before a publish that fails is deleted
in one click. The cost is that the pipeline is serial and a release takes minutes rather than
running four jobs at once, which is a price paid a handful of times a year.

## Consequences

A perf regression now lands on `main` without CI noticing. The enforcement point is the developer's
machine and a deliberate local run, which is a real weakening of 016 and is recorded here as one
rather than described as a tuning change. The reversal, if the budgets are wanted back, is a
dedicated non-blocking job and renumbered budgets calibrated against a runner — not deleting
`PREMAN_SKIP_PERF`, because the numbers in `docs/performance.md` are measured on hardware that CI
does not have.

`test/renderer/perf.app.test.ts` is not wired to a workflow, despite its own header saying it is
"run in CI only". A cold-start gate of 550ms cannot pass on a virtualised macOS runner, and adding
a job that is always red is worse than the gap. That header is now wrong and the file is
manually-run; correcting it is follow-up work.

The DMG is arm64 and ad-hoc signed, so a downloader gets Gatekeeper's "damaged and can't be opened"
until it is de-quarantined. 018 already chose ad-hoc signing and named Linux and Windows as absent
rather than broken; this record adds that Intel Macs are in the same category — a `--x64` or
`--universal` flag and a second artifact, not a redesign.

`ELECTRON_SKIP_BINARY_DOWNLOAD=1` is set everywhere except the packing job. Every desktop Vite
config externalises `electron`, and the typings ship with the package rather than the binary, so
100MB is saved on every CI run. If a test ever launches a window, that variable is why it cannot.

One thing must exist outside the repository before `release.yml` works end to end: an `NPM_TOKEN`
secret with publish rights to `preman`. It is set.

The licence is MIT, declared in all four manifests and in a root `LICENSE`. Both the `LICENSE` and
the `README.md` are copied next to `packages/cli/package.json` during the publish job rather than
committed there, because npm looks for them beside the manifest it is publishing and never a
directory up — and a second copy in the tree is a second copy to forget to update. They are
gitignored so that a local `cp` cannot be committed by accident.
