---
name: local-testing
description: Run and verify preman locally - the Electron desktop app, the CLI, and the vitest suites - including driving a built app to prove a renderer change by eye. Use when the user says "local testing" or "e2e testing", asks how to run or debug this app, asks to verify a change before opening a PR, or asks for a screenshot of the running app.
---

# Local testing

Three packages, three ways a change can be wrong. `@preman/core` is the engine, `preman` is the
CLI, `@preman/desktop` is the Electron app. A change to the engine is provable by a test; a change
to the renderer usually is not, and the last step is your eyes.

## The gate

Nothing is done until all four are clean. This is not advice, it is `AGENTS.md`.

```sh
bun run typecheck
bun run lint
bun run format:check
bun run test
```

`bun run test` is the whole suite and takes about 15 seconds. Run it, not a subset, before saying
a change works.

## Pick the path by what changed

| Changed                                       | Do this                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/`                              | The suite, plus the CLI against a fixture. See [automated-tests.md](references/automated-tests.md) and [running.md](references/running.md). |
| `packages/cli/`                               | The suite. `test/commands.test.ts` and `test/render.test.ts` assert exact output, so a rendering change fails there first.                  |
| `packages/desktop/src/main/` or `src/engine/` | The `desktop.*` suites, then launch the app and read the log. See [diagnostics.md](references/diagnostics.md).                              |
| `packages/desktop/src/renderer/`              | The renderer suites prove the logic; they do not prove the pixels. Finish with [ui-verification.md](references/ui-verification.md).         |
| Anything on a hot path                        | Both perf gates. See the perf section of [automated-tests.md](references/automated-tests.md).                                               |

## What the suite cannot tell you

The renderer suites are pure-module tests. They import from `packages/desktop/src/renderer/` and
assert on returned values. No suite asserts what a pane looks like, and none asserts the text of a
tab. A change to a label, a colour token, a truncation rule or a layout passes a green suite while
being visibly wrong, so a renderer change is verified by launching the built app and looking at it.
[ui-verification.md](references/ui-verification.md) is how, without the two traps that make it
appear impossible.

## Rules

- The desktop app's state is global, not per-checkout. `main.ts:52-56` forces the app name to
  `preman` so a source build and an installed build share one `userData` directory. Testing
  against your own state mutates your own preferences and open tabs. Pass `--user-data-dir` to
  isolate a run.
- Localhost is not a guarantee of no side effects. A request in a workspace goes wherever its
  environment points. Read the environment before running a request you did not write, and ask
  before running one that mutates anything.
- Never print or paste an environment file, a variable value, or a raw request or response. The
  engine resolves `{{token}}` before it sends, so anything captured after that point can hold a
  credential.
- `preman.log` names files inside the workspace, which puts your home directory in it. Read it
  before attaching it to anything.
- Do not run `bun run desktop:package` to verify a change. It builds a DMG and proves nothing a
  `bun run build` does not.
- Do not add a request file to `test/fixtures/ws` to test something. Several suites assert the
  exact five-request list. Add a script or a variable to an existing request instead.
- Screenshots, logs and scratch workspaces go in a temp directory, never in the repo.

## References

- [running.md](references/running.md) - build outputs, launching the app and the CLI, where app
  data lives, isolating and resetting it
- [automated-tests.md](references/automated-tests.md) - the vitest layout, running one file, the
  fixtures, and the two performance gates
- [ui-verification.md](references/ui-verification.md) - driving a built Electron app over CDP to
  see and screenshot a renderer change
- [diagnostics.md](references/diagnostics.md) - `preman.log`, the engine host output tail,
  `PREMAN_INSPECT`, and what a crash leaves behind
