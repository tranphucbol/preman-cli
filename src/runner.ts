import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { ZodError } from "zod";
import { CliError, EXIT, type ExitCode } from "./errors.js";
import { rowFor, type DataRow } from "./data/rows.js";
import { applyGrpcAuth } from "./grpc/auth.js";
import { invokeUnary, type InvokeResult } from "./grpc/invoke.js";
import { resolveMethod, type SchemaSource } from "./grpc/schema.js";
import { resolveTarget, type GrpcTarget } from "./grpc/target.js";
import { CookieJar } from "./http/cookies.js";
import { invokeHttp, NO_RESPONSE_STATUS, type HttpInvokeResult } from "./http/invoke.js";
import { buildLiveHttpRequest, finaliseHttpRequest } from "./http/request.js";
import type { HttpTarget } from "./http/target.js";
import {
  hasScriptOf,
  KNOWN_SCRIPT_TYPES,
  MESSAGE_SCRIPT_TYPES,
  POST_SCRIPT_TYPES,
  PRE_SCRIPT_TYPES,
  resolveScriptChain,
  type OwnedScript,
  type Protocol,
} from "./scripts/chain.js";
import {
  runScript,
  type ConsoleLine,
  type ScriptResponseInfo,
  type SideRequestRecord,
  type TestResult,
} from "./scripts/sandbox.js";
import {
  freezeRequest,
  LiveBody,
  LiveGrpcRequest,
  LiveHttpRequest,
  Url,
  type LiveRequest,
} from "./scripts/live-request.js";
import type { Property } from "./scripts/property-list.js";
import type { TlsCertOptions } from "./tls/certs.js";
import { interpolateStrict } from "./vars/interpolate.js";
import { VariableStore } from "./vars/store.js";
import {
  grpcRequestSchema,
  httpRequestSchema,
  otherRequestSchema,
  type GrpcRequest,
  type HttpRequest,
  type RequestScript,
} from "./workspace/schemas.js";
import { saveEnvironmentValues, type EnvironmentEntry } from "./workspace/environments.js";
import type { RequestEntry } from "./workspace/collections.js";
import type { Workspace } from "./workspace/discover.js";
import type { FileReader } from "./workspace/files.js";
import { resolveAuth } from "./workspace/inherit.js";
import type { Resources } from "./workspace/resources.js";

export const GRPC_KIND = "grpc-request";
export const HTTP_KIND = "http-request";

/** The `$kind` values preman can invoke. Anything else is reported, never guessed at. */
const RUNNABLE_KINDS = new Set<string>([GRPC_KIND, HTTP_KIND]);

/** Business-status field name, per `ReturnCode` in asset-exchange-v2-common.proto. */
const RETURN_CODE_FIELDS = ["return_code", "returnCode"] as const;
const RETURN_CODE_OK = "OK";

export type { Protocol };

export interface RunOptions {
  workspace: Workspace;
  resources: Resources;
  entry: RequestEntry;
  environment: EnvironmentEntry | undefined;
  globals: Record<string, string>;
  /** `--var key=value` overrides, highest precedence. */
  localVars: Record<string, string>;
  /** The current iteration's read-only data row. */
  data?: DataRow;
  urlOverride: string | undefined;
  tlsOverride: boolean | undefined;
  /** Certificate material shared by both transports; resolved once per run. */
  tlsCerts: TlsCertOptions;
  files: FileReader;
  timeoutMs: number;
  /** Wall-clock budget for each pre-request or post-response script. */
  scriptTimeoutMs?: number;
  /** Zero-based collection iteration. Single-request runs use zero. */
  iteration?: number;
  /** Total requested iterations. Single-request runs use one. */
  iterationCount?: number;
  preferDescriptor: boolean;
  /** Persist script-mutated environment variables back to the YAML file. */
  save: boolean;
  /**
   * Reuse an existing store instead of building one. A collection run passes the
   * same store to every request so a value one script computes is visible to the
   * next, matching Postman's collection runner.
   */
  store?: VariableStore;
  /**
   * Reuse an existing cookie jar. A collection run passes the same jar to every
   * request so a login's `Set-Cookie` authenticates the requests that follow.
   */
  cookies?: CookieJar;
}

