import { PremanError, EXIT, type ExitCode } from "./errors.js";
import { rowFor, type DataRow } from "./data/rows.js";
import { applyGrpcAuth } from "./grpc/auth.js";
import { invokeUnary, type InvokeResult } from "./grpc/invoke.js";
import { parseMessageBody } from "./grpc/message.js";
import { resolveMethod, type SchemaSource } from "./grpc/schema.js";
import { resolveTarget, type GrpcTarget } from "./grpc/target.js";
import { CookieJar } from "./http/cookies.js";
import { normalizeProperties } from "./http/headers.js";
import { invokeHttp, NO_RESPONSE_STATUS, type HttpInvokeResult } from "./http/invoke.js";
import { buildLiveHttpRequest, finaliseHttpRequest } from "./http/request.js";
import type { HttpTarget } from "./http/target.js";
import {
  hasScriptOf,
  MESSAGE_SCRIPT_TYPES,
  POST_SCRIPT_TYPES,
  PRE_SCRIPT_TYPES,
  resolveScriptChain,
  type OwnedScript,
  type Protocol,
} from "./scripts/chain.js";
import {
  countTests,
  runScript,
  type ConsoleLine,
  type ScriptObserver,
  type ScriptResponseInfo,
  type SideRequestRecord,
  type TestSummary,
  type TestResult,
} from "./scripts/sandbox.js";
import {
  freezeRequest,
  LiveBody,
  LiveGrpcRequest,
  type LiveHttpRequest,
  Url,
  type LiveRequest,
} from "./scripts/live-request.js";
import type { Property } from "./scripts/property-list.js";
import type { TlsCertOptions } from "./tls/certs.js";
import { VariableStore } from "./vars/store.js";
import { resolveList, resolveListAgain, Template } from "./vars/template.js";
import type { GrpcRequest, HttpRequest } from "./workspace/schemas.js";
import { GRPC_KIND, HTTP_KIND, RUNNABLE_KINDS, parseRequestFile } from "./workspace/request-file.js";
import { saveEnvironmentValues, type EnvironmentEntry } from "./workspace/environments.js";
import type { RequestEntry } from "./workspace/collections.js";
import type { Workspace } from "./workspace/discover.js";
import type { FileReader } from "./workspace/files.js";
import { resolveAuth } from "./workspace/inherit.js";
import { nodeIdFor } from "./workspace/paths.js";
import type { Resources } from "./workspace/resources.js";
import type { BodyStore } from "./api/bodies.js";
import {
  flattenHeaders,
  type FailureStage,
  type HeaderPairs,
  type RunEventSink,
  type SentRequest,
} from "./api/events.js";

export { GRPC_KIND, HTTP_KIND };

/** Business-status field name, per `ReturnCode` in asset-exchange-v2-common.proto. */
const RETURN_CODE_FIELDS = ["return_code", "returnCode"] as const;
const RETURN_CODE_OK = "OK";

/** How a gRPC response is rendered for the body store, which deals in bytes. */
const GRPC_CONTENT_TYPE = "application/json";
const GRPC_BODY_INDENT = 2;
const BODY_ENCODING = "utf8";
const CONTENT_TYPE_HEADER = "content-type";
/** HTTP has no trailing metadata; named so the empty array reads as a statement. */
const NO_TRAILERS: HeaderPairs = [];
const TLS_SCHEME = "grpcs";
const PLAIN_SCHEME = "grpc";
/** Stands in for a request body that is not text, so no viewer tries to show it. */
const BINARY_BODY = "<binary>";
/**
 * The url and the method path are read before the second resolution can rescue them - one has to
 * name a host, the other a method in a schema - so they still fail on the first.
 */
const STRICT_FIRST_PASS = { strict: true } as const;

export type { Protocol };
export { countTests, type TestSummary };

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
  /** Expose `eval` to scripts so they can rehydrate a shared library. */
  safeEval?: boolean;
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
  /**
   * Report progress as it happens. Omitted by the CLI, which waits for the batch
   * outcome; when it is omitted not one event is constructed.
   */
  sink?: RunEventSink;
  /**
   * Where the response body is deposited so a `response-body` event can name it
   * instead of carrying it. Required for that event and for nothing else: with no
   * store there is nowhere to hand a 50MB body to, so none is announced.
   */
  bodies?: BodyStore;
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
    if (typeof value === "string" || typeof value === "number") return String(value);
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

