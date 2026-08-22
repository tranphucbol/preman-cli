/**
 * One engine host per open workspace. It holds every piece of state a GUI needs the
 * engine to keep across sends — the catalog, the body store, the watcher — so the
 * renderer holds none of it and `runSelection` is not asked to re-read the workspace
 * to answer a question the host already knows the answer to.
 *
 * Nothing here imports `electron`. The Electron wiring is the last twenty lines, and
 * `createEngineHost` is driven directly by the tests.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parse } from "yaml";
import { BodyStore } from "@preman/core/api/bodies.js";
import { buildCatalog, refreshCatalog, type Catalog, type CatalogNode } from "@preman/core/api/catalog.js";
import type { RunEvent, RunEventSink } from "@preman/core/api/events.js";
import {
  createCollection,
  createEnvironmentFile,
  createFolder,
  createRequestFile,
  deleteNode,
  editDefinitionFile,
  editRequestFile,
  moveNode,
  renameNode,
  reorderSiblings,
  replaceFileText,
} from "@preman/core/api/mutate.js";
import { runSelection, type RunSelectionArgs } from "@preman/core/api/run.js";
import { watchWorkspace, type WatchHandle } from "@preman/core/api/watch.js";
import { EXIT, PremanError } from "@preman/core/errors.js";
import { definitionPathFor, ENVIRONMENT_SUFFIX, nodeIdFor, REQUEST_SUFFIX } from "@preman/core/workspace/paths.js";
import { toEngineError } from "@preman/desktop/engine/errors.js";
import {
  type DocumentKind,
  type EngineMessage,
  type EngineRequest,
  type EngineResponse,
  type EngineResult,
  type MutateOp,
  type MutateResult,
  type NodeDocument,
  type RunArgs,
} from "@preman/desktop/engine/protocol.js";

/** Matching the CLI's defaults, so the app and `preman run` behave the same by default. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 5_000;
const DEFAULT_RUN_TIMEOUT_MS = 0;
const NO_DELAY_MS = 0;
const RUN_ID_PREFIX = "run-";
const FIRST_RUN = 1;
const SELECTOR_SEPARATOR = "/";
const PARENT_SEGMENT = "..";
const ENCODING = "utf8";
/** One scroll's worth of a response body. The renderer asks again as the viewport moves. */
const BODY_WINDOW_BYTES = 64 * 1024;
const BODY_SEARCH_LIMIT = 500;

export interface EngineHostOptions {
  /** The workspace root. Every node id in the protocol is relative to this. */
  root: string;
  /** A property, not a method, because the host destructures it and calls it unbound. */
  post: (message: EngineMessage) => void;
}

export interface EngineHost {
  /**
   * Answer one request. Never rejects: a failure is a response with `ok: false`, so a
   * dropped promise cannot cost the caller a pending id.
   */
  handle(request: EngineRequest): Promise<EngineResponse>;
  dispose(): void;
}

interface RunState {
  cancelled: boolean;
}

function usage(message: string, details: string[] = []): PremanError {
  return new PremanError(message, { exitCode: EXIT.CLI, details });
}

/**
 * Turn a node id back into a path, refusing anything that leaves the workspace. Ids
 * come from a catalog this host built, but a renderer is the untrusted side of the
 * port, so containment is checked here rather than assumed.
 */
