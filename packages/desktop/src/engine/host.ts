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
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { BodyStore } from "@preman/core/api/bodies.js";
import { buildCatalog, refreshCatalog, type Catalog, type CatalogNode } from "@preman/core/api/catalog.js";
import type { RunEvent, RunEventSink } from "@preman/core/api/events.js";
import { readGitStatus, type GitStatus } from "@preman/core/api/git.js";
import { grepWorkspace, type GrepResult } from "@preman/core/api/grep.js";
import type { ProtoCache } from "@preman/core/api/protos.js";
import {
  createCollection,
  createEnvironmentFile,
  createFolder,
  createRequestFile,
  deleteNode,
  duplicateRequestFile,
  editDefinitionFile,
  editRequestFile,
  moveNode,
  renameNode,
  reorderSiblings,
  replaceFileText,
} from "@preman/core/api/mutate.js";
import { writeEnvironmentValue } from "@preman/core/api/environments.js";
import type { TextPreview } from "@preman/core/api/preview.js";
import type { RunSelectionArgs, RunSelectionResult } from "@preman/core/api/run.js";
import { readVariables, type VariableView } from "@preman/core/api/variables.js";
import { watchWorkspace, type WatchHandle } from "@preman/core/api/watch.js";
import { EXIT, PremanError } from "@preman/core/errors.js";
import { toJunitReport, type RunReport } from "@preman/core/report/junit.js";
import { toGroupJsonReport, toJsonReport } from "@preman/core/report/json.js";
import { canonicalSharedPath, sharedProtoRoot } from "@preman/core/workspace/links.js";
import { definitionPathFor, ENVIRONMENT_SUFFIX, nodeIdFor, REQUEST_SUFFIX } from "@preman/core/workspace/paths.js";
import { toEngineError } from "@preman/desktop/engine/errors.js";
import {
  BODY_WINDOW_BYTES,
  markPhase,
  PHASES,
  readPhases,
  type MethodChoice,
  type MethodChoices,
  type DocumentKind,
  type EngineMessage,
  type EngineRequest,
  type EngineResponse,
  type EngineResult,
  type LogLevel,
  type MutateOp,
  type MutateResult,
  type NodeDocument,
  type ReportFormat,
  type RunArgs,
  type RunReportText,
  type VariableWrite,
} from "@preman/desktop/engine/protocol.js";

/** Matching the CLI's defaults, so the app and `preman run` behave the same by default. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 5_000;
const DEFAULT_RUN_TIMEOUT_MS = 0;
const NO_DELAY_MS = 0;
const RUN_ID_PREFIX = "run-";
const FIRST_RUN = 1;
/** What a line in the log calls the two kinds of failure that used to reach only the renderer. */
const PROTO_WARNING_LABEL = "proto not loaded: ";
const RUN_WARNING_LABEL = "run warning: ";
const DISPATCH_FAILED_LABEL = "request failed: ";
const SELECTOR_SEPARATOR = "/";
const PARENT_SEGMENT = "..";
const ENCODING = "utf8";
const BODY_SEARCH_LIMIT = 500;
/**
 * How many finished runs stay exportable. A report is the whole outcome tree, so this is
 * a memory bound, not a policy: the runner only ever exports the run in front of you.
 */
const RETAINED_REPORTS = 20;
const REPORT_EXTENSION: Record<ReportFormat, string> = { json: "json", junit: "xml" };
/** Matching the CLI's json reporter, so the two write the same bytes. */
const JSON_INDENT = 2;
const NAME_SEPARATOR = "-";
/** Anything a file name should not carry, collapsed so the save dialog gets one token. */
const UNSAFE_NAME_CHARACTERS = /[^A-Za-z0-9._-]+/g;
/**
 * How long the tree's git decorations wait after a change before being re-read.
 *
 * A branch switch or a `git stash` rewrites dozens of files, and the watcher reports them
 * in bursts. Shelling out once per burst is the point; the delay is long enough to
 * coalesce one and short enough that a save feels like it decorated the row immediately.
 */
