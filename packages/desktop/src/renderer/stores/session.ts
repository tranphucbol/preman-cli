/**
 * The connection, and the one place pushes turn into state.
 *
 * Every unsolicited message from the engine is routed here exactly once. Views never subscribe to
 * the port; they subscribe to the store that this file writes into. That keeps "what happens when
 * a file changes on disk" answerable by reading one function instead of auditing every component.
 */
import { create } from "zustand";

import {
  EXIT_CODES,
  markPhase,
  PHASES,
  type Catalog,
  type EngineError,
  type EngineMessage,
} from "@preman/desktop/engine/protocol.js";
import type { CreateWorkspaceResult, HostFailure, WorkspaceHandle } from "@preman/desktop/preload/bridge.js";

import { EngineRequestError, onEngineClient, type EngineClient } from "@preman/desktop/renderer/client.js";
import { publishPhaseReader } from "@preman/desktop/renderer/phases.js";
import { readSession, restoreCollapse, restoreOpenState, startPersistence } from "@preman/desktop/renderer/persist.js";
import { useCatalogStore } from "./catalog.js";
import { useOverlayStore } from "./overlay.js";
import { useRunsStore } from "./runs.js";
import { useSearchStore } from "./search.js";
import { isDirty, useTabsStore } from "./tabs.js";

const NO_CLIENT = null;
/** How many environments a workspace may have before choosing one stops being unambiguous. */
const SOLE_ENVIRONMENT = 1;
const NO_VARIABLE_WRITES = 0;
const ONE_VARIABLE_WRITE = 1;

export interface SessionState {
  client: EngineClient | null;
  root: string | null;
  workspaces: WorkspaceHandle[];
  /** Set when the fs watcher could not start. External edits will be missed until restart. */
  degraded: string | null;
  hostFailure: HostFailure | null;
  /**
   * Which environment the next run uses, in the three states core distinguishes: a name picks it,
   * `null` says "none" out loud, and `undefined` means nobody has chosen yet, which is what lets
   * the sole environment be adopted. Collapsing the last two would make "No environment" either a
   * lie or unreachable, so the picker needs all three.
   */
  environment: string | null | undefined;
  /**
   * How many variables this app has written. A counter rather than a flag, so it can be a
   * dependency: every reader that resolves a token re-resolves when it moves.
   *
   * The watcher does turn the environment file this wrote into a catalog revision, but it arrives
   * on a debounce and not at all when the watcher is degraded. A preview that lags the value you
   * just set is exactly how a preview stops being believed.
   */
  variableWrites: number;

  // Function properties rather than method signatures: these are read off the state object and
  // handed to event handlers, and none of them uses `this`.
  setClient: (client: EngineClient | null, root: string | null) => void;
  setWorkspaces: (workspaces: WorkspaceHandle[]) => void;
  setDegraded: (message: string | null) => void;
  setHostFailure: (failure: HostFailure | null) => void;
  setEnvironment: (name: string | null | undefined) => void;
  /** Called after a successful `write-variable`, by whoever made it. */
  countVariableWrite: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  client: NO_CLIENT,
  root: null,
  workspaces: [],
  degraded: null,
  hostFailure: null,
  environment: undefined,
  variableWrites: NO_VARIABLE_WRITES,

  setClient(client, root) {
    set({ client, root });
  },
  setWorkspaces(workspaces) {
    set({ workspaces });
  },
  setDegraded(degraded) {
    set({ degraded });
  },
  setHostFailure(hostFailure) {
    set({ hostFailure });
  },
  setEnvironment(environment) {
    set({ environment });
  },
  countVariableWrite() {
    set((state) => ({ variableWrites: state.variableWrites + ONE_VARIABLE_WRITE }));
  },
}));

