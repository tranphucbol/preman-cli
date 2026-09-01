# Running preman locally

## Install

```sh
bun install
```

The bun version is pinned in `.bun-version` and that is the one CI installs
(`.github/workflows/ci.yml:37`). A fresh git worktree of this repo needs its own `bun install`
before anything typechecks; the worktree does not share `node_modules` with the main checkout.

## Build

```sh
bun run build
```

`build` fans out to every package (`package.json:14`). What it produces:

| Path                                        | What it is                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/core/dist/core.js`                | the engine, bundled from source                                                       |
| `packages/cli/dist/preman.js`               | the shipped CLI, made executable by the build script (`packages/cli/package.json:22`) |
| `packages/desktop/dist/main/main.js`        | the Electron main process, and the entry the binary is given                          |
| `packages/desktop/dist/engine/entry.js`     | the utility process, one per open workspace                                           |
| `packages/desktop/dist/preload/preload.cjs` | the contextBridge surface                                                             |
| `packages/desktop/dist/renderer/index.html` | the window                                                                            |

The desktop build is four separate vite runs, one per process
(`packages/desktop/package.json:13`). A renderer-only change still needs the whole `build`; there
is no watch mode wired up for the packaged shape.

## Launch the desktop app

```sh
bun run desktop          # build, then electron dist/main/main.js
bun run desktop:inspect  # the same, with a Node debugger on the main process
```

Both build first (`package.json:23-24`), so neither is a fast loop. For repeated launches against
an unchanged build, run the binary directly - see [ui-verification.md](ui-verification.md).

### If the Electron binary is missing

CI sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1` (`.github/workflows/ci.yml:23`) because the download is
about 100MB and CI never opens a window. A local install that inherited that variable, or a fresh
worktree, can end up with `packages/desktop/node_modules/electron` present but empty: no `dist/`,
and an empty `path.txt`. The symptom is `bun run desktop` failing to find the binary at all.

```sh
cd packages/desktop/node_modules/electron && node install.js
```

That fetches the binary the package expects, without touching the lockfile.

## Run the CLI from source

```sh
bun run packages/cli/src/bin.ts --help
bun run packages/cli/src/bin.ts list -d test/fixtures/ws
bun run packages/cli/src/bin.ts run payment/Ping -d test/fixtures/ws --url localhost:50051
```

`-d` points at a workspace; without it the CLI searches upward from the cwd, which inside this repo
finds nothing useful. The full option list is the `HELP` string in `packages/cli/src/main.ts:28`;
read it there rather than trusting a copy.

The flags that matter when poking at a workspace you do not own:

- `--var k=v` overrides one variable for the run, repeatable
- `--no-save` stops the run writing modified variables back to the environment file
- `--url <target>` retargets without editing the request
- `--bail` stops a collection run at the first failure
- `-v` shows body, headers, metadata and trailers

Prefer an exact selector (`payment/Ping`) over a partial one. Ambiguity is an error that lists the
candidates rather than a guess, so a vague selector costs a round trip.

Exit codes are defined once, in `packages/core/src/errors.ts:1-14`: `0` ok, `1` usage or config,
`2` transport, `3` business `return_code`, `4` a failed `pm.test`. A collection run reports the
worst outcome in that order. Exit `0` is the only one that means the call did what the request
intended - a `2` with a printed response is still a failure.

## Where the app keeps its data

`main.ts:52-56` sets the app name to `preman` before anything reads a path, deliberately, so that
`bun run desktop` and an installed build agree about which workspaces exist. The consequence for
testing is that they also share preferences, window bounds, open tabs and unsaved drafts.

On macOS:

| What      | Path                                              |
| --------- | ------------------------------------------------- |
| app state | `~/Library/Application Support/preman/state.json` |
| log       | `~/Library/Logs/preman/preman.log`                |

`state.json` is written atomically (`packages/desktop/src/main/store.ts:121`) and its top-level
keys are `version`, `window`, `preferences`, `activeRoot`, `workspaces`
(`packages/desktop/src/main/store.ts:74-82`). `version` is `1`; a file whose version does not match
is discarded wholesale and replaced with defaults rather than migrated
(`packages/desktop/src/main/store.ts:92`). A corrupt file costs the layout, never the ability to
start.

`preferences` defaults are in `packages/desktop/src/preload/bridge.ts:129-137`: `themeId`,
`density`, `editorFontSize`, `fontMono`, `fontSans`, `canvas`, `barHeightPx`.

Nothing above lives in the workspace, so `git status` in a workspace stays clean while the app is
open.

## Isolate a run

Pass a throwaway `userData` directory rather than testing against your own state:

```sh
T=$(mktemp -d) && mkdir -p "$T/ud"
cat > "$T/ud/state.json" <<JSON
{
  "version": 1,
  "window": { "x": 0, "y": 0, "width": 1440, "height": 900 },
  "preferences": {
    "themeId": "preman-dark",
    "density": "default",
    "editorFontSize": 13,
    "fontMono": null,
    "fontSans": null,
    "canvas": "#16181d",
    "barHeightPx": 38
  },
  "activeRoot": "$PWD/test/fixtures/ws",
  "workspaces": []
}
JSON
packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  packages/desktop/dist/main/main.js --user-data-dir="$T/ud"
```

Seeding `activeRoot` skips the open-workspace dialog, which is the difference between a scriptable
launch and a manual one. This is the same shape the perf suite uses
(`test/renderer/perf.app.test.ts:345-356`).

## Reset

Quitting the app writes state, so delete while it is not running:

```sh
rm -f ~/Library/Application\ Support/preman/state.json
```

That returns the app to the first-run state without touching any workspace on disk.
