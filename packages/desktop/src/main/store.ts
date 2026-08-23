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
  };
}

export function createAppStore(userDataDir: string): AppStore {
  const file = join(userDataDir, STATE_FILE);
  let state = emptyState();

  if (existsSync(file)) {
    try {
      state = reconcile(JSON.parse(readFileSync(file, ENCODING)) as unknown);
    } catch {
      // A corrupt state file is not worth a dialog: the defaults are correct enough.
      state = emptyState();
    }
  }

  function persist(): void {
    writeFileAtomic(file, JSON.stringify(state, null, JSON_INDENT));
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
