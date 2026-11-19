# 060: The CLI hands the app a folder

Status: Accepted

## Decision

`preman open [<dir>]` finds the workspace the way every other command does — upwards from `<dir>`,
`--dir` or the current directory — and runs `open -b dev.preman.desktop <root>`. LaunchServices
starts preman.app if it is not running and delivers the folder to the running one if it is, as an
`open-file` event. The CLI never spawns the app's binary and never learns where it is installed.

The app listens for `open-file` at module scope, because for the folder that launched it the event
arrives before `whenReady`; a folder that arrives that early is held and wins over the workspace the
last session left open. A folder on the command line (`open -a preman --args <dir>`, or the binary
run directly) is read the same way through `main/launch.ts`, which skips every switch and, when
unpackaged, the entry script. Either way the folder is checked against the same markers the Open
dialog checks, and a folder that is not a workspace gets the same refusal.

Once running, a folder naming the workspace already attached only brings the window forward. A new
port empties every store the renderer has, so re-attaching the same workspace would drop runs in
flight for no gain. Any other folder switches the window to it, and the renderer now refreshes
Recents on every port rather than only after the opens it asked for itself.

The packaged app declares `public.folder` as a document type with `LSHandlerRank: Alternate`, so
Finder's Open With and a drop on the dock icon take the same path.

## Rationale

Two alternatives were weighed.

**A single-instance lock** (`requestSingleInstanceLock` and `second-instance`) is how Electron
apps on Windows and Linux forward a second launch's argv. On macOS LaunchServices already keeps one
instance per bundle, so the lock would add nothing there — and it would cost something: the lock is
keyed on the app name, which `bun run desktop` shares with the installed build through `setName`,
so a development launch would hand its folder to the installed app and exit.

**A URL scheme** (`preman://open?dir=…`) needs a registered protocol, path encoding and a second
parser for a value that is only ever a path. `open-file` is the operating system's own message for
"open this folder", and it is what Finder and the dock send anyway.

## Consequences

`preman open` works on macOS only, and says so elsewhere instead of guessing at a binary. A Windows
or Linux build would need the lock this record declines, and `launch.ts` is the half of it that
already exists.

The bundle identifier is spelled twice, in `electron-builder.yml` and `packages/cli/src/desktop.ts`;
changing one without the other breaks `preman open` with LaunchServices' own "unable to find
application" message, which the CLI passes through.

Without a single-instance lock, launching the binary directly while the app runs still starts a
second instance with its own window. `open` and Finder never do that, so the gap is only reachable
on purpose.

`open-file` and the document type can only be exercised by a packaged build launched through
LaunchServices; the Playwright harness runs the binary and cannot reach them. The argv parsing and
the CLI side are unit tested with a fake launcher.
