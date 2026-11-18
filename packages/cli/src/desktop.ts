import { spawnSync } from "node:child_process";
import { requireWorkspace } from "@preman/core/workspace/discover.js";
import { PremanError } from "@preman/core/errors.js";

/**
 * Handing a workspace to the desktop app.
 *
 * By bundle identifier through LaunchServices, never by spawning the app's binary: `open -b`
 * starts preman.app when it is not running and delivers the folder to the running one when it is,
 * as an `open-file` event, so there is never a second instance to reconcile. The identifier rather
 * than a path, because the app may live anywhere and translocation moves it. See
 * `docs/decisions/060`.
 */

const MACOS = "darwin";
const OPEN_COMMAND = "open";
const BUNDLE_FLAG = "-b";
/** `appId` in `packages/desktop/electron-builder.yml`; the two must agree. */
export const APP_BUNDLE_ID = "dev.preman.desktop";
const RELEASES_URL = "https://github.com/tranphucbol/preman-cli/releases/latest";
const LAUNCHED = 0;

/** What `open` said, reduced to what this module reads. */
export interface Launch {
  /** `null` when the process never ran or was killed by a signal. */
  status: number | null;
  stderr: string;
  /** Set when the process could not be started at all. */
  error?: Error;
}

export type Launcher = (command: string, args: readonly string[]) => Launch;

export interface OpenInAppOptions {
  platform?: NodeJS.Platform;
  /** Replaced in tests, which must never start the real app. */
  launch?: Launcher;
}

const spawnLauncher: Launcher = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status,
    stderr: result.stderr,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
};

/**
 * Open the workspace containing `dir` in preman.app and return its root.
 *
 * Walks up from `dir` the way every other command does, so `preman open` from anywhere inside a
 * checkout opens the checkout. The app checks the folder again on arrival, because a folder can
 * reach it from Finder without passing through here.
 */
export function openInApp(dir: string, options: OpenInAppOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== MACOS) {
    throw new PremanError("preman open needs the desktop app, which is only packaged for macOS", {
      details: [`this is ${platform}; every other command works here without it`],
    });
  }

  const { root } = requireWorkspace(dir);
  const launch = options.launch ?? spawnLauncher;
  const result = launch(OPEN_COMMAND, [BUNDLE_FLAG, APP_BUNDLE_ID, root]);
  if (result.error === undefined && result.status === LAUNCHED) return root;

  const said = result.error?.message ?? result.stderr.trim();
  throw new PremanError(`could not open ${root} in the preman app`, {
    details: [...(said === "" ? [] : [said]), `is preman.app installed? The DMG is on ${RELEASES_URL}`],
  });
}
