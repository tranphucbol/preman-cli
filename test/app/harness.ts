/**
 * Launching the built desktop app, for every suite that needs a real window.
 *
 * It drives `packages/desktop/dist` under the Electron binary rather than a packaged app: the
 * bundle is the same bytes electron-builder copies, and packaging inside a test would spend
 * minutes producing a DMG in order to launch it once.
 *
 * This file is in the root program, which has no `lib.dom` on purpose. Nothing here runs in the
 * page; a suite that has to is handed a string to `evaluate`, the trade `media/pace.ts` makes too.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ElectronApplication, Page } from "playwright-core";
import { DEFAULT_PREFERENCES, type Preferences } from "@preman/desktop/preload/bridge.js";
import type { AppState } from "@preman/desktop/main/store.js";

/** `bun run test` skips every app suite: they need a built `dist/` and a display. */
export const APP_TESTS_ENABLED = process.env["PREMAN_APP"] === "1";
/** Set by the Linux box, which runs as root under Xvfb. */
export const HEADLESS = process.env["PREMAN_HEADLESS"] === "1";

export const DESKTOP_ROOT = resolve(import.meta.dirname, "../../packages/desktop");
export const MAIN_ENTRY = join(DESKTOP_ROOT, "dist/main/main.js");
const ELECTRON_DIST = join(DESKTOP_ROOT, "node_modules/electron/dist");
/** Where Electron's postinstall unpacks itself, per platform. */
const ELECTRON_EXECUTABLES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "Electron.app/Contents/MacOS/Electron",
  linux: "electron",
  win32: "electron.exe",
};

/** Fixed so a screenshot or a GIF is the same size on every machine. Content size, not outer. */
export const WINDOW = { width: 1200, height: 800 } as const;
/** A cold Electron in a fresh Docker volume reads its framework off disk; that is the slow case. */
export const LAUNCH_TIMEOUT_MS = 60_000;
/** How long `close` may take before the process is killed instead. */
const CLOSE_DEADLINE_MS = 10_000;

const STATE_FILE = "state.json";
const STATE_VERSION = 1;
const ENCODING = "utf8";
const JSON_INDENT = 2;
const PROFILE_PREFIX = "preman-app-";
/** A sidebar row: the window has reopened the workspace and drawn it. */
export const ROW_SELECTOR = '[role="treeitem"]';
/**
 * Chromium's sandbox refuses to start as root, and the box runs as root. The box is the sandbox;
 * nothing it loads is untrusted.
 */
const HEADLESS_ARGS = ["--no-sandbox"];

/**
 * Off by default for every app suite: the check is a request to GitHub nobody asked for, and its
 * banner would land in a screenshot whenever a release happened to be newer than the checkout.
 */
const APP_PREFERENCES: Partial<Preferences> = { autoCheckUpdates: false };

export interface LaunchOptions {
  preferences?: Partial<Preferences>;
}

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  /** The throwaway `--user-data-dir`; removed by {@link closeApp}. */
  profile: string;
}

export function electronBinary(platform: NodeJS.Platform = process.platform): string {
  const executable = ELECTRON_EXECUTABLES[platform];
  if (executable === undefined) throw new Error(`Electron has no binary for ${platform}.`);
  return join(ELECTRON_DIST, executable);
}

export function requireBuild(): void {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`${MAIN_ENTRY} is missing. Run \`bun run --filter '@preman/desktop' build\` first.`);
  }
  if (!existsSync(electronBinary())) {
    throw new Error(`${electronBinary()} is missing. Run \`bun install\`.`);
  }
}

/**
 * A fresh `userData` directory naming `root` as the workspace to reopen.
 *
 * `--user-data-dir` keeps the run out of the developer's real app data, and seeding `activeRoot`
 * is what skips the open-workspace dialog: `main.ts` reopens the last workspace at launch.
 */
export function seedProfile(root: string, preferences: Partial<Preferences> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
  const state: AppState = {
    version: STATE_VERSION,
    window: { x: 0, y: 0, width: WINDOW.width, height: WINDOW.height },
    preferences: { ...DEFAULT_PREFERENCES, ...APP_PREFERENCES, ...preferences },
    activeRoot: root,
    workspaces: [],
  };
  writeFileSync(join(dir, STATE_FILE), JSON.stringify(state, null, JSON_INDENT), ENCODING);
  return dir;
}

export async function launchApp(root: string, options: LaunchOptions = {}): Promise<LaunchedApp> {
  requireBuild();
  const profile = seedProfile(root, options.preferences);
  // Imported here, not at the top: `bun run test` loads every gated suite only to skip it, and
  // Playwright's bundle parsing in several workers at once was enough to push `test/perf.test.ts`
  // over its catalog budget.
  const { _electron } = await import("playwright-core");
  const app = await _electron.launch({
    executablePath: electronBinary(),
    args: [...(HEADLESS ? HEADLESS_ARGS : []), MAIN_ENTRY, `--user-data-dir=${profile}`],
    timeout: LAUNCH_TIMEOUT_MS,
  });
  try {
    const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
    // The state file sizes the outer window, which on Linux includes a native frame and on macOS
    // does not. The content is what a screenshot shows, so that is what is pinned.
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
    }, WINDOW);
    await page.waitForSelector(ROW_SELECTOR, { timeout: LAUNCH_TIMEOUT_MS });
    return { app, page, profile };
  } catch (error) {
    await closeElectron(app);
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}

export async function closeApp(launched: LaunchedApp | undefined): Promise<void> {
  if (launched === undefined) return;
  await closeElectron(launched.app);
  rmSync(launched.profile, { recursive: true, force: true });
}

/** `close()` waits for the app to agree; a wedged main process is killed rather than waited on. */
async function closeElectron(app: ElectronApplication): Promise<void> {
  const deadline = new Promise<"late">((done) => setTimeout(() => done("late"), CLOSE_DEADLINE_MS).unref());
  const outcome = await Promise.race([app.close().then(() => "closed" as const), deadline]);
  if (outcome === "late") app.process().kill("SIGKILL");
}