const GIT_STATUS_DEBOUNCE_MS = 400;
/** `schema.location` is posix in every workspace, whatever host wrote it. */
const LOCATION_SEPARATOR = "/";
/**
 * How long after the first catalog the deferred send path is warmed.
 *
 * Long enough that the renderer has painted the rows that same catalog just gave it. The
 * two processes share one disk, and the whole point of deferring was to stop a 16MB read
 * from sitting in front of the tree; prefetching it immediately would put it back there.
 */
const SEND_PATH_PREFETCH_MS = 250;

/*
 * The three modules below are imported where they are used, not at the top of this file.
 *
 * `api/run.js`, `api/preview.js` and `api/protos.js` reach `@faker-js/faker`, `@grpc/grpc-js`,
 * `@grpc/proto-loader`, `chai` and `csv-parse` — around 16MB across 640 files, none of which a
 * sidebar needs. Statically imported they are evaluated before `entry.ts` can mark
 * `engine.start`, so the renderer's very first `catalog` request waits behind all of them: on a
 * cold page cache that measured 4.3s, two thirds of the time from asking for the tree to seeing
 * a row. Everything the catalog does need — `yaml` and `zod` — stays static above.
 *
 * `EngineHost.handle` was already async, so this is a load order change and not an interface
 * one, and `@preman/core` stays synchronous. `schedulePrefetch` pays the cost back once the
 * tree is on screen, so the first Send is no slower than it was. Decision 029.
 */