/** `EngineRequestError` is the only rejection the client produces, so this loses nothing. */
export function toEngineError(cause: unknown): EngineError {
  if (cause instanceof EngineRequestError) {
    return { message: cause.message, details: cause.details, exitCode: cause.exitCode };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return { message, details: [], exitCode: EXIT_CODES.CLI };
}

/** Read one node into its tab. Used on open, on external change, and after a save. */
export async function loadTab(nodeId: string): Promise<void> {
  const { client } = useSessionStore.getState();
  if (client === null) return;
  try {
    const document = await client.send("read-node", { nodeId });
    useTabsStore.getState().loaded(nodeId, document);
  } catch (cause) {
    useTabsStore.getState().failed(nodeId, toEngineError(cause));
  }
}

/**
 * What an external edit does to the tabs that are open on it.
 *
 * A clean tab reloads silently, because the user's copy and the file were the same and now the file
 * moved. A dirty tab is flagged rather than reloaded: overwriting unsaved work to stay in sync is
 * the one behaviour a tool must never have.
 */
export function applyExternalChange(nodeIds: readonly string[]): void {
  const tabs = useTabsStore.getState();
  for (const nodeId of nodeIds) {
    const tab = tabs.tabs.get(nodeId);
    if (tab === undefined) continue;
    if (isDirty(tab)) tabs.markConflicted(nodeId);
    else void loadTab(nodeId);
  }
}

/** A catalog that no longer contains a node means the file is gone from under an open tab. */
function orphanMissingTabs(): void {
  const { byId } = useCatalogStore.getState();
  const tabs = useTabsStore.getState();
  for (const nodeId of tabs.order) {
    if (byId.has(nodeId)) continue;
    tabs.markOrphaned(nodeId);
  }
}

/**
 * The one place a catalog becomes state, whether it was asked for or pushed. Two call sites doing
 * this by hand is how the asked-for path silently stopped adopting the sole environment.
 */
function applyCatalog(catalog: Catalog): void {
  useCatalogStore.getState().replace(catalog);
  adoptSoleEnvironment(catalog.environments);
  orphanMissingTabs();
}

/**
 * Adopt the only environment a workspace has.
 *
 * Not a convenience. `runSelection` with no `env` silently uses the sole environment when there is
 * exactly one (`api/run.ts:123`), so a picker reading "No environment" beside a run that used
 * `QC` would be the app telling the user something untrue about what it just sent. With several
 * environments core refuses to guess and reports the ambiguity, which is why nothing is adopted
 * here in that case.
 *
 * Only when nobody has chosen. An explicit `null` is an answer, and adopting over it would take
 * the user's "none" away every time a catalog arrived.
 */
function adoptSoleEnvironment(environments: readonly { readonly name: string }[]): void {
  const session = useSessionStore.getState();
  if (session.environment !== undefined) return;
  const [sole] = environments;
  if (sole === undefined || environments.length > SOLE_ENVIRONMENT) return;
  session.setEnvironment(sole.name);
}

function route(message: EngineMessage): void {
  if (!("push" in message)) return;
  switch (message.push) {
    case "catalog":
      applyCatalog(message.catalog);
      return;
    case "run-event":
      useRunsStore.getState().apply(message.event);
      return;
    case "run-done":
      useRunsStore.getState().finish(message.runId, {
        warnings: message.warnings,
        cancelled: message.cancelled,
        ...(message.error === undefined ? {} : { error: message.error }),
      });
      return;
    case "external-change":
      applyExternalChange(message.nodeIds);
      return;
    case "git-status":
      useCatalogStore.getState().applyGit(message.status);
      return;
    case "degraded":
      useSessionStore.getState().setDegraded(message.message);
      return;
  }
}

/**
 * Bring a workspace back up: its remembered session, then its catalog, then its tabs.
 *
 * The session is read before the catalog is even asked for, because collapse state has to be in
 * place when the tree arrives. Everything else waits for the catalog, because a tab needs a name
 * and a kind. Persistence starts last, once there is nothing left to restore over.
 */
async function resume(client: EngineClient): Promise<void> {
  const snapshot = await readSession(client.root);
  restoreCollapse(snapshot);

  // The first catalog is asked for rather than pushed: the host builds it lazily, so nothing
  // exists to push until somebody wants it. Marked either side of the await rather than around
  // `applyCatalog`, because what is between the two marks is the engine's build and the port, and
  // what follows the second is this thread's own re-index.
  markPhase(PHASES.rendererCatalogAsked);
  const catalog = await client.send("catalog", {});
  markPhase(PHASES.rendererCatalogArrived);
  applyCatalog(catalog);

  // Asked for once, then pushed for the rest of the session. Not awaited: a workspace that is not
  // in a repository, or a `git` that is slow to answer, must not hold up the tabs.
  void client
    .send("git-status", {})
    .then((status) => {
      useCatalogStore.getState().applyGit(status);
    })
    .catch(() => undefined);

  await Promise.all(restoreOpenState(snapshot).map(loadTab));
  stopPersistence = startPersistence(client.root);
}

/** Non-null exactly while a workspace is up. Stopped before its stores are cleared, never after. */
let stopPersistence: (() => void) | null = null;

/**
 * Start listening. Called once, from the mount.
 *
 * A new port means a different workspace, so the previous client is closed and every store that
 * held that workspace's state is emptied. Leaving a stale tree on screen while a new engine boots
 * is how a GUI shows a lie.
 */
export function connect(): () => void {
  const bridge = window.preman;

  const stopFailures = bridge.onHostFailure((failure) => {
    useSessionStore.getState().setHostFailure(failure);
  });

  const stopPorts = onEngineClient((client) => {
    markPhase(PHASES.rendererPortReceived);
    const session = useSessionStore.getState();
    session.client?.close();
    // Before the clear, not after: the last unsaved keystroke still belongs to the workspace whose
    // stores are about to be emptied, and a flush after the clear would persist the emptiness.
    stopPersistence?.();
    stopPersistence = null;
    useCatalogStore.getState().clear();
    useTabsStore.getState().clear();
    useRunsStore.getState().clear();
    useSearchStore.getState().clear();
    // The runner is opened on a node id and the variable manager on an environment; neither means
    // anything in the workspace that is arriving.
    useOverlayStore.getState().dismiss();
    session.setDegraded(null);
    session.setHostFailure(null);
    session.setEnvironment(undefined);
    session.setClient(client, client.root);
    // Re-parked on every port: a reader that answered for the previous host would report the
    // timings of a workspace nobody is looking at.
    publishPhaseReader(() => client.send("phases", {}));

    client.onPush(route);
    resume(client).catch((cause: unknown) => {
      const error = toEngineError(cause);
      useSessionStore.getState().setHostFailure({
        root: client.root,
        message: error.message,
        details: error.details,
      });
    });
  });

  void refreshWorkspaces();

  return () => {
    stopFailures();
    stopPorts();
    stopPersistence?.();
    stopPersistence = null;
  };
}

export async function refreshWorkspaces(): Promise<void> {
  const workspaces = await window.preman.listWorkspaces();
  useSessionStore.getState().setWorkspaces(workspaces);
}

export async function openWorkspaceDialog(): Promise<void> {
  const picked = await window.preman.pickWorkspaceDirectory();
  if (picked === null) return;
  await window.preman.openWorkspace(picked);
  await refreshWorkspaces();
}

export async function switchWorkspace(root: string): Promise<void> {
  await window.preman.openWorkspace(root);
  await refreshWorkspaces();
}

/**
 * Make a workspace and move the window to it.
 *
 * The refusal is returned rather than raised as a banner: the naming dialog is still on screen, and
 * an unusable name or an existing directory is answered beside the field that caused it. Nothing
 * here touches the session unless a directory was actually created — a failed attempt leaves the
 * active workspace, its host and Recents exactly as they were.
 *
 * Opening goes through `switchWorkspace`, the same path a recent workspace takes, so creation adds
 * no host lifecycle of its own.
 */
export async function createNewWorkspace(name: string): Promise<CreateWorkspaceResult> {
  const result = await window.preman.createWorkspace(name);
  if (!result.ok) return result;
  await switchWorkspace(result.root);
  return result;
}
