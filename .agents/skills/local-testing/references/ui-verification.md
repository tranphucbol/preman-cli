# Verifying the window by eye

No suite asserts what a pane looks like. A change to a label, a token, a truncation rule or a
layout ships green. This is how to drive the built app and see it, and how to capture the before
and after when a reviewer needs evidence.

Everything here assumes macOS, because the Electron binary path is a `.app` bundle. The shape holds
elsewhere; the path does not.

## Two traps, first

**Do not launch Electron in the foreground from an agent shell.** The child holds the shell's
stdout open, so the command never returns and the tool call hangs until it is killed. Launch it
detached with output redirected, then talk to it over a debugging port.

**Do not use `playwright-cli screenshot <element>` on a moving pane.** Playwright waits for the
element to be stable before it shoots. The app animates its panes, and on a region that is still
settling the wait never completes. Take the screenshot through `run-code` with an explicit clip
instead.

## Launch

```sh
bun run build

T=$(mktemp -d) && mkdir -p "$T/ud"
cat > "$T/ud/state.json" <<JSON
{
  "version": 1,
  "window": { "x": 0, "y": 0, "width": 1100, "height": 760 },
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

nohup packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  packages/desktop/dist/main/main.js \
  --user-data-dir="$T/ud" \
  --remote-debugging-port=9222 \
  > "$T/electron.log" 2>&1 &
```

`--user-data-dir` keeps the run away from your own preferences and open tabs. Seeding `activeRoot`
skips the open-workspace dialog. `--remote-debugging-port` is what makes the window reachable.

Then attach:

```sh
playwright-cli -s=preman attach --cdp=http://localhost:9222
```

Attaching leaves the app running and under your control; it does not launch anything.

## Look

```sh
playwright-cli -s=preman --raw snapshot
```

The accessibility tree is usually the whole answer. If the question is "does the tab strip say
`gRPC`", the snapshot says so in text, costs nothing, and is not a picture someone has to squint
at. Reach for a screenshot only when the evidence has to be visual - a colour, a spacing, a
truncation, or a PR description.

Selectors worth knowing, taken from the perf suite so they stay true
(`test/renderer/perf.app.test.ts:73,82,84,86`):

| Selector                                                    | What                              |
| ----------------------------------------------------------- | --------------------------------- |
| `[role="treeitem"]`                                         | any sidebar row, including groups |
| `[role="treeitem"]:not([aria-expanded])`                    | a request row, excluding groups   |
| `[role="tablist"][aria-label="Open requests"]`              | the tab strip                     |
| `[role="tablist"][aria-label="Open requests"] [role="tab"]` | one open tab                      |
| `button[aria-label="Hide the sidebar (Cmd+B)"]`             | the sidebar is open and painted   |

A sidebar row opens a tab on a **single** click. `dblclick` opens and then closes it, which looks
like nothing happened.

```sh
playwright-cli -s=preman click "getByRole('treeitem', { name: 'gRPC Ping' })"
```

## Screenshot

Write the shot as a file and run it. The file must contain **only a bare arrow-function
expression**: no trailing semicolon, no statements around it, and no reference to `process`. The
CLI wraps the file as an expression and evaluates it without a Node global, so any of those three
turns into a parse or reference error.

```js
// /tmp/shot.js
async (page) => {
  const strip = page.locator('[role="tablist"][aria-label="Open requests"]');
  const box = await strip.boundingBox();
  if (box === null) throw new Error("the tab strip is not on screen");
  await page.screenshot({
    path: "/tmp/tabstrip.png",
    clip: { x: box.x - 8, y: box.y - 6, width: box.width + 16, height: box.height + 12 },
  });
};
```

```sh
playwright-cli -s=preman --raw run-code --filename=/tmp/shot.js
```

`page.screenshot` with an explicit `clip` does not wait for actionability, which is exactly why it
works where the element screenshot does not. The padding keeps a border or a focus ring from being
cut off at the edge of the crop.

For the whole window, drop the `clip` and keep the `path`.

## Before and after

A reviewer wants two pictures of the same thing. Take the after first, from the current build, then
step the changed files back one commit, rebuild, and take the before with the app in the same state.

```sh
git checkout HEAD~1 -- packages/desktop/src/renderer/panes/TabStrip.tsx
bun run build
# relaunch, reopen the same tabs, shoot again
git checkout HEAD -- packages/desktop/src/renderer/panes/TabStrip.tsx
bun run build
```

Restore the files and confirm `git status --short` is empty before doing anything else. A
half-reverted worktree that then gets committed is a worse outcome than no screenshot.

Open the same tabs in the same order for both shots. Two pictures that differ in more than the
change are not evidence of the change.

## Tear down

```sh
playwright-cli -s=preman detach
pkill -f "dist/main/main.js"
rm -rf .playwright-cli
```

`detach` leaves the app running, so kill it separately. `playwright-cli` writes snapshots into a
`.playwright-cli/` directory under the cwd; remove it, it does not belong in the repo.

## Where the pictures go

A temp directory, never the repo. If they are going on a pull request, the `github-pr` skill uploads
them to a branch and gives back an embeddable URL.
