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
  CommandFormat,
  CommandPlan,
  ImportPlan,
  LinkOverride,
  MethodChoices,
  MutateOp,
  ReportFormat,
  RequestDraft,
  SpecPlan,
  SpecsView,
  TextPreview,
  VariableView,
  VariableWrite,
} from "@preman/desktop/engine/protocol.js";

import { planDuplicate } from "@preman/desktop/renderer/model/order.js";
import { flushPending } from "@preman/desktop/renderer/pending.js";
import { loadTab, toEngineError, useSessionStore } from "@preman/desktop/renderer/stores/session.js";
import { isDirty, useTabsStore, type Tab } from "@preman/desktop/renderer/stores/tabs.js";
import { useCatalogStore } from "@preman/desktop/renderer/stores/catalog.js";
import { useRunsStore } from "@preman/desktop/renderer/stores/runs.js";
// The shape a naming dialog waits on. Imported rather than restated, so an action that answers one
// cannot drift from what the dialog reads; the dependency is a type and points at no component.
import type { AskOutcome } from "@preman/desktop/renderer/ui/Dialog.js";

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
 *
 * `flushPending()` runs before the store is read. The caret may be sitting in an editor that
 * commits on blur - which `Cmd+S` never causes, since it is bound at `window` precisely so no
 * field can swallow it - so without this, "Save" would write whatever was there before the last
 * keystroke. `setField`/`setText` land through `useTabsStore.getState().setField` synchronously
 * and outside React, so there is no batching window between the flush and the re-read below: by
 * the time `useTabsStore.getState()` runs, the flushed edit is already in it.
 */
export async function saveTab(tab: Tab): Promise<Failure | null> {
  const engine = client();
  if (engine === null) return null;
  flushPending();
  const tabs = useTabsStore.getState();
  const current = tabs.tabs.get(tab.nodeId) ?? tab;
  if (!isDirty(current)) return null;
  try {
    const document =
      current.text !== null
        ? await engine.send("write-text", { nodeId: current.nodeId, text: current.text })
        : await engine.send("write-node", { nodeId: current.nodeId, edits: [...current.edits] });
    tabs.saved(current.nodeId, document);
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

  // Flushed before the dirty check, not just before the write inside `saveTab`: a focused editor
  // that has not blurred can hold text the store does not know about yet, and skipping this would
  // read that tab as clean and send the file as it was before the last keystroke.
  flushPending();
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
 * Create an environment and make it the active one.
 *
 * Selecting it is the whole point of creating one from the picker; leaving it unselected would be
 * the tool making you do its filing, which is the argument `mutate`'s `open` already makes for a
 * request. Nothing here has to wait for the catalog: `publish` posts the new one before the
 * mutation's response and port messages are ordered, so the entry exists to be found by the time
 * this resolves.
 *
 * Found by node id and not by the name that was typed, because creation sanitises what it writes —
 * `prod/east` lands on disk, and in this list, as `prod east`.
 *
 * A refusal is returned rather than raised as a banner, the way `createNewWorkspace` returns one:
 * a name another environment already holds is answered beside the field that caused it, while the
 * dialog is still on screen to correct it in.
 */
export async function createEnvironment(name: string): Promise<AskOutcome> {
  const engine = client();
  // No workspace, so no picker to have opened this and nothing to report. As `mutate` does.
  if (engine === null) return { ok: true };
  try {
    const { nodeId } = await engine.send("mutate", { op: { op: "create-environment", name } });
    const created = useCatalogStore.getState().environments.find((candidate) => candidate.id === nodeId);
    if (created !== undefined) useSessionStore.getState().setEnvironment(created.name);
    return { ok: true };
  } catch (cause) {
    return { ok: false, message: failure(cause).message };
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
 * Copy a request, landing the copy directly below the original and opening it.
 *
 * What is copied is the file on disk, not the tab's draft: under decision 010 a draft is not the
 * request yet, so there is nothing else this could honestly copy. Save first if you meant the
 * edits.
 *
 * Two round trips in the renumber case, because `applyPlan` discards every `nodeId` and only the
 * single-op `mutate` can open what it made. Reaching that case needs a folder with no gap left
 * below the original, so the common duplicate is still one call.
 */
export async function duplicateNode(nodeId: string): Promise<Failure | null> {
  const { order, reorderOps } = planDuplicate(useCatalogStore.getState().nodes, nodeId);
  if (reorderOps.length > 0) {
    const failed = await applyPlan(reorderOps);
    if (failed !== null) return failed;
  }
  return mutate({ op: "duplicate", targetId: nodeId, ...(order === undefined ? {} : { order }) }, { open: true });
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
 * What a text would become on the next run, resolved against the session's environment.
 *
 * The engine resolves it, never this side of the port: expansion is recursive, cycle-guarded and
 * evaluates dynamic variables per occurrence, so a second implementation here would eventually
 * show a value a run would not send.
 */
export async function previewText(text: string): Promise<Result<TextPreview>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    const { environment } = useSessionStore.getState();
    return { ok: true, value: await engine.send("preview", { text, environment: environment ?? null }) };
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
 * The protos a workspace declares, the links they are reached through, and which of those links
 * this machine is missing.
 *
 * Re-read rather than cached, because a link is a thing on disk that another process - or another
 * window, or `ln -s` in a terminal - can change without telling anyone. The pane that shows it is
 * the pane that fixes it, so a stale answer is one that offers the wrong repair.
 */
export async function readSpecs(): Promise<Result<SpecsView>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    return { ok: true, value: await engine.send("specs", {}) };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}

/**
 * What adding these files would do, without doing any of it.
 *
 * Every write in this pane goes plan-then-apply rather than straight through, because both halves
 * of what an add decides are things the user may want to overrule: which checkout a link points at,
 * and what that link is called. A plan is also the only honest place to say a proto will not load -
 * core resolves the include dirs a spec *would* get through its link, so the answer is the real one
 * and not a guess made before the link exists.
 */
export async function planSpecs(
  files: readonly string[],
  overrides: Record<string, LinkOverride> = {},
): Promise<Result<SpecPlan>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    return { ok: true, value: await engine.send("plan-specs", { files: [...files], overrides }) };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}

/**
 * What moving the already-declared specs onto shared links would do.
 *
 * The same plan shape as an add, deliberately: converting is adding, with the old entry named as
 * the one being replaced. A workspace written by hand - or by an older preman - carries paths to
 * *this* machine's checkouts, and this is what turns them into paths that mean the same thing
 * everywhere.
 */
export async function planConversion(overrides: Record<string, LinkOverride> = {}): Promise<Result<SpecPlan>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    return { ok: true, value: await engine.send("plan-conversion", { overrides }) };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}

/**
 * Create the links and write the specs.
 *
 * Answers with the re-read view for the reason `writeVariable` does: the pane would otherwise have
 * to re-derive which links now resolve, and would be wrong the moment the disk disagreed.
 */
export async function applySpecs(plan: SpecPlan): Promise<Result<SpecsView>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    return { ok: true, value: await engine.send("apply-specs", { plan }) };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}

/** Undeclare one spec. The link it was reached through is left alone; other workspaces use it. */
export async function removeSpec(declared: string): Promise<Result<SpecsView>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    return { ok: true, value: await engine.send("remove-spec", { declared }) };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}