function resolveWithinRoot(root: string, nodeId: string): string {
  if (nodeId.length === 0) throw usage("a node id is required");
  if (isAbsolute(nodeId)) throw usage(`"${nodeId}" is not a node id`, ["node ids are relative to the workspace root"]);

  const absolute = resolve(root, nodeId);
  const step = relative(root, absolute);
  if (step.length === 0 || step === PARENT_SEGMENT || step.startsWith(`${PARENT_SEGMENT}/`)) {
    throw usage(`"${nodeId}" is outside the workspace`, [`workspace root: ${root}`]);
  }
  return absolute;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The `RunTarget` selector for a node, rebuilt from the catalog rather than looked up
 * in a second full read. `RequestEntry.path` and `RequestGroup.path` are the chain of
 * declared names, which is exactly what walking `parentId` produces.
 */
function selectorFor(catalog: Catalog, nodeId: string): string {
  const byId = new Map(catalog.nodes.map((node) => [node.id, node] as const));
  const start = byId.get(nodeId);
  if (start === undefined) {
    throw usage(`"${nodeId}" is not in the catalog`, ["reload the workspace and try again"]);
  }

  const segments: string[] = [];
  let cursor: CatalogNode | undefined = start;
  while (cursor !== undefined) {
    segments.unshift(cursor.name);
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
  }
  return segments.join(SELECTOR_SEPARATOR);
}

export function createEngineHost(options: EngineHostOptions): EngineHost {
  const { root, post } = options;
  const bodies = new BodyStore();
  const runs = new Map<string, RunState>();
  let catalog: Catalog | undefined;
  let watcher: WatchHandle | undefined;
  let nextRun = FIRST_RUN;
  /** Refreshes are serialised: two overlapping `refreshCatalog` calls would race on `catalog`. */
  let reconciling: Promise<void> = Promise.resolve();
  let disposed = false;

  function publish(next: Catalog): Catalog {
    catalog = next;
    post({ push: "catalog", catalog: next });
    return next;
  }

  async function reconcile(paths: string[]): Promise<void> {
    if (disposed || catalog === undefined) return;
    const next = await refreshCatalog(catalog, paths);
    publish(next);
    post({ push: "external-change", nodeIds: paths.map((path) => nodeIdFor(root, path)) });
  }

  function startWatching(): void {
    watcher = watchWorkspace(
      root,
      (paths) => {
        reconciling = reconciling.then(() => reconcile(paths)).catch(() => undefined);
      },
      { onDegraded: (message) => post({ push: "degraded", message }) },
    );
  }

  async function ensureCatalog(): Promise<Catalog> {
    if (catalog !== undefined) return catalog;
    const built = await buildCatalog(root);
    catalog = built;
    if (watcher === undefined && !disposed) startWatching();
    return built;
  }

  /** After any write, the catalog on disk and the catalog in hand must agree. */
  async function rebuild(): Promise<Catalog> {
    return publish(await buildCatalog(root));
  }

  async function documentKindFor(nodeId: string, path: string): Promise<DocumentKind> {
    if (path.endsWith(REQUEST_SUFFIX)) return "request";
    if (path.endsWith(ENVIRONMENT_SUFFIX)) return "environment";
    const node = (await ensureCatalog()).nodes.find((candidate) => candidate.id === nodeId);
    if (node !== undefined) return node.kind;
    throw usage(`"${nodeId}" is not a request, a group or an environment`);
  }

  /** Where a node's editable bytes live: a group edits its definition, not its directory. */
  function fileFor(path: string, kind: DocumentKind): string {
    return kind === "collection" || kind === "folder" ? definitionPathFor(path) : path;
  }

  async function readNode(nodeId: string): Promise<NodeDocument> {
    const path = resolveWithinRoot(root, nodeId);
    const kind = await documentKindFor(nodeId, path);
    const file = fileFor(path, kind);
    let text: string;
    try {
      text = readFileSync(file, ENCODING);
    } catch (cause) {
      throw usage(`cannot read ${nodeId}`, [String(cause)]);
    }
    return { nodeId, file, kind, text, data: parse(text) as unknown };
  }

  async function writeNode(nodeId: string, edits: EngineRequest & { kind: "write-node" }): Promise<NodeDocument> {
    const path = resolveWithinRoot(root, nodeId);
    const kind = await documentKindFor(nodeId, path);
    const file = fileFor(path, kind);
    if (kind === "environment") {
      throw usage("an environment is edited through its values, not through field edits");
    }
    if (kind === "request") await editRequestFile(file, edits.edits);
    else await editDefinitionFile(file, edits.edits);
    return readNode(nodeId);
  }

  /** The raw YAML tab. The mutation seam owns the refusal, so an invalid document never lands. */
  async function writeText(nodeId: string, text: string): Promise<NodeDocument> {
    const path = resolveWithinRoot(root, nodeId);
    const kind = await documentKindFor(nodeId, path);
    await replaceFileText(fileFor(path, kind), text);
    return readNode(nodeId);
  }

  async function mutate(op: MutateOp): Promise<MutateResult> {
    const created = await applyMutation(op);
    const next = await rebuild();
    return { nodeId: created === undefined ? null : nodeIdFor(root, created), revision: next.revision };
  }

  async function applyMutation(op: MutateOp): Promise<string | undefined> {
    switch (op.op) {
      case "create-request":
        return createRequestFile({
          parentDir: requireDirectory(op.parentId),
          name: op.name,
          kind: op.kind,
          ...(op.order === undefined ? {} : { order: op.order }),
        });
      case "create-folder":
        return createFolder({
          parentDir: requireDirectory(op.parentId),
          name: op.name,
          ...(op.order === undefined ? {} : { order: op.order }),
        });
      case "create-collection":
        return createCollection({ root, name: op.name, ...(op.order === undefined ? {} : { order: op.order }) });
      case "create-environment":
        return createEnvironmentFile({ root, name: op.name });
      case "rename":
        return renameNode({ target: resolveWithinRoot(root, op.targetId), name: op.name });
      case "move":
        return moveNode({
          target: resolveWithinRoot(root, op.targetId),
          targetDir: requireDirectory(op.parentId),
          ...(op.order === undefined ? {} : { order: op.order }),
        });
      case "delete":
        await deleteNode(resolveWithinRoot(root, op.targetId));
        return undefined;
      case "reorder": {
        const orderByFile: Record<string, number> = {};
        for (const [nodeId, order] of Object.entries(op.orderById)) {
          const path = resolveWithinRoot(root, nodeId);
          orderByFile[isDirectory(path) ? definitionPathFor(path) : path] = order;
        }
        await reorderSiblings({ orderByFile });
        return undefined;
      }
    }
  }

  function requireDirectory(nodeId: string): string {
    const path = resolveWithinRoot(root, nodeId);
    if (!isDirectory(path)) throw usage(`"${nodeId}" is not a collection or folder`);
    return path;
  }

  function startRun(args: RunArgs): string {
    const runId = `${RUN_ID_PREFIX}${String(nextRun++)}`;
    const state: RunState = { cancelled: false };
    runs.set(runId, state);

    const sink: RunEventSink = {
      runId,
      emit: (event: RunEvent) => {
        if (state.cancelled) return;
        post({ push: "run-event", event });
      },
    };

    // Deliberately not awaited: the caller gets `runId` before the first byte leaves,
    // which is the only way it can correlate the events that follow.
    void (async () => {
      try {
        const catalogNow = await ensureCatalog();
        const selection: RunSelectionArgs = {
          dir: root,
          selector: selectorFor(catalogNow, args.nodeId),
          env: args.environment,
          url: undefined,
          tls: undefined,
          tlsCerts: {},
          certBaseDir: root,
          timeoutMs: args.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
          runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
          scriptTimeoutMs: DEFAULT_SCRIPT_TIMEOUT_MS,
          iterationCount: args.iterationCount,
          iterationData: args.iterationData,
          delayRequestMs: args.delayRequestMs ?? NO_DELAY_MS,
          vars: {},
          save: true,
          preferDescriptor: false,
          bail: args.bail ?? false,
          workingDir: root,
          insecureFileRead: false,
          safeEval: false,
          sink,
          bodies,
        };
        const result = await runSelection(selection);
        if (!state.cancelled) {
          post({ push: "run-done", runId, warnings: result.warnings, cancelled: false });
        }
      } catch (cause) {
        if (!state.cancelled) {
          post({ push: "run-done", runId, warnings: [], cancelled: false, error: toEngineError(cause) });
        }
      } finally {
        runs.delete(runId);
      }
    })();

    return runId;
  }

  /**
   * Core has no cancellation and Phase 2 deliberately did not add one: an in-flight
   * request completes, its writeback still happens, and what stops is the reporting.
   * Saying so here is the honest version of a Cancel button.
   */
  function cancelRun(runId: string): null {
    const state = runs.get(runId);
    if (state === undefined || state.cancelled) return null;
    state.cancelled = true;
    post({ push: "run-done", runId, warnings: [], cancelled: true });
    return null;
  }

  async function dispatch(request: EngineRequest): Promise<EngineResult> {
    // A disposed host has closed its watcher, so its catalog can no longer be trusted to match
    // the disk. Refusing is honest; serving the last known state is how a GUI shows a lie.
    if (disposed) throw usage(`the engine for ${root} is closed`);
    switch (request.kind) {
      case "catalog":
        return ensureCatalog();
      case "read-node":
        return readNode(request.nodeId);
      case "write-node":
        return writeNode(request.nodeId, request);
      case "write-text":
        return writeText(request.nodeId, request.text);
      case "mutate":
        return mutate(request.op);
      case "run":
        return { runId: startRun(request.args) };
      case "cancel":
        return cancelRun(request.runId);
      case "body-head":
        return bodies.head(request.handle);
      case "body-window":
        return bodies.window(request.handle, request.offset, request.length ?? BODY_WINDOW_BYTES);
      case "body-search":
        return bodies.search(request.handle, request.query, request.limit ?? BODY_SEARCH_LIMIT);
      case "body-format":
        return bodies.format(request.handle);
      case "body-release":
        bodies.release(request.handle);
        return null;
    }
  }

  return {
    async handle(request: EngineRequest): Promise<EngineResponse> {
      try {
        return { id: request.id, ok: true, data: await dispatch(request) };
      } catch (cause) {
        return { id: request.id, ok: false, error: toEngineError(cause) };
      }
    },
    dispose(): void {
      disposed = true;
      watcher?.close();
      watcher = undefined;
      for (const state of runs.values()) state.cancelled = true;
      runs.clear();
    },
  };
}
