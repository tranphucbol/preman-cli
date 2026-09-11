/**
 * App data: which workspaces are registered, what was open in each, and where the
 * window was. None of this is ever written into a workspace — that is the whole point
 * of the file living in `userData`. `git status` stays clean while the app is open.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { writeFileAtomic } from "@preman/core/workspace/atomic.js";
import {
  DEFAULT_PREFERENCES,
  type Preferences,
  type SessionSnapshot,
  type WorkspaceHandle,
} from "@preman/desktop/preload/bridge.js";

const STATE_FILE = "state.json";
const STATE_VERSION = 1;
const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;
const ENCODING = "utf8";
const JSON_INDENT = 2;
const NEWEST_FIRST = -1;
const OLDEST_FIRST = 1;

/**
 * The two errno values that mean "this file exists and is not yours to read", as opposed to the
 * ones that mean "there is nothing here" or "what is here is not JSON".
 *
 * The distinction is the whole of phase 0 of `docs/plans/031`. Under macOS 26's app-bound data
 * protection an access is keyed to the running code's cdhash, and a build that replaced itself
 * carries a new one — so `EACCES` on `state.json` is a plausible outcome of the app updating
 * itself, and it looks from the inside exactly like a fresh install. Sparkle#2880 reports the same
 * class of failure under `~/Library/Caches`. Defaults are the right recovery either way; being
 * silent about it is not.
 */
const UNREADABLE_CODES = new Set(["EACCES", "EPERM"]);
/** Node puts the errno on `code`. Anything without one is not a file system refusal. */
const NO_CODE = null;

/**
 * A registered workspace: the session the renderer restores, plus the two fields only this
 * process has an opinion about. `SessionSnapshot` is shared with the bridge so the shape that
 * crosses IPC and the shape on disk cannot drift.
 */
export interface WorkspaceState extends SessionSnapshot {
  root: string;
  lastOpenedAt: number;
}

export interface WindowBounds {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
}

export interface AppState {
  version: number;
  window: WindowBounds;
  /**
   * Global, and beside `window` rather than inside a workspace for the same reason the window's
   * size is: it is a property of how this person uses the app, not of what they are looking at.
   */
  preferences: Preferences;
  activeRoot: string | null;
  workspaces: WorkspaceState[];
  /**
   * When the updater last completed a check, and which version the user asked not to be offered
   * again.
   *
   * Both optional and both additive, so `STATE_VERSION` stays 1 — the same reasoning `preferences`
   * gets above. Bumping the number to record a timestamp would trade every registered workspace
   * for a clock.
   */
  lastUpdateCheckAt?: number;
  skippedUpdateVersion?: string | null;
}

export interface AppStore {
  read(): AppState;
  /** Mutate in place; the result is written atomically before this returns. */
  update(mutate: (state: AppState) => void): AppState;
  workspaceFor(root: string): WorkspaceState;
  /** What the renderer should restore for `root`. Registers the workspace if it is new. */
  sessionFor(root: string): SessionSnapshot;
  saveSession(root: string, snapshot: SessionSnapshot): void;
  handles(): WorkspaceHandle[];
}

// `activeEnvironment` is absent rather than null: a workspace nobody has opened has not chosen
// "no environment", it has not chosen at all, and null would stop the sole one being adopted.
const EMPTY_SESSION = {
  activeNodeId: null,
  collapsedIds: [],
  tabs: [],
  drafts: [],
} satisfies SessionSnapshot;

