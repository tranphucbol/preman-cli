/**
 * The connection, and the one place pushes turn into state.
 *
 * Every unsolicited message from the engine is routed here exactly once. Views never subscribe to
 * the port; they subscribe to the store that this file writes into. That keeps "what happens when
 * a file changes on disk" answerable by reading one function instead of auditing every component.
 */
import { useEffect, useState } from "react";
import { create } from "zustand";

import {
  EXIT_CODES,
  markPhase,
  PHASES,
  type Catalog,
  type EngineError,
  type EngineMessage,
} from "@preman/desktop/engine/protocol.js";
import type {
  CreateWorkspaceResult,
  HostFailure,
  MigrateResult,
  WorkspaceHandle,
} from "@preman/desktop/preload/bridge.js";

import { EngineRequestError, onEngineClient, type EngineClient } from "@preman/desktop/renderer/client.js";
import { openingState, openingTarget, type OpeningState } from "@preman/desktop/renderer/model/opening.js";
import { publishPhaseReader } from "@preman/desktop/renderer/phases.js";
import { readSession, restoreCollapse, restoreOpenState, startPersistence } from "@preman/desktop/renderer/persist.js";
import { useCatalogStore, type CatalogState } from "./catalog.js";
import { useOverlayStore } from "./overlay.js";
import { useRunsStore } from "./runs.js";
import { useSearchStore } from "./search.js";
import { isDirty, useTabsStore } from "./tabs.js";

const NO_CLIENT = null;
/** How many environments a workspace may have before choosing one stops being unambiguous. */
const SOLE_ENVIRONMENT = 1;
const NO_VARIABLE_WRITES = 0;
const ONE_VARIABLE_WRITE = 1;

/**
 * How long a workspace may take to open before the app admits it is opening one.
 *
 * Long enough that the committed fixture - and any workspace of a normal size - is simply on
 * screen, and no placeholder is ever painted. Short enough that a workspace which is genuinely
 * slow says so before the user has decided the app is broken. Below the shortest interval a
 * flash reads as intentional at, which is the number this is really guarding.
 */
const SKELETON_DELAY_MS = 150;

export interface SessionState {
  client: EngineClient | null;
  root: string | null;
  /**
   * The workspace the main process is already loading when the window appears, if there is one.
   *
   * The only fact about a workspace that is known before any engine port exists, and therefore the
   * only thing that can stop the first frame after a cold start from claiming no workspace is open.
   * Cleared the moment a client arrives, because from then on `root` is the better answer.
   */
  reopening: string | null;
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
  setReopening: (root: string | null) => void;
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
  reopening: null,
  workspaces: [],
  degraded: null,
  hostFailure: null,
  environment: undefined,
  variableWrites: NO_VARIABLE_WRITES,

  setClient(client, root) {
    set({ client, root });
  },
  setReopening(reopening) {
    set({ reopening });
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

// Hoisted so each subscription compares by reference and never re-runs on an unrelated write.
const selectReopening = (state: SessionState): string | null => state.reopening;
const selectRoot = (state: SessionState): string | null => state.root;
const selectFailed = (state: SessionState): boolean => state.hostFailure !== null;
const selectCatalogRoot = (state: CatalogState): string | null => state.root;

/**
 * Whether the pane calling this should draw a placeholder, and whether it has waited long enough
 * to be allowed to.
 *
 * A hook and not a store field, because the delay is per-pane state and the inputs live in two
 * different stores. Both panes that call it therefore run their own timer, which is correct rather
 * than merely tolerable: each one starts counting when it mounts, and a pane that appeared late
 * should not inherit a delay that has already expired somewhere else.
 *
 * The decision itself is `openingTarget`/`openingState` in `model/opening.ts`. What is here is the
 * clock and nothing else.
 */
export function useOpening(): OpeningState {
  const reopening = useSessionStore(selectReopening);
  const sessionRoot = useSessionStore(selectRoot);
  const failed = useSessionStore(selectFailed);
  const catalogRoot = useCatalogStore(selectCatalogRoot);
  /**
   * Which workspace is on its way in, and also the identity of this wait - which is why the
   * elapsed delay below is remembered as a root and not as a flag. A flag would have to be
   * cleared, and the only place left to clear it is synchronously inside the effect, which is a
   * cascading render. Comparing against the current target expires it for free.
   */
  const target = openingTarget({ reopening, sessionRoot, catalogRoot, failed });

  const [elapsedFor, setElapsedFor] = useState<string | null>(null);
  useEffect(() => {
    if (target === null) return;
    const timer = setTimeout(() => {
      setElapsedFor(target);
    }, SKELETON_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [target]);

  return openingState(target !== null, elapsedFor === target);
}

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

  // Asked once and never again: this is a fact about the launch, and the port that follows it is a
  // better answer to the same question. Not awaited, because nothing else here depends on it - the
  // panes are subscribed, and the round trip lands inside the delay they are already serving.
  void bridge.reopening().then((root) => {
    const session = useSessionStore.getState();
    // The port can beat the round trip on a warm launch, and then the hint is already history.
    if (session.root === null) session.setReopening(root);
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
    // The hint has been superseded by the thing it was a hint about.
    session.setReopening(null);
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

/**
 * Bring a Postman cloud workspace down to disk and move the window to it.
 *
 * The same shape as `createNewWorkspace` above and for the same reasons: the refusal is a returned
 * value rather than a banner, because the pane that asked is still on screen and "Postman Desktop
 * does not appear to be running" is answered there; and opening ends in `switchWorkspace`, so
 * migrating adds no host lifecycle of its own.
 *
 * The outcome is handed back rather than stored. It is a report about an operation that has
 * finished, read once by the pane that asked for it, and a store entry would only be a copy that
 * outlived its reader.
 */
export async function migrateFromPostman(workspaceId: string): Promise<MigrateResult> {
  const result = await window.preman.migratePostmanWorkspace(workspaceId);
  if (result.status === "migrated") await switchWorkspace(result.outcome.root);
  return result;
}