interface BaseRunOutcome {
  entry: RequestEntry;
  protocol: Protocol;
  warnings: string[];
  consoleLines: ConsoleLine[];
  /** `pm.test` results from the post-response scripts. */
  tests: TestResult[];
  /** Calls the scripts made through `pm.sendRequest`. */
  sideRequests: SideRequestRecord[];
  savedVars: Record<string, string>;
  savedTo: string | undefined;
  /** Where each resolved certificate option came from; shown under `--verbose`. */
  tlsSources: Record<string, string>;
  exitCode: ExitCode;
}

export interface GrpcRunOutcome extends BaseRunOutcome {
  protocol: "grpc";
  methodPath: string;
  target: GrpcTarget;
  schemaSource: SchemaSource;
  /** The payload actually sent, after interpolation. */
  sentMessage: unknown;
  metadata: Record<string, string | string[]>;
  invoke: InvokeResult;
  /** `return_code` from the response, when the message has one. */
  returnCode: string | undefined;
}

export interface HttpRunOutcome extends BaseRunOutcome {
  protocol: "http";
  target: HttpTarget;
  invoke: HttpInvokeResult;
}

/**
 * Discriminated on `protocol` rather than flattened: an HTTP run has no
 * `methodPath`, `schemaSource` or `return_code`, and faking them would let the
 * renderer print fields that never existed.
 */
export type RunOutcome = GrpcRunOutcome | HttpRunOutcome;

/** Reads the response's business status, if the message carries one. */
export function extractReturnCode(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const record = response as Record<string, unknown>;
  for (const field of RETURN_CODE_FIELDS) {
    const value = record[field];
    if (value !== undefined && value !== null) return String(value);
  }
  return undefined;
}

/**
 * A response is a business success only when it explicitly says `OK`.
 * An absent or `RETURN_CODE_UNSPECIFIED` value is treated as failure, since the
 * enum's zero value carries no meaning and `defaults: false` omits unset fields.
 */