/** Sums per-request tallies across a group. */
export function aggregateTests(items: GroupRunItem[]): TestSummary {
  return items.reduce<TestSummary>(
    (total, item) => {
      const tests = countTests(item.outcome?.tests ?? []);
      total.total += tests.total;
      total.passed += tests.passed;
      total.failed += tests.failed;
      total.skipped += tests.skipped;
      return total;
    },
    { total: 0, passed: 0, failed: 0, skipped: 0 },
  );
}

/** What a live run list shows as the destination of a gRPC call. */
function grpcTargetLabel(target: GrpcTarget, methodPath: string): string {
  return `${target.tls ? TLS_SCHEME : PLAIN_SCHEME}://${target.authority}/${methodPath}`;
}

/** Reads the response's declared media type, which decides how the viewer renders it. */
function contentTypeOf(headers: Record<string, string | string[]>): string | null {
  const raw = headers[CONTENT_TYPE_HEADER];
  if (raw === undefined) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
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

/**
 * The run events of one request, with `runId` and `nodeId` already stamped.
 *
 * Exists so that no emission site in this file has to know either id, and so the
 * whole feature costs one `undefined` check when nobody is listening.
 */
interface BodySource {
  bytes: Buffer;
  contentType: string | null;
}

interface RequestEvents {
  start: (name: string, iteration: number) => void;
  sent: (target: string, sent: SentRequest) => void;
  head: (status: number | string, headers: HeaderPairs, timings: Record<string, number>) => void;
  /**
   * Lazy on purpose. Encoding a 50MB response into a `Buffer` for a CLI run that
   * will never look at it is exactly the cost this whole seam exists to avoid.
   */
  body: (produce: () => BodySource) => void;
  /**
   * Emitted instead of `body` when there is nothing to inspect: a non-`OK` gRPC
   * status, an HTTP request that never got a response, or a request preman could
   * not build in the first place. A 4xx or 5xx has a body and gets one, because
   * that body is the server's own account of the error and this app does not talk
   * over it.
   */
  failure: (stage: FailureStage, message: string, details: string[], trailers: HeaderPairs) => void;
  end: (exitCode: ExitCode, returnCode?: string) => void;
  /** Handed to the sandbox so logs, tests and side requests stream out one at a time. */
  observer: ScriptObserver | undefined;
}

const NO_REQUEST_EVENTS: RequestEvents = {
  start: () => undefined,
  sent: () => undefined,
  head: () => undefined,
  body: () => undefined,
  failure: () => undefined,
  end: () => undefined,
  observer: undefined,
};

function requestEvents(options: Pick<RunOptions, "sink" | "bodies" | "workspace" | "entry">): RequestEvents {
  const sink = options.sink;
  if (sink === undefined) return NO_REQUEST_EVENTS;

  const runId = sink.runId;
  const nodeId = nodeIdFor(options.workspace.root, options.entry.filePath);
  const bodies = options.bodies;

  return {
    start: (name, iteration) => sink.emit({ type: "request-start", runId, nodeId, name, iteration }),
    sent: (target, sent) => sink.emit({ type: "request-sent", runId, nodeId, target, sent }),
    head: (status, headers, timings) => sink.emit({ type: "response-head", runId, nodeId, status, headers, timings }),
    body: (produce) => {
      if (bodies === undefined) return;
      const { bytes, contentType } = produce();
      sink.emit({ type: "response-body", runId, nodeId, ...bodies.publish(bytes, contentType) });
    },
    failure: (stage, message, details, trailers) =>
      sink.emit({ type: "response-failure", runId, nodeId, stage, message, details, trailers }),
    end: (exitCode, returnCode) =>
      sink.emit({
        type: "request-end",
        runId,
        nodeId,
        exitCode,
        ...(returnCode === undefined ? {} : { returnCode }),
      }),
    observer: {
      onLog: (line) => sink.emit({ type: "console", runId, nodeId, line }),
      onTest: (result) => sink.emit({ type: "test", runId, nodeId, result }),
      onSideRequest: (summary) => sink.emit({ type: "side-request", runId, nodeId, summary }),
    },
  };
}

/**
 * What `run` does with a throw from a request's own script.
 *
 * Before the call there is nothing to report but the failure, so it propagates and the request
 * ends without an outcome. After it the response is already in hand, and discarding it would
 * hide the very body the script was inspecting and skip the writeback that follows - so the
 * throw is recorded as a failed test and the request still reports. Decision 041.
 *
 * An inherited script propagates either way: a broken shared precondition is not this request's
 * result to report, and decision 6 stops the whole group on it.
 */
const PROPAGATE_THROW = "propagate";
const RECORD_THROW = "record";
type ScriptThrowPolicy = typeof PROPAGATE_THROW | typeof RECORD_THROW;

/**
 * `runScript` wraps a throw as `script "<phase>" failed: <message>`, which is what the CLI's
 * one-line error path prints. The recorded test already names the phase, so the prefix is
 * dropped rather than printed twice; an unrecognised shape is kept whole.
 */
function scriptFailureDetail(rawType: string, message: string): string {
  const prefix = `script "${rawType}" failed: `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

interface ScriptSink {
  consoleLines: ConsoleLine[];
  tests: TestResult[];
  sideRequests: SideRequestRecord[];
  run: (types: Set<string>, response?: ScriptResponseInfo, onThrow?: ScriptThrowPolicy) => Promise<void>;
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
  /** Expose `eval` to scripts so they can rehydrate a shared library. */
  safeEval?: boolean;
  iteration?: number;
  iterationCount?: number;
  /** `pm.sendRequest` dials over the same trust store as the request itself. */
  tlsCerts: TlsCertOptions;
  /**
   * Read once per script so the same live object is shared across the chain and
   * then exposed read-only to post-response scripts.
   */
  request: () => LiveRequest;
  /** Streams each log line, test result and side request as the script produces it. */
  observer?: ScriptObserver;
}

/** Runs the scripts of one request, in file order, collecting logs and test results. */
function scriptSink(options: ScriptSinkOptions): ScriptSink {
  const consoleLines: ConsoleLine[] = [];
  const tests: TestResult[] = [];
  const sideRequests: SideRequestRecord[] = [];

  /**
   * Collected as the script emits them rather than from the value `runScript` returns: a script
   * that throws never returns one, and the lines and assertions it managed first are exactly
   * what explains the failure. Wrapping the caller's observer keeps the one announcement point
   * the sandbox already guarantees.
   */
  const collect: Required<ScriptObserver> = {
    onLog: (line) => {
      consoleLines.push(line);
      options.observer?.onLog?.(line);
    },
    onTest: (result) => {
      tests.push(result);
      options.observer?.onTest?.(result);
    },
    onSideRequest: (record) => {
      sideRequests.push(record);
      options.observer?.onSideRequest?.(record);
    },
  };

  const run = async (
    types: Set<string>,
    response?: ScriptResponseInfo,
    onThrow: ScriptThrowPolicy = PROPAGATE_THROW,
  ): Promise<void> => {
    for (const script of options.scripts) {
      if (!types.has(script.event)) continue;
      try {
        await runScript({
          code: script.code,
          store: options.store,
          cookies: options.cookies,
          // `rawType`, not `event`: `pm.info.eventName` must read what the file says.
          info: { requestName: options.requestName, eventName: script.rawType },
          origin: script.origin,
          request: options.request(),
          timeoutMs: options.scriptTimeoutMs,
          requestTimeoutMs: options.requestTimeoutMs,
          safeEval: options.safeEval,
          iteration: options.iteration,
          iterationCount: options.iterationCount,
          tlsCerts: options.tlsCerts,
          observer: collect,
          ...(response === undefined ? {} : { response }),
        });
      } catch (cause) {
        if (onThrow === PROPAGATE_THROW || (cause instanceof PremanError && cause.abortsGroup)) throw cause;
        collect.onTest({
          name: `script "${script.rawType}"`,
          status: "failed",
          error: scriptFailureDetail(script.rawType, toErrorInfo(cause).message),
          origin: script.origin,
        });
        // The scripts of one phase build on each other - a library rehydrated by the first is
        // read by the second - so the rest would only report cascades of this same failure.
        return;
      }
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
  const events = requestEvents(options);
  // Announced before the file is even parsed, so a request that cannot be read still
  // appears in a live run list rather than silently never starting.
  events.start(options.entry.name, options.iteration ?? FIRST_ITERATION);

  try {
    const parsed = parseRequestFile(options.entry);
    const store = options.store ?? newStore(options);
    const cookies = options.cookies ?? new CookieJar();

    const outcome =
      parsed.protocol === "grpc"
        ? await runGrpcRequest(options, parsed.request, store, cookies, events)
        : await runHttpRequest(options, parsed.request, store, cookies, events);

    events.end(outcome.exitCode, outcome.protocol === "grpc" ? outcome.returnCode : undefined);
    return outcome;
  } catch (cause) {
    // The throw still propagates and the CLI prints this on the way out. A window has
    // no such exit path: without the failure event it would show an exit code and no
    // reason, which is the same dead end as a transport failure with no message.
    const info = toErrorInfo(cause);
    events.failure("build", info.message, info.details, NO_TRAILERS);
    events.end(EXIT.CLI);
    throw cause;
  }
}

async function runGrpcRequest(
  options: RunOptions,
  request: GrpcRequest,
  store: VariableStore,
  cookies: CookieJar,
  events: RequestEvents,
): Promise<GrpcRunOutcome> {
  const { entry, workspace, resources } = options;
  const chain = resolveScriptChain({
    ancestors: entry.ancestors,
    requestScripts: request.scripts,
    protocol: "grpc",
  });

  const methodPathTemplate = new Template(request.methodPath, store, "methodPath", STRICT_FIRST_PASS);
  // With --url the authored one is never read, so an unresolvable {{grpc_url}} must not block it.
  const override = options.urlOverride;
  const urlTemplate = override ? undefined : new Template(request.url, store, "url", STRICT_FIRST_PASS);
  const authoredUrl = urlTemplate?.resolved ?? override ?? "";
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
  // Flattened first, so a map-shaped `metadata:` reaches the wire the same as the array form.
  const authored = resolveList(normalizeProperties(request.metadata, "metadata"), store, (key) => `metadata.${key}`);
  const bodyTemplate = new Template(request.message?.content ?? "", store, "message body");
  const liveRequest = new LiveGrpcRequest({
    url: Url.parse(liveUrlText),
    methodPath: methodPathTemplate.resolved,
    metadata: authored.entries,
    body: new LiveBody(undefined, bodyTemplate.resolved),
  });
  // What the scripts are about to be handed, so anything else is theirs and stays theirs.
  const urlAsBuilt = liveRequest.url.toString();

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
    safeEval: options.safeEval,
    iteration: options.iteration,
    iterationCount: options.iterationCount,
    tlsCerts: options.tlsCerts,
    request: () => liveRequest,
    ...(events.observer === undefined ? {} : { observer: events.observer }),
  });

  // 1. Pre-request scripts edit the already-resolved request in place.
  await sink.run(PRE_SCRIPT_TYPES);

  // 1b. Resolve it again, now that they have had their say. A script sets a variable so the
  // request it precedes can use it; before this, the value only reached the wire on the next
  // run, through the environment writeback. Decision 039.
  liveRequest.methodPath = methodPathTemplate.send(liveRequest.methodPath, store);
  if (urlTemplate !== undefined && liveRequest.url.toString() === urlAsBuilt) {
    const resent = urlTemplate.resend(store);
    if (resent !== urlTemplate.resolved) liveRequest.url = Url.parse(resent);
  }
  resolveListAgain(liveRequest.metadata, authored.templates, store);
  liveRequest.body.raw = bodyTemplate.send(liveRequest.body.raw, store);

  const sentMetadata = liveRequest.metadata
    .enabled()
    .map((item) => ({ key: item.key.toLowerCase(), value: item.value }));
  const metadata = groupProperties(sentMetadata);

  const sentMessage = parseMessageBody(
    liveRequest.body.raw,
    "request body is not valid JSON after pre-request scripts",
  );

  // 2. Resolve schema and target from the possibly changed route.
  const method = resolveMethod({
    requestFilePath: entry.filePath,
    schemaLocation: request.schema?.location,
    methodDescriptor: request.methodDescriptor,
    methodPath: liveRequest.methodPath,
    includeDirsFor: resources.includeDirsFor,
    preferDescriptor: options.preferDescriptor,
  });

  const changedUrl = liveRequest.url.toString();
  const resolvedTarget = resolveTarget({
    url: changedUrl,
    workspaceRoot: workspace.root,
    tlsOverride: options.tlsOverride,
  });
  const target =
    changedUrl === Url.parse(liveUrlText).toString()
      ? { ...resolvedTarget, source: initialTarget.source }
      : resolvedTarget;

  // 3. Invoke.
  // The metadata rides along rather than surviving only in the batch outcome: a console that
  // showed an HTTP call's headers and a gRPC call's bare message would be honest about one
  // protocol and not the other.
  events.sent(grpcTargetLabel(target, liveRequest.methodPath), {
    protocol: "grpc",
    methodPath: liveRequest.methodPath,
    metadata: sentMetadata.map(({ key, value }): [string, string] => [key, value]),
    message: sentMessage,
  });
  const invoke = await invokeUnary({
    target,
    method: method.definition,
    message: sentMessage,
    metadata: sentMetadata,
    timeoutMs: options.timeoutMs,
    tlsCerts: options.tlsCerts,
  });
  freezeRequest(liveRequest);
  // Metadata only: trailers arrive after the message, and on a success the batch
  // outcome is the only thing that carries them.
  events.head(invoke.codeName, flattenHeaders(invoke.metadata), { durationMs: invoke.durationMs });
  if (invoke.ok) {
    // gRPC returns a decoded message, not bytes; the viewer wants the JSON it would
    // have printed anyway, so that is what gets stored.
    events.body(() => ({
      bytes: Buffer.from(JSON.stringify(invoke.response, null, GRPC_BODY_INDENT), BODY_ENCODING),
      contentType: GRPC_CONTENT_TYPE,
    }));
  } else {
    // A rejection is where servers attach structured detail, so unlike a success
    // this path does put the trailers on the wire.
    events.failure("transport", invoke.message, invoke.warnings, flattenHeaders(invoke.trailers));
  }

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
    await sink.run(MESSAGE_SCRIPT_TYPES, response, RECORD_THROW);
    await sink.run(POST_SCRIPT_TYPES, response, RECORD_THROW);
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
  events: RequestEvents,
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
    safeEval: options.safeEval,
    iteration: options.iteration,
    iterationCount: options.iterationCount,
    tlsCerts: options.tlsCerts,
    request: () => live.request,
    ...(events.observer === undefined ? {} : { observer: events.observer }),
  });

  // 1. Scripts edit the interpolated request and rendered auth directly.
  await sink.run(PRE_SCRIPT_TYPES);

  // 1b. The request's own templates resolve again, so a variable a script set is in what is
  // sent rather than in what the next run sends. Decision 039.
  live.resolveAgain();

  // 2. Finalisation does not interpolate again.
  const built = finaliseHttpRequest(live.request, live.target, live.wireBody);

  // 3. Send it. The jar is shared with the rest of the run.
  // `href`, not the `URL` itself: an event has to survive a structured clone.
  const sentUrl = built.url.href;
  events.sent(`${built.method} ${sentUrl}`, {
    protocol: "http",
    method: built.method,
    url: sentUrl,
    headers: built.headers.map(({ key, value }): [string, string] => [key, value]),
    body: typeof built.body === "string" ? built.body : built.body === undefined ? undefined : BINARY_BODY,
  });
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
  if (invoke.statusCode !== NO_RESPONSE_STATUS) {
    events.head(invoke.statusCode, flattenHeaders(invoke.headers), { durationMs: invoke.durationMs });
    events.body(() => ({
      bytes: Buffer.from(invoke.body, BODY_ENCODING),
      contentType: contentTypeOf(invoke.headers),
    }));
  } else {
    // No status, no headers, no body: the socket is all there is to report. A 4xx or
    // 5xx does not come through here, because it has a body and the body is the
    // server's own account of the error.
    events.failure("transport", invoke.message, invoke.warnings, NO_TRAILERS);
  }

  // 4. Post-response scripts see the same request object, now read-only.
  const warnings = [...chain.warnings, ...live.warnings, ...built.warnings, ...invoke.warnings];
  if (invoke.statusCode === NO_RESPONSE_STATUS) {
    if (hasScriptOf(chain.scripts, POST_SCRIPT_TYPES)) {
      warnings.push("afterResponse scripts skipped: no response was received");
    }
  } else {
    await sink.run(
      POST_SCRIPT_TYPES,
      {
        protocol: "http",
        code: invoke.statusCode,
        codeName: invoke.statusMessage,
        message: invoke.message,
        durationMs: invoke.durationMs,
        body: invoke.body,
        headers: invoke.headers,
      },
      RECORD_THROW,
    );
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

export interface GroupRunOptions extends Omit<
  RunOptions,
  "entry" | "store" | "cookies" | "data" | "iteration" | "iterationCount"
> {
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
  tests: TestSummary;
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
  if (cause instanceof PremanError) return { message: cause.message, details: cause.details };
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
    throw new PremanError(`"${options.groupPath}" contains no requests`);
  }

  const sink = options.sink;
  sink?.emit({ type: "run-start", runId: sink.runId, total: options.entries.length * options.iterationCount });

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
        // A skipped request never reaches `runRequest`, so its row is opened and
        // closed here. Without this the live list would be missing an entry the
        // batch report ends up containing.
        const skipped = requestEvents({ ...options, entry });
        skipped.start(entry.name, iteration);
        skipped.end(EXIT.OK);
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
        if (cause instanceof PremanError && cause.abortsGroup) {
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
  sink?.emit({ type: "run-end", runId: sink.runId, exitCode });

  return {
    groupPath: options.groupPath,
    items,
    bailed: bailReason !== undefined,
    bailReason,
    iterations,
    savedVars,
    savedTo,
    durationMs: performance.now() - started,
    tests: aggregateTests(items),
    exitCode,
  };
}
