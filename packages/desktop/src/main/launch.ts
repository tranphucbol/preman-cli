/**
 * The folder a launch was asked to open, read off the command line.
 *
 * Pure, so it is testable without a window: `main.ts` hands it `process.argv` and owns what
 * happens next. macOS mostly delivers a folder as an `open-file` event instead, which needs no
 * parsing; this is the path for `open -a preman --args <dir>`, a direct exec of the binary, and
 * every platform that has no such event.
 */
import { resolve } from "node:path";

/**
 * Every switch is skipped, whatever it is: Chromium's, Electron's, Playwright's, and the
 * `-psn_0_…` process serial number an older macOS passed to anything Finder launched. None of
 * them is a folder, and preman defines no switch of its own that takes a value.
 */
const SWITCH_PREFIX = "-";
/** `argv[0]` is the executable. */
const EXECUTABLE_ARGS = 1;
/** Unpackaged, `electron <entry>` puts the entry script where a packaged build has nothing. */
const ENTRY_ARGS = 1;

/**
 * The last positional argument, resolved against `cwd`, or `null` when there is none.
 *
 * The last rather than the first, because a launcher that prepends its own arguments is more
 * common than one that appends them. Whether the result is a workspace is not decided here: the
 * caller refuses it in the same place it refuses one picked in a dialog.
 */
export function workspaceArgument(argv: readonly string[], cwd: string, defaultApp: boolean): string | null {
  const positional = argv.slice(EXECUTABLE_ARGS).filter((arg) => !arg.startsWith(SWITCH_PREFIX));
  const operands = defaultApp ? positional.slice(ENTRY_ARGS) : positional;
  const last = operands.at(-1);
  return last === undefined ? null : resolve(cwd, last);
}
