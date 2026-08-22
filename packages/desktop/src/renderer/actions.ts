/**
 * Everything the app does to a workspace, in one place.
 *
 * Components decide when; this module decides what. It exists so a click handler never has to
 * know whether saving a tab is one engine call or two, and so every failure lands in the same
 * shape instead of each pane inventing its own error handling.
 */
import type { MutateOp } from "@preman/desktop/engine/protocol.js";

import { loadTab, toEngineError, useSessionStore } from "@preman/desktop/renderer/stores/session.js";
import { isDirty, useTabsStore, type Tab } from "@preman/desktop/renderer/stores/tabs.js";
import { useCatalogStore } from "@preman/desktop/renderer/stores/catalog.js";
import { useRunsStore } from "@preman/desktop/renderer/stores/runs.js";

/** A failure a caller wants to show rather than swallow. */
export type Failure = { readonly message: string; readonly details: readonly string[] };

function failure(cause: unknown): Failure {
  const error = toEngineError(cause);
  return { message: error.message, details: error.details };
}

function client() {
  return useSessionStore.getState().client;
}

/**
 * Save a tab.
 *
 * The raw YAML tab and the field editors are two different writes because they mean two
 * different things: `write-text` keeps the user's bytes, `write-node` patches keys and keeps
 * everyone else's comments. A tab that has both takes the raw text, because that is the one
 * the user was last looking at.
 */
export async function saveTab(tab: Tab): Promise<Failure | null> {
  const engine = client();
  if (engine === null || !isDirty(tab)) return null;
  const tabs = useTabsStore.getState();
  try {
    const document =
      tab.text !== null
        ? await engine.send("write-text", { nodeId: tab.nodeId, text: tab.text })
        : await engine.send("write-node", { nodeId: tab.nodeId, edits: [...tab.edits] });
    tabs.saved(tab.nodeId, document);
    return null;
  } catch (cause) {
    return failure(cause);
  }
}

/**
 * Send one request.
 *
 * Saving first is deliberate and is the one place this app departs from Postman, which sends
 * the in-memory draft. The engine runs files, so sending an unsaved draft would either mean a
 * second code path through the runner or lying about what was sent. Saving is honest and it
 * is what the dirty dot already promised.
 */
export async function sendNode(nodeId: string): Promise<Failure | null> {
  const engine = client();
  if (engine === null) return null;

  const tab = useTabsStore.getState().tabs.get(nodeId);
  if (tab !== undefined && isDirty(tab)) {
    const saveFailure = await saveTab(tab);
    if (saveFailure !== null) return saveFailure;
  }

  const environment = useSessionStore.getState().environment;
  try {
    await engine.send("run", {
      args: { nodeId, ...(environment === null ? {} : { environment }) },
    });
    return null;
  } catch (cause) {
    return failure(cause);
  }
}

export async function cancelRun(runId: string): Promise<Failure | null> {
  const engine = client();
  if (engine === null) return null;
  try {
    await engine.send("cancel", { runId });
    return null;
  } catch (cause) {
    return failure(cause);
  }
}

/**
 * Apply a structural change.
 *
 * The engine pushes a fresh catalog on success, so nothing here touches the tree. What it does
 * do is follow the result: creating a request and then having to find it in the sidebar is a
 * tool making you do its filing.
 */
export async function mutate(op: MutateOp, options: { readonly open?: boolean } = {}): Promise<Failure | null> {
  const engine = client();
  if (engine === null) return null;
  try {
    const result = await engine.send("mutate", { op });
    if (options.open === true && result.nodeId !== null) {
      const created = useCatalogStore.getState().byId.get(result.nodeId);
      if (created !== undefined) {
        useCatalogStore.getState().select(created.id);
        useTabsStore.getState().open(created);
        await loadTab(created.id);
      }
    }
    return null;
  } catch (cause) {
    return failure(cause);
  }
}

/**
 * Close a tab, refusing to discard unsaved work silently.
 *
 * Returns the tab when it is dirty so the caller can ask. Postman shows a modal here and it is
 * the right call: the alternative is a keystroke that loses an afternoon.
 */
export function closeTab(nodeId: string): Tab | null {
  const tab = useTabsStore.getState().tabs.get(nodeId);
  if (tab !== undefined && isDirty(tab)) return tab;
  useTabsStore.getState().close(nodeId);
  return null;
}

export function discardAndClose(nodeId: string): void {
  useTabsStore.getState().close(nodeId);
}

/** Clearing the console is a per-workspace action, so it lives with the rest of them. */
export function clearConsole(): void {
  useRunsStore.getState().clearConsole();
}
