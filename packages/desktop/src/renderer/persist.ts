/**
 * What the app remembers about a workspace between runs: which tabs were open, what was
 * collapsed, which environment was chosen, and what had not been saved.
 *
 * All of it lives in app data, never in the workspace. That is the whole point: closing the app
 * with unsaved work must cost nothing, and `git status` must stay clean while it is open. So an
 * unsaved edit is recoverable without ever having been committable.
 *
 * Reading is split in two on purpose. Collapse state is applied *before* the first catalog, so the
 * tree never paints fully expanded and then folds; tabs are applied *after* it, because a tab needs
 * a name and a kind and only the catalog has those.
 *
 * This module and `stores/session.ts` import each other. Every use is inside a function body, so
 * both modules are fully evaluated before either reaches the other, and the alternative was
 * threading a three-method port through `startPersistence` to carry one string.
 */
import type { FieldEdit } from "@preman/desktop/engine/protocol.js";
import type { SessionDraft, SessionSnapshot, SessionTab } from "@preman/desktop/preload/bridge.js";
import { useCatalogStore } from "@preman/desktop/renderer/stores/catalog.js";
import { useSessionStore } from "@preman/desktop/renderer/stores/session.js";
import { isDirty, isSubTab, useTabsStore } from "@preman/desktop/renderer/stores/tabs.js";

/**
 * Long enough that a burst of typing is one write, short enough that a crash costs a sentence.
 * Drafts are the reason this delay exists at all; the rest of the session rides along.
 */
export const DRAFT_PERSIST_DEBOUNCE_MS = 800;

const NO_EDITS: readonly FieldEdit[] = [];

/** Fresh each time: the arrays are mutable and a shared empty session would alias across roots. */
function emptySession(): SessionSnapshot {
  // No `activeEnvironment`: a session that could not be read has chosen nothing, and `null` here
  // would silently mean "no environment" for a workspace with exactly one.
  return { activeNodeId: null, collapsedIds: [], tabs: [], drafts: [] };
}

/**
 * Never rejects. A session that cannot be read must cost the user their layout, never their
 * workspace, which is the same trade the app store makes for a corrupt state file.
 */
export async function readSession(root: string): Promise<SessionSnapshot> {
  try {
    return await window.preman.readSession(root);
  } catch {
    return emptySession();
  }
}

/** Apply before the first catalog. `replace` folds the tree as it arrives, so nothing flashes. */
export function restoreCollapse(snapshot: SessionSnapshot): void {
  useCatalogStore.getState().restoreCollapsed(snapshot.collapsedIds);
}

/**
 * Apply after the first catalog: the environment, the open tabs, their drafts and which one was
 * active. Returns the node ids that now have a tab, for the caller to read.
 */
export function restoreOpenState(snapshot: SessionSnapshot): readonly string[] {
  const catalog = useCatalogStore.getState();
  const tabs = useTabsStore.getState();

  // A remembered choice beats `adoptSoleEnvironment`'s guess, but only while it still exists: a
  // picker naming an environment the workspace no longer has is the app telling the user
  // something untrue about what the next run will use. A remembered "none" always still exists.
  const environment = snapshot.activeEnvironment;
  if (environment === null) useSessionStore.getState().setEnvironment(null);
  else if (environment !== undefined && catalog.environments.some((candidate) => candidate.name === environment)) {
    useSessionStore.getState().setEnvironment(environment);
  }

  const opened: string[] = [];
  for (const tab of snapshot.tabs) {
    const node = catalog.byId.get(tab.nodeId);
    // The file is gone. An orphan banner is for a file that vanished while the user was looking
    // at it, not for one that was deleted last week by somebody else.
    if (node === undefined) continue;
    tabs.open(node);
    if (tab.subTab !== null && isSubTab(tab.subTab)) tabs.setSubTab(node.id, tab.subTab);
    opened.push(node.id);
  }

  // After every tab exists, because `restoreDraft` patches a tab and silently does nothing
  // without one. Before the caller reads, because `loaded` deliberately does not touch `edits`.
  for (const draft of snapshot.drafts) {
    if (!opened.includes(draft.nodeId)) continue;
    tabs.restoreDraft(draft.nodeId, readEdits(draft.edits), draft.text);
  }

  // Last, because `open` activates what it opens.
  const active = snapshot.activeNodeId;
  if (active !== null && opened.includes(active)) {
    tabs.activate(active);
    catalog.select(active);
  }

  return opened;
}

/**
 * Start writing changes back. Returns a stop function that flushes whatever is still pending.
 *
 * Call it only once the restore is done, and stop it *before* clearing the stores for another
 * workspace, or the clear is what gets persisted over the session that was just there.
 */
export function startPersistence(root: string): () => void {
  let pending: ReturnType<typeof setTimeout> | undefined;

  function write(): void {
    pending = undefined;
    void window.preman.saveSession(root, snapshotOf()).catch(() => {
      // Same trade as reading: a lost layout, never a lost workspace.
    });
  }

  // Not a debounce that resets on every change: continuous typing would then never reach a write
  // at all. The first change starts the clock and later ones ride it, so a long edit checkpoints
  // on a fixed cadence instead of only when the user pauses.
  function schedule(): void {
    if (pending !== undefined) return;
    pending = setTimeout(write, DRAFT_PERSIST_DEBOUNCE_MS);
  }

  const stops = [
    useCatalogStore.subscribe(schedule),
    useTabsStore.subscribe(schedule),
    useSessionStore.subscribe(schedule),
  ];

  return () => {
    for (const stop of stops) stop();
    if (pending === undefined) return;
    clearTimeout(pending);
    write();
  };
}

/** The three stores as one record. Only dirty tabs contribute a draft. */
function snapshotOf(): SessionSnapshot {
  const catalog = useCatalogStore.getState();
  const tabs = useTabsStore.getState();
  const { environment } = useSessionStore.getState();

  const open: SessionTab[] = [];
  const drafts: SessionDraft[] = [];
  for (const nodeId of tabs.order) {
    const tab = tabs.tabs.get(nodeId);
    if (tab === undefined) continue;
    open.push({ nodeId, subTab: tab.subTab });
    if (isDirty(tab)) drafts.push({ nodeId, edits: tab.edits, text: tab.text });
  }

  return {
    activeEnvironment: environment,
    activeNodeId: tabs.activeId,
    collapsedIds: [...catalog.collapsed],
    tabs: open,
    drafts,
  };
}

/**
 * App data is JSON, so a draft's edits arrive as `unknown` and a hand-edited or half-written
 * state file must not be able to put a malformed edit into a tab. Unrecognisable entries are
 * dropped rather than rejected wholesale: losing one field beats losing the whole draft.
 */
function readEdits(raw: unknown): readonly FieldEdit[] {
  if (!Array.isArray(raw)) return NO_EDITS;
  return raw.filter(isFieldEdit);
}

function isFieldEdit(value: unknown): value is FieldEdit {
  if (typeof value !== "object" || value === null) return false;
  const { path } = value as Partial<FieldEdit>;
  if (!Array.isArray(path)) return false;
  return path.every((step) => typeof step === "string" || typeof step === "number");
}
