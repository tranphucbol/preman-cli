# Contributing

Bug reports and pull requests are welcome. [AGENTS.md](AGENTS.md) is the full reference for the
layout, commands and conventions; this file is the short version.

## Setting up

Requires Bun and Node.js 20.19 or later.

```sh
bun install
bun run build
bun run desktop          # build the app and launch it
bun run packages/cli/src/bin.ts <args>   # run the CLI from source
```

## Before you open a pull request

```sh
bun run typecheck
bun run typecheck:core
bun run test
bun run lint
bun run format:check
```

All of them must be clean. `bun run test:watch`, `bun run lint:fix` and `bun run format` are the
interactive and fixing variants.

## Branches

Work on a branch cut from an up-to-date `main`; nothing is pushed to `main` directly. Name it
`<kind>/<what-it-does>`, in lower-case words joined by hyphens:

| Kind       | For                                                  | Example                                   |
| ---------- | ---------------------------------------------------- | ----------------------------------------- |
| `feature/` | new or changed behaviour                             | `feature/event-stream-and-response-timer` |
| `fix/`     | a bug in something that already shipped              | `fix/tab-activation-and-token-anchor`     |
| `chore/`   | tooling, CI, docs or dependencies, with no behaviour | `chore/readme-media`                      |

- One branch per change, merged through a pull request. Rebase on `main` before you open it and
  whenever it falls behind, and renumber a decision record whose number `main` took meanwhile.
- `pr-evidence` is the one exception: it holds the screenshots pull requests link to, under
  `evidence/`, and is never merged or deleted.

## Commits

A commit is one step a reviewer can read on its own: a change and its tests together, with the
checks still passing after it.

The subject follows [Conventional Commits](https://www.conventionalcommits.org/), without a scope:
`<type>: <summary>`, as in `feat: add pasted command import`.

| Type       | For                                                                   |
| ---------- | --------------------------------------------------------------------- |
| `feat`     | something the CLI, the engine or the app can now do                   |
| `fix`      | a behaviour that was wrong and now is right                           |
| `docs`     | the README, the guide, CONTRIBUTING, AGENTS.md, decision records      |
| `test`     | tests, fixtures and the test harness, with no change to the product   |
| `refactor` | a change to the code that keeps its behaviour                         |
| `perf`     | a change made to meet or measure a performance budget                 |
| `ci`       | `.github/workflows/` and the release scripts beside them              |
| `style`    | formatting only                                                       |
| `chore`    | anything else a user cannot see: agent skills, repo and editor config |

- The summary is imperative and lower case, with no full stop: _fix: report a response cut short
  as a failure_. Name the behaviour, not the files.
- Keep the subject within 72 characters.
- Add a body, wrapped at about 80 columns, when the why or a limit is not obvious from the subject
  and the diff: what the user sees, what it costs, which decision it follows.
- A new decision record goes in its own commit: _docs: record decision 042 for the second resolver
  root_.
- Never commit `docs/plans/` (only its template is tracked), `gdb/` drafts or any `dist/` and
  `release/` output.

## Releases

A `v*` tag on `main` is the version: [`release.yml`](.github/workflows/release.yml) publishes the
CLI to npm and attaches the macOS DMG to a GitHub release. Nothing else carries a version number;
[decision 030](docs/decisions/030-ci-asserts-everything-but-the-clock.md) says why.

## App tests

The desktop app has a small smoke suite that launches the built app and clicks through it. It is
gated, so `bun run test` skips it:

```sh
bun run test:app          # on this machine
bun run test:app:linux    # in a Linux box under Xvfb; needs Docker
```

The Linux box is `test/app/docker/`: Debian, Xvfb, openbox, and fonts with macOS metrics. The first
run builds the image and installs dependencies into Docker volumes, so it takes a few minutes; later
runs take seconds. Arguments go to Vitest, so `bun run test:app:linux -- test/app/smoke.test.ts -t
palette` runs one test.

## README media

The GIFs in [`docs/media/`](docs/media) are recorded from the built app, not by hand. Re-record them
after a change that shows in them:

```sh
bun run readme:media                     # every scene, in the Linux box
bun run readme:media -- --media=send     # one scene
bun run readme:media:host                # on this machine; needs ffmpeg
```

The scenes are in `test/app/media/readme.media.test.ts`. Each GIF must stay under 2 MiB and 25
seconds, and all of them together under 12 MiB. Commit the GIFs with the change.

## Performance budgets

The performance budgets in `test/perf.test.ts` run with the normal suite. The ones that need a real
window launch Electron several times, so they are gated and want a built app:

```sh
bun run build && PREMAN_PERF=1 bunx vitest run test/renderer/perf.app.test.ts
```

[`docs/performance.md`](docs/performance.md) is the budget itself, and what each number counts.

## Decisions

[`docs/decisions/`](docs/decisions/README.md) is why the app is shaped the way it is — three
processes, a synchronous core, an editor that never reformats your files. Read the record before
changing any of those, and add the next-numbered one when you make a decision of that weight.