export interface EngineHostOptions {
  /** The workspace root. Every node id in the protocol is relative to this. */
  root: string;
  /** A property, not a method, because the host destructures it and calls it unbound. */
  post: (message: EngineMessage) => void;
  /**
   * Where this host says what went wrong. A property for the same reason as {@link post}.
   *
   * Required, and not defaulted to a no-op: every failure below is caught and turned into a
   * response, so a host without a sink is a host whose errors exist only in a banner the user
   * dismissed. Making the caller name the sink is what stops that from being the quiet default.
   */
  log: (level: LogLevel, line: string) => void;
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

/** What ran, as one path, so an exported file is named after it rather than after the run id. */
function reportSubject(report: RunReport): string {
  return report.kind === "single" ? report.outcome.entry.path : report.outcome.groupPath;
}

function reportName(report: RunReport, runId: string, format: ReportFormat): string {
  const subject = reportSubject(report)
    .split(SELECTOR_SEPARATOR)
    .join(NAME_SEPARATOR)
    .replace(UNSAFE_NAME_CHARACTERS, NAME_SEPARATOR);
  return `${subject}${NAME_SEPARATOR}${runId}.${REPORT_EXTENSION[format]}`;
}

/**
 * Render a finished run. Both formats are core's, so the app cannot drift from what
 * `preman -r json` and `preman -r junit` write for the same run.
 */
function renderReport(report: RunReport, format: ReportFormat): string {
  if (format === "junit") return toJunitReport(report);
  const json = report.kind === "single" ? toJsonReport(report.outcome) : toGroupJsonReport(report.outcome);
  return JSON.stringify(json, null, JSON_INDENT);
}

export function createEngineHost(options: EngineHostOptions): EngineHost {
  const { root, post, log } = options;
  const bodies = new BodyStore();
  /** One per host, because the load is the expensive part and it only changes with a `.proto`. */
  let protos: ProtoCache | undefined;
  const runs = new Map<string, RunState>();
  /** Finished runs, oldest first, so a report can be exported after `run-done`. */
  const reports = new Map<string, RunReport>();
  let catalog: Catalog | undefined;
  let watcher: WatchHandle | undefined;
  let nextRun = FIRST_RUN;
  /** Refreshes are serialised: two overlapping `refreshCatalog` calls would race on `catalog`. */
  let reconciling: Promise<void> = Promise.resolve();
  let gitTimer: ReturnType<typeof setTimeout> | undefined;
  let prefetchTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  /**
   * The bytes this host last wrote to a path, so the watcher can tell our own write from
   * someone else's. Content, not a timer: a timer would swallow a genuine external write
   * that lands in the same window. Bounded to at most the writes since the last watcher
   * tick — every `reconcile` call clears it, whether or not a given path matched.
   */
  const written = new Map<string, string>();

  function publish(next: Catalog): Catalog {
    catalog = next;
    post({ push: "catalog", catalog: next });
    return next;
  }

  /** The proto index, built on the first question that needs one rather than at boot. */
  async function ensureProtos(): Promise<ProtoCache> {
    if (protos === undefined) {
      const protoApi = await import("@preman/core/api/protos.js");
      // Re-checked: two concurrent callers both awaited, and the second must not
      // replace a cache the first has already handed out.
      protos ??= new protoApi.ProtoCache(root);
    }
    return protos;
  }

  /**
   * Warm what the top of this file no longer imports, so the first Send pays nothing for
   * the deferral. Failures are swallowed on purpose: this is a cache, and a real import
   * error belongs to the request that actually needed the module, with its own id.
   */
  function schedulePrefetch(): void {
    if (prefetchTimer !== undefined) return;
    prefetchTimer = setTimeout(() => {
      prefetchTimer = undefined;
      if (disposed) return;
      void Promise.all([
        import("@preman/core/api/run.js"),
        import("@preman/core/api/preview.js"),
        import("@preman/core/api/protos.js"),
      ]).catch(() => undefined);
    }, SEND_PATH_PREFETCH_MS);
    // The engine is kept alive by its port, never by this. A host disposed inside the
    // window still clears it below; this is for the process that closes first.
    prefetchTimer.unref();
  }

  /** True when `path`'s bytes on disk still match what this host last wrote there. */
  function matchesOwnWrite(path: string): boolean {
    const expected = written.get(path);
    if (expected === undefined) return false;
    try {
      return readFileSync(path, ENCODING) === expected;
    } catch {
      return false;
    }
  }

  async function reconcile(paths: string[]): Promise<void> {
    if (disposed || catalog === undefined) return;
    const next = await refreshCatalog(catalog, paths);
    publish(next);
    // Only the `external-change` push is filtered: the catalog and the git overlay must
    // still follow our own writes (renaming a request moves its row, saving clears its `M`).
    const external = paths.filter((path) => !matchesOwnWrite(path));
    post({ push: "external-change", nodeIds: external.map((path) => nodeIdFor(root, path)) });
    written.clear();
    scheduleGitStatus();
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
    // The early return is deliberately unmarked: a cached catalog is not a build, and marking it
    // would put two enters against one exit the moment a workspace is switched back to.
    if (catalog !== undefined) return catalog;
    markPhase(PHASES.engineCatalogEnter);
    const built = await buildCatalog(root);
    markPhase(PHASES.engineCatalogExit);
    catalog = built;
    if (watcher === undefined && !disposed) startWatching();
    schedulePrefetch();
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
    const document = await readNode(nodeId);
    written.set(file, document.text);
    return document;
  }

  /** The raw YAML tab. The mutation seam owns the refusal, so an invalid document never lands. */
  async function writeText(nodeId: string, text: string): Promise<NodeDocument> {
    const path = resolveWithinRoot(root, nodeId);
    const kind = await documentKindFor(nodeId, path);
    const file = fileFor(path, kind);
    await replaceFileText(file, text);
    const document = await readNode(nodeId);
    written.set(file, document.text);
    return document;
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
      // Not `requireDirectory`'s opposite number: the target is a file, and the refusal for a
      // group belongs in core, where the message can say duplicating a folder is unsupported
      // rather than that the path is wrong.
      case "duplicate":
        return duplicateRequestFile({
          target: resolveWithinRoot(root, op.targetId),
          ...(op.order === undefined ? {} : { order: op.order }),
        });
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

  /**
   * Keep a finished run exportable, evicting the oldest once {@link RETAINED_REPORTS} are
   * held. A cancelled run is remembered too: cancellation stops the reporting, not the
   * requests that already completed, and the partial report is still worth having.
   */
  function remember(runId: string, result: RunSelectionResult): void {
    const report: RunReport | undefined =
      result.group !== undefined
        ? { kind: "group", outcome: result.group }
        : result.outcome !== undefined
          ? { kind: "single", outcome: result.outcome }
          : undefined;
    if (report === undefined) return;

    reports.set(runId, report);
    while (reports.size > RETAINED_REPORTS) {
      const oldest = reports.keys().next();
      if (oldest.done === true) break;
      reports.delete(oldest.value);
    }
  }

  function runReport(runId: string, format: ReportFormat): RunReportText {
    const report = reports.get(runId);
    if (report === undefined) {
      throw usage(`no report is held for ${runId}`, ["only the most recent runs can be exported"]);
    }
    return { format, text: renderReport(report, format), suggestedName: reportName(report, runId, format) };
  }

  /**
   * Write one value and hand back the re-read view. `writeEnvironmentValue` rewrites the
   * YAML in place, so comments and key order survive an edit made in the app.
   */
  function writeVariable(write: VariableWrite): VariableView {
    writeEnvironmentValue(root, write.environment, write.key, write.value);
    return readVariables(root, write.environment);
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
        // In parallel: the catalog is usually already in hand, and the run path is usually
        // already prefetched, so on the common path neither of these waits for anything.
        const [{ runSelection }, catalogNow] = await Promise.all([import("@preman/core/api/run.js"), ensureCatalog()]);
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
        remember(runId, result);
        for (const warning of result.warnings) log("warn", `${RUN_WARNING_LABEL}${warning}`);
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

  /**
   * How a chosen method should be written into `schema.location`.
   *
   * A proto reached through a shared link is named the canonical way, because that is what
   * the workspace declared it as and what it means on every machine. Writing the relative
   * path instead would count `../` segments off how deep this particular checkout sits, so
   * the same choice would produce a different file on a colleague's disk — the machine
   * dependence the shared root exists to remove, reintroduced one request at a time
   * (ADR 038). A proto inside the workspace keeps the relative path: it is already portable,
   * and the arithmetic can only honestly happen from the request's own directory.
   */
  function locationFor(spec: string, from: string): string {
    return canonicalSharedPath(spec, sharedProtoRoot()) ?? relative(from, spec).split(sep).join(LOCATION_SEPARATOR);
  }

  /**
   * Every method the declared protos offer, plus the `schema.location` a given request
   * would need to reach each one.
   */
  async function listMethods(nodeId: string | undefined): Promise<MethodChoices> {
    const index = (await ensureProtos()).index();
    const from = nodeId === undefined ? undefined : dirname(fileFor(resolveWithinRoot(root, nodeId), "request"));
    const methods: MethodChoice[] = index.methods.map((method) => ({
      methodPath: method.methodPath,
      serviceName: method.serviceName,
      methodName: method.methodName,
      spec: method.spec,
      specLabel: nodeIdFor(root, method.spec),
      requestType: method.requestType,
      responseType: method.responseType,
      streaming: method.streaming,
      ...(from === undefined ? {} : { schemaLocation: locationFor(method.spec, from) }),
    }));
    // The renderer shows these in a banner the user dismisses; the log is where they survive it.
    // A spec that will not parse is the same spec on every open, so this repeats — which is the
    // honest record of a picker that was opened five times and warned five times.
    for (const warning of index.warnings) log("warn", `${PROTO_WARNING_LABEL}${warning}`);
    return { methods, warnings: index.warnings };
  }

  /**
   * The tokens offered to a skeleton are every variable name in scope for that
   * environment, shadowed ones included: a shadowed key still interpolates, so a field
   * named after it should still be written as `{{token}}`.
   */
  async function messageSkeleton(methodPath: string, environment: string | null): Promise<string> {
    const tokens = new Set(readVariables(root, environment).bindings.map((binding) => binding.key));
    return (await ensureProtos()).skeleton(methodPath, tokens);
  }

  /**
   * The module type is inferred from the loader rather than written as `typeof import(...)`,
   * which the import-style rule forbids and which would name the specifier a second time.
   */
  async function specsApi() {
    return import("@preman/core/api/specs.js");
  }

  type SpecsApi = Awaited<ReturnType<typeof specsApi>>;

  /** Deferred like the rest of the send path: describing or planning specs is a setup action. */
  async function readSpecs<T>(work: (api: SpecsApi) => T): Promise<T> {
    return work(await specsApi());
  }

  /**
   * Declaring a proto or moving a link changes which files the index should read and where
   * they live, and `ProtoCache` keys its work by path and mtime — neither of which moved.
   * Dropping the cache is the honest response: a spec change is a setup action, so paying a
   * full reload once is cheaper than reasoning about which entries survived.
   */
  async function writeSpecs<T>(work: (api: SpecsApi) => T): Promise<T> {
    const result = await readSpecs(work);
    protos = undefined;
    return result;
  }

  /** Interpolation without sending, so `{{token}}` can be shown resolved as it is typed. */
  async function preview(environment: string | null, text: string): Promise<TextPreview> {
    const { previewText } = await import("@preman/core/api/preview.js");
    return previewText(root, environment, text);
  }

  async function grep(query: string, limit: number | undefined): Promise<GrepResult> {
    return grepWorkspace(await ensureCatalog(), query, { limit });
  }

  /**
   * Re-read after a burst of changes and pushed, because a rebase moves every row and
   * nothing in the renderer could know to ask. A failure here is already a `warning`
   * inside the status, so there is nothing to catch.
   */
  function scheduleGitStatus(): void {
    if (gitTimer !== undefined) clearTimeout(gitTimer);
    gitTimer = setTimeout(() => {
      gitTimer = undefined;
      void readGitStatus(root).then((status: GitStatus) => {
        if (!disposed) post({ push: "git-status", status });
      });
    }, GIT_STATUS_DEBOUNCE_MS);
  }

  async function dispatch(request: EngineRequest): Promise<EngineResult> {
    /*
     * The one request answered above the refusal below, and the only one that ever will be.
     *
     * A mark records when this process did something, which stays true after disposal — it is not
     * workspace state, so there is no stale answer to give. And a diagnostic readout is wanted
     * exactly when something has gone wrong, which includes a host that has been closed. Decision
     * 027 scopes this hole to `phases`; `test/desktop.protocol.test.ts` pins both halves.
     */
    if (request.kind === "phases") return readPhases();
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
      case "variables":
        return readVariables(root, request.environment);
      case "write-variable":
        return writeVariable(request.write);
      case "preview":
        return preview(request.environment, request.text);
      case "run-report":
        return runReport(request.runId, request.format);
      case "list-methods":
        return listMethods(request.nodeId);
      case "message-skeleton":
        return messageSkeleton(request.methodPath, request.environment);
      case "grep":
        return grep(request.query, request.limit);
      case "git-status":
        return readGitStatus(root);
      case "specs":
        return readSpecs((api) => api.describeSpecs(root));
      case "collect-protos":
        return readSpecs((api) => api.collectProtoFiles(request.dir));
      case "plan-specs":
        return readSpecs((api) => api.planSpecs(root, request.files, { overrides: request.overrides }));
      case "plan-conversion":
        return readSpecs((api) => api.planSpecConversion(root, { overrides: request.overrides }));
      case "apply-specs":
        return writeSpecs((api) => api.applySpecPlan(root, request.plan));
      case "remove-spec":
        return writeSpecs((api) => api.removeSpec(root, request.declared));
      case "link-checkout":
        return writeSpecs((api) => {
          api.linkCheckout(request.name, request.target, { repoint: request.repoint });
          return api.describeSpecs(root);
        });
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
        // The response tells the renderer; this tells the file. Without it every engine-side
        // failure in the app was a toast and nothing else, and a bug report could not be read
        // after the toast had gone. The kind and the cause, never the request's arguments: the
        // cause is the text the banner already shows, and a payload can hold a variable value.
        log(
          "error",
          `${DISPATCH_FAILED_LABEL}${request.kind}: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`,
        );
        return { id: request.id, ok: false, error: toEngineError(cause) };
      }
    },
    dispose(): void {
      disposed = true;
      watcher?.close();
      watcher = undefined;
      if (gitTimer !== undefined) clearTimeout(gitTimer);
      gitTimer = undefined;
      if (prefetchTimer !== undefined) clearTimeout(prefetchTimer);
      prefetchTimer = undefined;
      for (const state of runs.values()) state.cancelled = true;
      runs.clear();
      reports.clear();
    },
  };
}