/**
 * Point one link at a checkout on this machine.
 *
 * This is the whole payoff of declaring specs through a shared root: a colleague who clones a
 * workspace fixes every spec under a repository with one directory pick, instead of editing as
 * many absolute paths as there are protos.
 */
export async function linkCheckout(name: string, target: string, repoint = false): Promise<Result<SpecsView>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    return { ok: true, value: await engine.send("link-checkout", { name, target, repoint }) };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}

/**
 * What a pasted `curl` or `grpcurl` would become, without writing it.
 *
 * Plan-then-apply for the same reason the specs pane is, and one more: the paste is the only
 * input in the app the user cannot check by reading it back. A command is a shell word list,
 * and which of its flags survive into a request file is not something anyone can predict from
 * looking at it - so the pane shows the document first and writes it second.
 */
export async function planImport(
  text: string,
  format: CommandFormat | undefined,
  parentId: string | undefined,
): Promise<Result<ImportPlan>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    const payload = {
      text,
      ...(format === undefined ? {} : { format }),
      ...(parentId === undefined ? {} : { parentId }),
    };
    return { ok: true, value: await engine.send("plan-import", payload) };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}

/**
 * One request as the `curl` or `grpcurl` that would send it.
 *
 * The reverse of {@link planImport}, and a plan for the same reason: what the command cannot
 * carry — a script, a test, a cookie the jar would have held — is the half worth reading, and
 * it is not visible in the words themselves. The environment travels because a command has no
 * `{{token}}` left in it, so which environment was selected decides what it says.
 *
 * All three of the session's environment states are passed through, absent included: `undefined`
 * is what lets the engine adopt a sole environment, which is what a run already does.
 *
 * `draft` is the projected document the editor is showing. It is sent every time rather than only
 * when the tab is dirty, because "dirty" is a fact about the tab and the command is about the
 * request: branching on it would make a saved request and a reverted one take different code
 * paths to the same answer.
 */
export async function planCommand(
  nodeId: string,
  environment: string | null | undefined,
  draft: RequestDraft,
): Promise<Result<CommandPlan>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    const payload = { nodeId, draft, ...(environment === undefined ? {} : { environment }) };
    return { ok: true, value: await engine.send("plan-command", payload) };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}

/**
 * Every `.proto` under a directory, found by the engine.
 *
 * The walk is the engine's because the renderer may not read the disk, and it is a walk at all
 * because the repositories this feature exists for declare twenty to thirty-five protos each.
 * Picking those one at a time through a dialog is the task, not a step in it.
 */
export async function collectProtos(dir: string): Promise<Result<string[]>> {
  const engine = client();
  if (engine === null) return { ok: false, failure: DISCONNECTED };
  try {
    return { ok: true, value: await engine.send("collect-protos", { dir }) };
  } catch (cause) {
    return { ok: false, failure: failure(cause) };
  }
}

/** Proto files chosen by the user. Empty when they cancelled, or picked nothing; the same answer. */
export async function pickProtoFiles(): Promise<string[]> {
  return window.preman.pickProtoFiles();
}

/** A directory to walk for protos. `null` if the pick was cancelled. */
export async function pickProtoFolder(): Promise<string | null> {
  return window.preman.pickProtoFolder();
}

/**
 * The checkout a named link should point at. `null` if the pick was cancelled.
 *
 * `startIn` is where the dialog opens rather than what it answers: the workspace's own checkout
 * is the likeliest target for a repo-local workspace, and an empty dialog is what turns decision
 * 4's exact name match into a directory hunt (ADR 042).
 */
export async function pickCheckout(name: string, startIn: string | null): Promise<string | null> {
  return window.preman.pickCheckout(name, startIn);
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
