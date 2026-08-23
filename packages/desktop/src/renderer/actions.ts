/**
 * Everything the app does to a workspace, in one place.
 *
 * Components decide when; this module decides what. It exists so a click handler never has to
 * know whether saving a tab is one engine call or two, and so every failure lands in the same
 * shape instead of each pane inventing its own error handling.
 */
import type {
  BodyMatch,
  BodyWindow,
  GrepResult,
  MethodChoices,
  MutateOp,
  ReportFormat,
  VariableView,
  VariableWrite,
} from "@preman/desktop/engine/protocol.js";

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

  try {
    await engine.send("run", { args: { nodeId, ...chosenEnvironment() } });
    return null;
  } catch (cause) {
    return failure(cause);
  }
}

/**
 * The environment fragment of a `RunArgs`.
 *
 * Absent when nobody has chosen, so the engine still adopts a sole environment; `null` when the
 * user chose "none", which core reads as an answer rather than a gap. The distinction is the whole
 * reason `environment` is three-valued, so it is spelled once here instead of at each call site.
 */
function chosenEnvironment(): { environment?: string | null } {
  const { environment } = useSessionStore.getState();
  return environment === undefined ? {} : { environment };
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
 * Apply a plan from the sidebar, in order and one at a time.
 *
 * Sequential is not a style choice. A plan that renumbers a destination before moving a node into
 * it depends on the renumber having landed, and a move rewrites the node's own id, so issuing the
 * two together would key the second operation on an id the first invalidated. The first failure
 * stops the rest: the alternative is finishing a plan on top of a tree that is no longer the one
 * the plan was made for.
 */
export async function applyPlan(ops: readonly MutateOp[]): Promise<Failure | null> {
  for (const op of ops) {
    const failed = await mutate(op);
    if (failed !== null) return failed;
  }
  return null;
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

/**
 * The three body calls answer with data rather than just succeeding, so they need a shape a
 * caller can read. Everything else here returns `Failure | null` because there is nothing to
 * hand back but the failure.
 */
export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Failure };

const DISCONNECTED: Failure = { message: "The workspace engine is not connected.", details: [] };

/** One window of a response body. The viewer asks for these as the reader moves. */
export async function bodyWindow(handle: string, offset: number): Promise<Result<BodyWindow>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    return { ok: true, value: await engine.send("body-window", { handle, offset }) };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}

/**
 * Pretty-print a whole body.
 *
 * The only call here that is not windowed, and the reason the engine caps it: the result is
 * one string in renderer memory, so the cap is what keeps that bounded.
 */
export async function bodyFormat(handle: string): Promise<Result<string>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    return { ok: true, value: await engine.send("body-format", { handle }) };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}

/**
 * Search a body in the engine.
 *
 * This is what `Cmd+F` in the body viewer does instead of searching the document, because the
 * document is one window and searching what you can already see is not searching.
 */
export async function bodySearch(handle: string, query: string): Promise<Result<BodyMatch[]>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    return { ok: true, value: await engine.send("body-search", { handle, query }) };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}

/**
 * The variable layers, as they would apply to the next run.
 *
 * `undefined` and `null` are the same question here - "what applies with no environment?" - so
 * they collapse. Nothing is being run, so there is no sole environment to adopt on the user's
 * behalf and no ambiguity to refuse.
 */
export async function readVariables(environment: string | null | undefined): Promise<Result<VariableView>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    return { ok: true, value: await engine.send("variables", { environment: environment ?? null }) };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}

/**
 * Set one value in one environment file.
 *
 * The result is the re-read view rather than an acknowledgement: an editor that patched its own
 * copy would have to re-derive which layer now wins, and would be wrong the moment the file on
 * disk disagreed. One edit, one round trip, one truth.
 */
export async function writeVariable(write: VariableWrite): Promise<Result<VariableView>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    return { ok: true, value: await engine.send("write-variable", { write }) };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}

/**
 * Search every request and group file in the workspace.
 *
 * In the engine, for the same reason `bodySearch` is: the renderer holds the tabs that are open,
 * which is between zero and a dozen files out of five thousand. Searching what is already loaded
 * would be a search box that finds less the less you have been working.
 */
export async function searchWorkspace(query: string): Promise<Result<GrepResult>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    return { ok: true, value: await engine.send("grep", { query }) };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}

/**
 * Every method the workspace's protos offer, resolved against one request.
 *
 * The node id is passed so each choice arrives with the `schema.location` that request needs;
 * see `MethodChoice`. Asked for on open of the picker rather than held in a store: the engine
 * caches the parse by mtime, so a second ask is a map over a list it already has.
 */
export async function listMethods(nodeId: string): Promise<Result<MethodChoices>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    return { ok: true, value: await engine.send("list-methods", { nodeId }) };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}

/**
 * A request body for a method, with `{{tokens}}` where the environment has a variable of the
 * same name. The environment is the session's, because that is the one the next run will use.
 */
export async function messageSkeleton(methodPath: string): Promise<Result<string>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    const { environment } = useSessionStore.getState();
    return { ok: true, value: await engine.send("message-skeleton", { methodPath, environment: environment ?? null }) };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}

/**
 * What the runner asks for beyond a node. Each field is one field of `RunArgs`, and every one of
 * them is a CLI flag first: this pane adds no run semantics of its own.
 */
export interface RunnerOptions {
  /**
   * `null` leaves the flag off, which is not the same as one: core takes the count from a data
   * file's rows when nothing was asked for, and an explicit count overrides them.
   */
  readonly iterationCount: number | null;
  /** An absolute path to a JSON or CSV file, chosen through the main process's dialog. */
  readonly iterationData: string | null;
  readonly bail: boolean;
  readonly delayRequestMs: number;
}

/**
 * Run a collection or a folder, answering with the run id.
 *
 * The id is what the runner pane watches, rather than "the latest run": starting a second run
 * while the first is still going must not silently repoint the pane at it.
 */
export async function startRun(nodeId: string, options: RunnerOptions): Promise<Result<string>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    const acknowledgement = await engine.send("run", {
      args: {
        nodeId,
        ...chosenEnvironment(),
        ...(options.iterationCount === null ? {} : { iterationCount: options.iterationCount }),
        ...(options.iterationData === null ? {} : { iterationData: options.iterationData }),
        bail: options.bail,
        delayRequestMs: options.delayRequestMs,
      },
    });
    return { ok: true, value: acknowledgement.runId };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}

/** An iteration data file, named by the user through the main process. `null` if they cancelled. */
export async function pickDataFile(): Promise<string | null> {
  return window.preman.pickDataFile();
}

/**
 * Export a finished run.
 *
 * The engine renders - it holds the outcome and owns every report format preman has - and the main
 * process writes, because the renderer is not allowed to name a place on disk. This function only
 * carries the text between them. Answers with the path written, or `null` if the save was
 * cancelled.
 */
export async function exportReport(runId: string, format: ReportFormat): Promise<Result<string | null>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    const report = await engine.send("run-report", { runId, format });
    return { ok: true, value: await window.preman.saveReport(report.suggestedName, report.text) };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}