function emptyState(): AppState {
  return {
    version: STATE_VERSION,
    window: { x: null, y: null, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
    preferences: { ...DEFAULT_PREFERENCES },
    activeRoot: null,
    workspaces: [],
  };
}

/**
 * Read what is there and fill in the rest. A hand-edited or half-written state file
 * must cost the user their layout, never their ability to start the app.
 */
function reconcile(raw: unknown): AppState {
  const base = emptyState();
  if (typeof raw !== "object" || raw === null) return base;
  const candidate = raw as Partial<AppState>;
  if (candidate.version !== STATE_VERSION) return base;

  return {
    version: STATE_VERSION,
    window: { ...base.window, ...(candidate.window ?? {}) },
    // Filled in rather than versioned. Adding a field with a default is not a breaking change to
    // the file, and bumping `STATE_VERSION` would trade every registered workspace for a colour.
    // An unknown `themeId` or `density` survives to the renderer, which falls back to the default
    // rather than trusting a hand-edited file to name something that exists.
    preferences: { ...base.preferences, ...(candidate.preferences ?? {}) },
    activeRoot: typeof candidate.activeRoot === "string" ? candidate.activeRoot : null,
    workspaces: Array.isArray(candidate.workspaces) ? candidate.workspaces : [],
    // Spread rather than defaulted: both are optional, and JSON writes no key for an `undefined`,
    // so a file from a build that predates the updater comes back without them and reads as
    // "never checked, nothing skipped" — which is exactly true.
    ...(typeof candidate.lastUpdateCheckAt === "number" ? { lastUpdateCheckAt: candidate.lastUpdateCheckAt } : {}),
    ...(typeof candidate.skippedUpdateVersion === "string"
      ? { skippedUpdateVersion: candidate.skippedUpdateVersion }
      : {}),
  };
}

export interface AppStoreOptions {
  /**
   * The state file exists and the operating system refused it. Called with the path and the errno.
   *
   * Passed in rather than imported, for the reason `DiagnosticsOptions.directory` is: `main.ts`
   * keeps owning every path and every side effect, and this module keeps being a thing a test can
   * point at a temporary directory.
   */
  readonly onUnreadable?: (file: string, code: string) => void;
}

/**
 * The errno of a file system refusal, or `null` for any other failure.
 *
 * `unknown` in, because a `catch` binding is: `JSON.parse` throws a `SyntaxError` with no `code`,
 * and `readFileSync` throws an `Error` with one.
 */
function refusalCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null) return NO_CODE;
  const code: unknown = (cause as { code?: unknown }).code;
  return typeof code === "string" && UNREADABLE_CODES.has(code) ? code : NO_CODE;
}

export function createAppStore(userDataDir: string, options: AppStoreOptions = {}): AppStore {
  const file = join(userDataDir, STATE_FILE);
  let state = emptyState();

  if (existsSync(file)) {
    try {
      state = reconcile(JSON.parse(readFileSync(file, ENCODING)) as unknown);
    } catch (cause) {
      // A corrupt state file is not worth a dialog: the defaults are correct enough.
      //
      // A file that could not be *read* is a different event wearing the same recovery. The
      // defaults are not correct there — they discard every registered workspace and look exactly
      // like a fresh install — so the caller is told, and decides whether that is a log line or
      // something louder. Still not a throw: an app that will not start is worse than one that
      // starts empty and says why.
      const code = refusalCode(cause);
      if (code !== NO_CODE) options.onUnreadable?.(file, code);
      state = emptyState();
    }
  }

  /**
   * A failed write throws, unchanged, the way it always has: it reaches `ipcMain.handle`, which
   * makes it visible. The one thing added is which of the two failures it was — a permission
   * refusal and a full disk are both `writeFileAtomic` throwing, and only one of them is the
   * update having changed this build's identity.
   */
  function persist(): void {
    try {
      writeFileAtomic(file, JSON.stringify(state, null, JSON_INDENT));
    } catch (cause) {
      const code = refusalCode(cause);
      if (code !== NO_CODE) options.onUnreadable?.(file, code);
      throw cause;
    }
  }

  function findOrCreate(root: string): WorkspaceState {
    const found = state.workspaces.find((workspace) => workspace.root === root);
    if (found !== undefined) return found;
    const created: WorkspaceState = { root, lastOpenedAt: Date.now(), ...EMPTY_SESSION };
    state.workspaces.push(created);
    persist();
    return created;
  }

  return {
    read: () => state,
    update(mutate) {
      mutate(state);
      persist();
      return state;
    },
    workspaceFor: findOrCreate,
    sessionFor(root) {
      const workspace = findOrCreate(root);
      return {
        activeEnvironment: workspace.activeEnvironment,
        activeNodeId: workspace.activeNodeId,
        collapsedIds: workspace.collapsedIds,
        tabs: workspace.tabs,
        drafts: workspace.drafts,
      };
    },
    // Field by field rather than a spread: this is the far side of an IPC boundary, and a
    // snapshot is the one thing here the renderer names the shape of.
    saveSession(root, snapshot) {
      const workspace = findOrCreate(root);
      workspace.activeEnvironment = snapshot.activeEnvironment;
      workspace.activeNodeId = snapshot.activeNodeId;
      workspace.collapsedIds = [...snapshot.collapsedIds];
      workspace.tabs = snapshot.tabs.map((tab) => ({ nodeId: tab.nodeId, subTab: tab.subTab }));
      workspace.drafts = snapshot.drafts.map((draft) => ({
        nodeId: draft.nodeId,
        edits: draft.edits,
        text: draft.text,
      }));
      persist();
    },
    handles() {
      return [...state.workspaces]
        .sort((a, b) => (a.lastOpenedAt > b.lastOpenedAt ? NEWEST_FIRST : OLDEST_FIRST))
        .map((workspace) => ({
          root: workspace.root,
          name: basename(workspace.root),
          lastOpenedAt: workspace.lastOpenedAt,
        }));
    },
  };
}
