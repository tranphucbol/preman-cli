/**
 * App data: which workspaces are registered, what was open in each, and where the
 * window was. None of this is ever written into a workspace — that is the whole point
 * of the file living in `userData`. `git status` stays clean while the app is open.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { writeFileAtomic } from "@preman/core/workspace/atomic.js";
import type { WorkspaceHandle } from "@preman/desktop/preload/bridge.js";

const STATE_FILE = "state.json";
const STATE_VERSION = 1;
const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;
const ENCODING = "utf8";
const JSON_INDENT = 2;
const NEWEST_FIRST = -1;
const OLDEST_FIRST = 1;

/** A tab the user had open, plus enough to put the caret back where they left it. */
export interface TabState {
  nodeId: string;
  subTab: string | null;
  scrollTop: number;
  selectionStart: number | null;
}

/**
 * An unsaved edit. Persisted so a crash costs nothing, and persisted *here* so an
 * unsaved edit is recoverable without being committable — decision 12's trade.
 */
export interface DraftState {
  nodeId: string;
  /** Serialised `FieldEdit[]`; the renderer owns the shape, the store only carries it. */
  edits: unknown;
  text: string | null;
  updatedAt: number;
}

export interface WorkspaceState {
  root: string;
  lastOpenedAt: number;
  activeEnvironment: string | null;
  activeNodeId: string | null;
  collapsedIds: string[];
  tabs: TabState[];
  drafts: DraftState[];
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
  activeRoot: string | null;
  workspaces: WorkspaceState[];
}

export interface AppStore {
  read(): AppState;
  /** Mutate in place; the result is written atomically before this returns. */
  update(mutate: (state: AppState) => void): AppState;
  workspaceFor(root: string): WorkspaceState;
  handles(): WorkspaceHandle[];
}

function emptyState(): AppState {
  return {
    version: STATE_VERSION,
    window: { x: null, y: null, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
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

  return {
    read: () => state,
    update(mutate) {
      mutate(state);
      persist();
      return state;
    },
    workspaceFor(root) {
      const found = state.workspaces.find((workspace) => workspace.root === root);
      if (found !== undefined) return found;
      const created: WorkspaceState = {
        root,
        lastOpenedAt: Date.now(),
        activeEnvironment: null,
        activeNodeId: null,
        collapsedIds: [],
        tabs: [],
        drafts: [],
      };
      state.workspaces.push(created);
      persist();
      return created;
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
