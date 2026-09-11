/**
 * The five seconds preman is not running, written as a shell script.
 *
 * A shell script and not Node, for one reason that admits no argument: the Node this would need is
 * inside the bundle being replaced. `Contents/Frameworks` goes away for the width of a rename, and
 * a process reading its own code out of it goes away with it. `/bin/sh` is the operating
 * system's.
 *
 * This module generates the text and nothing else — it does not spawn — so the same string a test
 * asserts on is a string a test can execute against two directories in a temporary directory. That
 * matters more here than anywhere else in the app: this is the one piece of preman that can leave a
 * user with no installed copy of it.
 *
 * The swap itself is Apple's advice from
 * [Updating Mac Software](https://developer.apple.com/documentation/security/updating-mac-software):
 * stage the new version completely, then replace, rather than modifying a bundle in place.
 */

/**
 * How long to wait for preman to exit before giving up and touching nothing.
 *
 * It never kills the old process. Thirty seconds after `app.quit()` a still-running preman means
 * something is wrong that this script cannot see, and the correct action then is to leave the
 * installed app exactly as it was.
 */
const SWAP_WAIT_SECONDS = 30;
const POLL_INTERVAL_SECONDS = 1;
/** Where the outgoing bundle sits for the two renames the rollback needs it for. */
const BACKUP_SUFFIX = ".old";
/** The executable inside the bundle, and the one thing worth testing before deleting the backup. */
const EXECUTABLE_RELATIVE_PATH = "Contents/MacOS/preman";

const SINGLE_QUOTE = /'/g;
/** Close the quoted run, emit an escaped quote, reopen. The only way `sh` takes a `'` literally. */
const ESCAPED_QUOTE = String.raw`'\''`;

export interface SwapPlan {
  /** The running preman. The script waits for this to be gone and never sends it a signal. */
  readonly pid: number;
  /** The `.app` to replace, resolved through symlinks by the caller. */
  readonly bundlePath: string;
  /** The extracted replacement, already beside {@link bundlePath} so the renames are atomic. */
  readonly stagedPath: string;
  /**
   * The directory {@link stagedPath} was extracted into, which the script removes on its way out.
   *
   * Separate from `stagedPath` because the rename takes the `.app` *out* of it and leaves the
   * directory behind — so without this an install would deposit an empty `.preman-update-<uuid>`
   * beside the app, one per update, forever. Nothing else knows to clean it up: by the time the
   * script runs, the process that created it has quit.
   */
  readonly stagingPath: string;
}

/**
 * A path as one `sh` word.
 *
 * A workspace path never reaches this script, but an app bundle can still live under a directory
 * with a space in it, and this runs unattended with nobody to read the error. Single quotes rather
 * than a backslash pass: inside them every character but `'` is literal, including `$`, backticks
 * and newlines.
 */
function quote(value: string): string {
  return `'${value.replace(SINGLE_QUOTE, ESCAPED_QUOTE)}'`;
}

/**
 * The script that replaces the bundle, and puts it back if the replacement does not run.
 *
 * The window in which nothing is installed at the target path is two renames wide, and the
 * rollback closes it: if `Contents/MacOS/preman` is not executable after the second rename, the
 * new bundle is thrown away and the old one is renamed back. That check is deliberately shallow —
 * it proves something launchable is there, not that it is correct — because anything deeper would
 * be this script deciding whether a build is good, which is not a decision `/bin/sh` should make.
 */
export function swapScript(plan: SwapPlan): string {
  const target = quote(plan.bundlePath);
  const staged = quote(plan.stagedPath);
  const backup = quote(plan.bundlePath + BACKUP_SUFFIX);
  const executable = quote(`${plan.bundlePath}/${EXECUTABLE_RELATIVE_PATH}`);
  const staging = quote(plan.stagingPath);
  const pid = String(plan.pid);
  const interval = String(POLL_INTERVAL_SECONDS);
  const limit = String(SWAP_WAIT_SECONDS);

  return `#!/bin/sh
# Written by preman to replace itself. Safe to delete: it exits without touching anything
# if preman is still running, and removes nothing it has not already put back.
set -u

waited=0
while kill -0 ${pid} 2>/dev/null; do
  if [ "$waited" -ge ${limit} ]; then
    # Still running after ${limit}s. Something is wrong that this script cannot see, so the
    # installed app is left exactly as it was.
    exit 1
  fi
  sleep ${interval}
  waited=$((waited + ${interval}))
done

# A stale backup from a run that died between the two renames below. Removing it here rather
# than leaving it is what keeps the second attempt identical to the first.
rm -rf ${backup}

mv ${target} ${backup} || exit 1
if ! mv ${staged} ${target}; then
  mv ${backup} ${target}
  rm -rf ${staging}
  exit 1
fi

# Did we just install something that runs? Shallow on purpose: proving a bundle is correct is
# not a decision /bin/sh should be making.
if [ ! -x ${executable} ]; then
  rm -rf ${target}
  mv ${backup} ${target}
  rm -rf ${staging}
  exit 1
fi

# Belt and braces. The zip arrived through Electron's network stack and was written with
# node:fs, neither of which sets the attribute LaunchServices puts on a browser download - but
# a quarantined ad-hoc-signed app reports as damaged, and this is the one line that costs
# nothing and removes the whole class.
xattr -dr com.apple.quarantine ${target} 2>/dev/null

open ${target}
rm -rf ${backup}
# The rename above took the bundle *out* of the staging directory and left it there. Nothing
# else can remove it: the process that made it has quit, and it sits beside the installed app.
rm -rf ${staging}
`;
}