export function isBusinessSuccess(returnCode: string | undefined): boolean {
  return returnCode === RETURN_CODE_OK || returnCode === "1";
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export function countTests(tests: TestResult[]): TestSummary {
  return {
    total: tests.length,
    passed: tests.filter((t) => t.status === "passed").length,
    failed: tests.filter((t) => t.status === "failed").length,
    skipped: tests.filter((t) => t.status === "skipped").length,
  };
}

function groupProperties(entries: readonly Property[]): Record<string, string | string[]> {
  const grouped: Record<string, string | string[]> = {};
  for (const { key, value } of entries) {
    const existing = grouped[key];
    if (existing === undefined) grouped[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else grouped[key] = [existing, value];
  }
  return grouped;
}

function replaceProperties(list: LiveHttpRequest["headers"], entries: Record<string, string | string[]>): void {
  for (const { key } of list.all()) list.remove(key);
  for (const [key, value] of Object.entries(entries)) {
    for (const item of Array.isArray(value) ? value : [value]) list.add(key, item);
  }
}

/** Make afterResponse observe the final redirect hop, including generated headers. */
function syncFinalHttpRequest(
  request: LiveHttpRequest,
  invoke: HttpInvokeResult,
  initialBody: string | Buffer | undefined,
): void {
  request.url = invoke.finalUrl;
  request.method = invoke.method;
  replaceProperties(request.headers, invoke.requestHeaders);
  if (Buffer.isBuffer(initialBody)) {
    if (invoke.requestBody === undefined) request.body = new LiveBody(undefined, "");
  } else if (invoke.requestBody !== initialBody) {
    request.body = new LiveBody(undefined, invoke.requestBody ?? "");
  }
}

function newStore(options: Pick<RunOptions, "globals" | "environment" | "localVars" | "data">): VariableStore {
  return new VariableStore({
    globals: options.globals,
    data: options.data ?? {},
    environment: options.environment?.values ?? {},
    local: options.localVars,
  });
}

function shapeError(entry: RequestEntry, error: ZodError): CliError {
  return new CliError(`unexpected shape in ${entry.filePath}`, {
    details: error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
  });
}

type ParsedRequest = { protocol: "grpc"; request: GrpcRequest } | { protocol: "http"; request: HttpRequest };

function parseRequest(entry: RequestEntry): ParsedRequest {
  const raw = parseYaml(readFileSync(entry.filePath, "utf8")) ?? {};
  const kind = (raw as { $kind?: unknown }).$kind;

  if (kind === GRPC_KIND) {
    const parsed = grpcRequestSchema.safeParse(raw);
    if (!parsed.success) throw shapeError(entry, parsed.error);
    return { protocol: "grpc", request: parsed.data };
  }

  if (kind === HTTP_KIND) {
    const parsed = httpRequestSchema.safeParse(raw);
    if (!parsed.success) throw shapeError(entry, parsed.error);
    return { protocol: "http", request: parsed.data };
  }

  const other = otherRequestSchema.safeParse(raw);
  const shown = other.success ? other.data.$kind : String(kind);
  throw new CliError(`"${entry.name}" is a ${shown}, which preman does not support yet`, {
    details: [`supported kinds: ${[...RUNNABLE_KINDS].join(", ")}`],
  });
}

interface ScriptSink {
  consoleLines: ConsoleLine[];
  tests: TestResult[];
  sideRequests: SideRequestRecord[];
  run: (types: Set<string>, response?: ScriptResponseInfo) => Promise<void>;
}

interface ScriptSinkOptions {
  scripts: OwnedScript[];
  requestName: string;
  store: VariableStore;
  cookies: CookieJar;
  /** Budget for each `pm.sendRequest`, matching the request's own timeout. */
  requestTimeoutMs: number;
  /** Independent wall-clock budget for each script. */
  scriptTimeoutMs?: number;
  iteration?: number;
  iterationCount?: number;
  /** `pm.sendRequest` dials over the same trust store as the request itself. */
  tlsCerts: TlsCertOptions;
  /**
   * Read once per script so the same live object is shared across the chain and
   * then exposed read-only to post-response scripts.
   */
  request: () => LiveRequest;
}

/** Runs the scripts of one request, in file order, collecting logs and test results. */
function scriptSink(options: ScriptSinkOptions): ScriptSink {
  const consoleLines: ConsoleLine[] = [];
  const tests: TestResult[] = [];
  const sideRequests: SideRequestRecord[] = [];

  const run = async (types: Set<string>, response?: ScriptResponseInfo): Promise<void> => {
    for (const script of options.scripts) {
      if (!types.has(script.event)) continue;
      const result = await runScript({
        code: script.code,
        store: options.store,
        cookies: options.cookies,
        // `rawType`, not `event`: `pm.info.eventName` must read what the file says.
        info: { requestName: options.requestName, eventName: script.rawType },
        origin: script.origin,
        request: options.request(),
        timeoutMs: options.scriptTimeoutMs,
        requestTimeoutMs: options.requestTimeoutMs,
        iteration: options.iteration,
        iterationCount: options.iterationCount,
        tlsCerts: options.tlsCerts,
        ...(response === undefined ? {} : { response }),
      });
      consoleLines.push(...result.logs);
      tests.push(...result.tests);
      sideRequests.push(...result.sideRequests);
    }
  };

  return { consoleLines, tests, sideRequests, run };
}

interface Persisted {
  savedVars: Record<string, string>;
  savedTo: string | undefined;
}

/** Writes back the environment variables the scripts changed, post-response ones included. */
function persist(options: Pick<RunOptions, "save" | "environment">, store: VariableStore): Persisted {
  const environment = options.environment;
  if (!options.save || environment === undefined || !store.hasChanges("environment")) {
    return { savedVars: {}, savedTo: undefined };
  }
  const savedVars = store.changes("environment");
  saveEnvironmentValues(environment.filePath, savedVars);
  return { savedVars, savedTo: environment.filePath };
}

/**
 * Execute one request end to end.
 *
 * Request templates and auth are resolved before scripts, matching Postman's live
 * `pm.request`; scripts that introduce a token can resolve it with replaceIn().
 */
export async function runRequest(options: RunOptions): Promise<RunOutcome> {
  const parsed = parseRequest(options.entry);
  const store = options.store ?? newStore(options);
  const cookies = options.cookies ?? new CookieJar();

  return parsed.protocol === "grpc"
    ? runGrpcRequest(options, parsed.request, store, cookies)
    : runHttpRequest(options, parsed.request, store, cookies);
}

async function runGrpcRequest(
  options: RunOptions,
  request: GrpcRequest,
  store: VariableStore,
  cookies: CookieJar,
): Promise<GrpcRunOutcome> {
  const { entry, workspace, resources } = options;
  const chain = resolveScriptChain({
    ancestors: entry.ancestors,
    requestScripts: request.scripts,
    protocol: "grpc",
  });

  const methodPath = interpolateStrict(request.methodPath, store, "methodPath");
  const authoredUrl = options.urlOverride ? options.urlOverride : interpolateStrict(request.url, store, "url");
  const initialTarget = resolveTarget({
    url: authoredUrl,
    workspaceRoot: workspace.root,
    override: options.urlOverride,
    tlsOverride: options.tlsOverride,
  });
  const liveUrlText =
    authoredUrl.trim().length > 0
      ? authoredUrl
      : `${initialTarget.tls ? "grpcs" : "grpc"}://${initialTarget.authority}`;
  const metadataEntries = (request.metadata ?? []).map((item) => ({
    key: item.key,
    value:
      item.disabled === true ? (item.value ?? "") : interpolateStrict(item.value ?? "", store, `metadata.${item.key}`),
    ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
  }));
  const rawBody = request.message?.content ?? "";
  const body = rawBody.length === 0 ? "" : interpolateStrict(rawBody, store, "message body");
  const liveRequest = new LiveGrpcRequest({
    url: Url.parse(liveUrlText),
    methodPath,
    metadata: metadataEntries,
    body: new LiveBody(undefined, body),
  });

  const auth = resolveAuth(entry, request.auth);
  const authWarnings = applyGrpcAuth({ auth: auth?.auth, metadata: liveRequest.metadata, store });
  if (auth !== undefined && auth.origin.level !== "request") {
    authWarnings.unshift(`auth inherited from ${auth.origin.label}`);
  }

  const sink = scriptSink({
    scripts: chain.scripts,
    requestName: request.name,
    store,
    cookies,
    requestTimeoutMs: options.timeoutMs,
    scriptTimeoutMs: options.scriptTimeoutMs,
    iteration: options.iteration,
    iterationCount: options.iterationCount,
    tlsCerts: options.tlsCerts,
    request: () => liveRequest,
  });

  // 1. Pre-request scripts edit the already-resolved request in place.
  await sink.run(PRE_SCRIPT_TYPES);

  const sentMetadata = liveRequest.metadata
    .enabled()
    .map((item) => ({ key: item.key.toLowerCase(), value: item.value }));
  const metadata = groupProperties(sentMetadata);

  let sentMessage: unknown = {};
  if (liveRequest.body.raw.trim().length > 0) {
    try {
      sentMessage = JSON.parse(liveRequest.body.raw);
    } catch (cause) {
      throw new CliError(`request body is not valid JSON after pre-request scripts: ${(cause as Error).message}`);
    }
  }

  // 2. Resolve schema and target from the possibly changed route.
  const method = resolveMethod({
    requestFilePath: entry.filePath,
    schemaLocation: request.schema?.location,
    methodDescriptor: request.methodDescriptor,
    methodPath: liveRequest.methodPath,
    includeDirs: resources.includeDirs,
    preferDescriptor: options.preferDescriptor,
  });

  const changedUrl = liveRequest.url.toString();
  const resolvedTarget = resolveTarget({
    url: changedUrl,
    workspaceRoot: workspace.root,
    tlsOverride: options.tlsOverride,
  });
  const target = changedUrl === Url.parse(liveUrlText).toString() ? { ...resolvedTarget, source: initialTarget.source } : resolvedTarget;

  // 3. Invoke.
  const invoke = await invokeUnary({
    target,
    method: method.definition,
    message: sentMessage,
    metadata: sentMetadata,
    timeoutMs: options.timeoutMs,
    tlsCerts: options.tlsCerts,
  });
  freezeRequest(liveRequest);

  // 4. Post-response scripts, where the `pm.test` assertions live.
  const warnings = [...chain.warnings, ...authWarnings, ...method.warnings, ...invoke.warnings];
  if (invoke.ok) {
    const response: ScriptResponseInfo = {
      protocol: "grpc",
      code: invoke.code,
      codeName: invoke.codeName,
      message: invoke.message,
      durationMs: invoke.durationMs,
      response: invoke.response,
      metadata: invoke.metadata,
      trailers: invoke.trailers,
    };
    await sink.run(MESSAGE_SCRIPT_TYPES, response);
    await sink.run(POST_SCRIPT_TYPES, response);
  } else if (hasScriptOf(chain.scripts, POST_SCRIPT_TYPES)) {
    warnings.push("afterResponse scripts skipped: the call failed at the transport level");
  }

  // 5. Persist variables the scripts changed, post-response ones included.
  const { savedVars, savedTo } = persist(options, store);

  const returnCode = extractReturnCode(invoke.response);
  const exitCode: ExitCode = !invoke.ok
    ? EXIT.TRANSPORT
    : returnCode !== undefined && !isBusinessSuccess(returnCode)
      ? EXIT.BUSINESS
      : countTests(sink.tests).failed > 0
        ? EXIT.TEST
        : EXIT.OK;

  return {
    entry,
    protocol: "grpc",
    methodPath: liveRequest.methodPath,
    target,
    schemaSource: method.source,
    warnings,
    consoleLines: sink.consoleLines,
    tests: sink.tests,
    sideRequests: sink.sideRequests,
    sentMessage,
    metadata,
    invoke,
    returnCode,
    savedVars,
    savedTo,
    tlsSources: options.tlsCerts.sources,
    exitCode,
  };
}

async function runHttpRequest(
  options: RunOptions,
  request: HttpRequest,
  store: VariableStore,
  cookies: CookieJar,
): Promise<HttpRunOutcome> {
  const { entry } = options;

  const chain = resolveScriptChain({
    ancestors: entry.ancestors,
    requestScripts: request.scripts,
    protocol: "http",
  });

  const live = buildLiveHttpRequest({
    request,
    auth: resolveAuth(entry, request.auth),
    store,
    urlOverride: options.urlOverride,
    tlsOverride: options.tlsOverride,
    files: options.files,
  });

  const sink = scriptSink({
    scripts: chain.scripts,
    requestName: entry.name,
    store,
    cookies,
    requestTimeoutMs: options.timeoutMs,
    scriptTimeoutMs: options.scriptTimeoutMs,
    iteration: options.iteration,
    iterationCount: options.iterationCount,
    tlsCerts: options.tlsCerts,
    request: () => live.request,
  });

  // 1. Scripts edit the interpolated request and rendered auth directly.
  await sink.run(PRE_SCRIPT_TYPES);

  // 2. Finalisation does not interpolate again.
  const built = finaliseHttpRequest(live.request, live.target, live.wireBody);

  // 3. Send it. The jar is shared with the rest of the run.
  const invoke = await invokeHttp({
    url: built.url,
    method: built.method,
    headers: built.headers,
    body: built.body,
    timeoutMs: options.timeoutMs,
    jar: cookies,
    tlsCerts: options.tlsCerts,
  });
  syncFinalHttpRequest(live.request, invoke, built.body);
  freezeRequest(live.request);

  // 4. Post-response scripts see the same request object, now read-only.
  const warnings = [...chain.warnings, ...live.warnings, ...built.warnings, ...invoke.warnings];
  if (invoke.statusCode === NO_RESPONSE_STATUS) {
    if (hasScriptOf(chain.scripts, POST_SCRIPT_TYPES)) {
      warnings.push("afterResponse scripts skipped: no response was received");
    }
  } else {
    await sink.run(POST_SCRIPT_TYPES, {
      protocol: "http",
      code: invoke.statusCode,
      codeName: invoke.statusMessage,
      message: invoke.message,
      durationMs: invoke.durationMs,
      body: invoke.body,
      headers: invoke.headers,
    });
  }

  // 5. Persist variables the scripts changed, post-response ones included.
  const { savedVars, savedTo } = persist(options, store);

  const exitCode: ExitCode =
    invoke.statusCode === NO_RESPONSE_STATUS
      ? EXIT.TRANSPORT
      : !invoke.ok
        ? EXIT.BUSINESS
        : countTests(sink.tests).failed > 0
          ? EXIT.TEST
          : EXIT.OK;

  return {
    entry,
    protocol: "http",
    target: built.target,
    warnings,
    consoleLines: sink.consoleLines,
    tests: sink.tests,
    sideRequests: sink.sideRequests,
    invoke,
    savedVars,
    savedTo,
    tlsSources: options.tlsCerts.sources,
    exitCode,
  };
}

/**
 * `skipped` is a request preman cannot invoke at all (a `$kind` outside
 * `RUNNABLE_KINDS`); `error` is one that should have run but failed before
 * reaching the wire.
 */
export type ItemStatus = "ok" | "business" | "transport" | "test" | "error" | "skipped";

export interface GroupRunItem {
  entry: RequestEntry;
  /** Zero-based collection iteration that produced this item. */
  iteration: number;
  status: ItemStatus;
  /** Present when the request reached the wire. */
  outcome: RunOutcome | undefined;
  /** Present for `error` and `skipped`. */
  error: { message: string; details: string[] } | undefined;
}

export interface GroupRunOptions
  extends Omit<RunOptions, "entry" | "store" | "cookies" | "data" | "iteration" | "iterationCount"> {
  /** Requests to run, in order. */
  entries: RequestEntry[];
  /** Collection or folder path, for reporting. */
  groupPath: string;
  /** Stop after the first request that does not fully succeed. */
  bail: boolean;
  iterationCount: number;
  data: DataRow[];
  delayRequestMs: number;
  /** Whole-run budget. Zero means unbounded. */
  runTimeoutMs: number;
}

/**
 * Why a group run stopped before its last request. `bail-flag` is the user asking for it;
 * `inherited-script` means a shared precondition broke; `timeout` means the run budget
 * elapsed between requests.
 */
export type BailReason = "bail-flag" | "inherited-script" | "timeout";

export interface GroupRunOutcome {
  groupPath: string;
  items: GroupRunItem[];
  /** True when the run stopped short; `bailReason` says who stopped it. */
  bailed: boolean;
  bailReason: BailReason | undefined;
  /** Number of iterations entered before completion or an early stop. */
  iterations: number;
  savedVars: Record<string, string>;
  savedTo: string | undefined;
  durationMs: number;
  exitCode: ExitCode;
}

function statusOf(outcome: RunOutcome): ItemStatus {
  switch (outcome.exitCode) {
    case EXIT.TRANSPORT:
      return "transport";
    case EXIT.BUSINESS:
      return "business";
    case EXIT.TEST:
      return "test";
    default:
      return "ok";
  }
}

function toErrorInfo(cause: unknown): { message: string; details: string[] } {
  if (cause instanceof CliError) return { message: cause.message, details: cause.details };
  const error = cause as Error;
  // An unexpected failure is still reported per-request rather than aborting the
  // whole run, but keep the stack so it cannot be mistaken for a config problem.
  return { message: error?.message ?? String(cause), details: error?.stack ? [error.stack] : [] };
}

/**
 * The worst outcome in the group wins: error > transport > business > test. A hard
 * `error` outranks a transport failure because it means the run itself is
 * misconfigured, which is the more actionable signal; a failed assertion ranks last
 * because the call itself worked. `skipped` never fails the run on its own.
 */
function aggregateExit(items: GroupRunItem[]): ExitCode {
  if (items.some((i) => i.status === "error")) return EXIT.CLI;
  if (items.some((i) => i.status === "transport")) return EXIT.TRANSPORT;
  if (items.some((i) => i.status === "business")) return EXIT.BUSINESS;
  if (items.some((i) => i.status === "test")) return EXIT.TEST;
  return EXIT.OK;
}

const FIRST_ITERATION = 0;
const NO_RUN_BUDGET = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runBudgetExhausted(runTimeoutMs: number, started: number): boolean {
  return runTimeoutMs !== NO_RUN_BUDGET && performance.now() - started >= runTimeoutMs;
}

/** Replace the transient data layer without disturbing the shared mutable scopes. */
function replaceData(store: VariableStore, data: DataRow | undefined): void {
  for (const key of Object.keys(store.snapshot("data"))) store.unset("data", key);
  for (const [key, value] of Object.entries(data ?? {})) store.set("data", key, value);
}

/**
 * Run every request in a collection or folder, in Postman `order`.
 *
 * All requests share one variable store and one cookie jar, so a `trans_id`
 * computed by the first request's script and a session cookie its response set are
 * both visible to later requests and iterations. The environment writeback is deferred
 * to the end so the YAML file is rewritten once, not once per request.
 */
export async function runGroup(options: GroupRunOptions): Promise<GroupRunOutcome> {
  if (options.entries.length === 0) {
    throw new CliError(`"${options.groupPath}" contains no requests`);
  }

  const store = newStore({ ...options, data: {} });
  const cookies = new CookieJar();
  const started = performance.now();
  const items: GroupRunItem[] = [];
  let bailReason: BailReason | undefined;
  let iterations = 0;
  let attemptedRequest = false;
  let stop = false;

  for (let iteration = FIRST_ITERATION; iteration < options.iterationCount; iteration += 1) {
    iterations += 1;
    const data = rowFor(options.data, iteration);
    replaceData(store, data);

    for (const entry of options.entries) {
      if (runBudgetExhausted(options.runTimeoutMs, started)) {
        bailReason = "timeout";
        stop = true;
        break;
      }

      if (!RUNNABLE_KINDS.has(entry.kind)) {
        items.push({
          entry,
          iteration,
          status: "skipped",
          outcome: undefined,
          error: { message: `${entry.kind} is not supported yet`, details: [] },
        });
        continue;
      }

      if (attemptedRequest && options.delayRequestMs > 0) await delay(options.delayRequestMs);
      if (runBudgetExhausted(options.runTimeoutMs, started)) {
        bailReason = "timeout";
        stop = true;
        break;
      }
      attemptedRequest = true;

      try {
        const outcome = await runRequest({
          ...options,
          entry,
          store,
          cookies,
          save: false,
          data,
          iteration,
          iterationCount: options.iterationCount,
        });
        items.push({ entry, iteration, status: statusOf(outcome), outcome, error: undefined });
      } catch (cause) {
        items.push({ entry, iteration, status: "error", outcome: undefined, error: toErrorInfo(cause) });
        if (cause instanceof CliError && cause.abortsGroup) {
          // Checked before `options.bail` so the reason names the real culprit rather
          // than a flag the user may not even have passed.
          bailReason = "inherited-script";
          stop = true;
          break;
        }
      }

      const status = items[items.length - 1]!.status;
      if (options.bail && status !== "ok") {
        bailReason = "bail-flag";
        stop = true;
        break;
      }
    }
    if (stop) break;
  }

  const { savedVars, savedTo } = persist(options, store);
  const itemExitCode = aggregateExit(items);
  const exitCode = bailReason === "timeout" && itemExitCode !== EXIT.CLI ? EXIT.TRANSPORT : itemExitCode;

  return {
    groupPath: options.groupPath,
    items,
    bailed: bailReason !== undefined,
    bailReason,
    iterations,
    savedVars,
    savedTo,
    durationMs: performance.now() - started,
    exitCode,
  };
}
