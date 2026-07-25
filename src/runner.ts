import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { CliError, EXIT, type ExitCode } from "./errors.js";
import { invokeUnary, type InvokeResult } from "./grpc/invoke.js";
import { resolveMethod, type SchemaSource } from "./grpc/schema.js";
import { resolveTarget, type GrpcTarget } from "./grpc/target.js";
import { runScript, type ConsoleLine, type ScriptResponseInfo, type TestResult } from "./scripts/sandbox.js";
import { interpolateStrict } from "./vars/interpolate.js";
import { VariableStore } from "./vars/store.js";
import { grpcRequestSchema, otherRequestSchema } from "./workspace/schemas.js";
import { saveEnvironmentValues, type EnvironmentEntry } from "./workspace/environments.js";
import type { RequestEntry } from "./workspace/collections.js";
import type { Workspace } from "./workspace/discover.js";
import type { Resources } from "./workspace/resources.js";

/** Script types executed before the call. `prerequest` is the HTTP-side alias. */
const PRE_SCRIPT_TYPES = new Set(["beforeinvoke", "prerequest", "pre-request"]);

/** Fires once per received message; a unary call has exactly one. */
const MESSAGE_SCRIPT_TYPES = new Set(["onmessage"]);

/** Script types executed after the call, where `pm.test` assertions normally live. */
const POST_SCRIPT_TYPES = new Set(["afterresponse", "test", "postresponse", "post-response"]);

/** The only `$kind` this version can invoke. */
export const GRPC_KIND = "grpc-request";

/** Business-status field name, per `ReturnCode` in asset-exchange-v2-common.proto. */
const RETURN_CODE_FIELDS = ["return_code", "returnCode"] as const;
const RETURN_CODE_OK = "OK";

export interface RunOptions {
  workspace: Workspace;
  resources: Resources;
  entry: RequestEntry;
  environment: EnvironmentEntry | undefined;
  globals: Record<string, string>;
  /** `--var key=value` overrides, highest precedence. */
  localVars: Record<string, string>;
  urlOverride: string | undefined;
  tlsOverride: boolean | undefined;
  timeoutMs: number;
  preferDescriptor: boolean;
  /** Persist script-mutated environment variables back to the YAML file. */
  save: boolean;
  /**
   * Reuse an existing store instead of building one. A collection run passes the
   * same store to every request so a value one script computes is visible to the
   * next, matching Postman's collection runner.
   */
  store?: VariableStore;
}

export interface RunOutcome {
  entry: RequestEntry;
  methodPath: string;
  target: GrpcTarget;
  schemaSource: SchemaSource;
  warnings: string[];
  consoleLines: ConsoleLine[];
  /** `pm.test` results from the post-response scripts. */
  tests: TestResult[];
  /** The payload actually sent, after interpolation. */
  sentMessage: unknown;
  metadata: Record<string, string>;
  invoke: InvokeResult;
  /** `return_code` from the response, when the message has one. */
  returnCode: string | undefined;
  savedVars: Record<string, string>;
  savedTo: string | undefined;
  exitCode: ExitCode;
}

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

function newStore(options: Pick<RunOptions, "globals" | "environment" | "localVars">): VariableStore {
  return new VariableStore({
    globals: options.globals,
    environment: options.environment?.values ?? {},
    local: options.localVars,
  });
}

function parseGrpcRequest(entry: RequestEntry) {
  const raw = parseYaml(readFileSync(entry.filePath, "utf8")) ?? {};

  const kind = (raw as { $kind?: unknown }).$kind;
  if (kind !== "grpc-request") {
    const other = otherRequestSchema.safeParse(raw);
    const shown = other.success ? other.data.$kind : String(kind);
    throw new CliError(`"${entry.name}" is a ${shown}, which preman does not support yet`, {
      details: ["only $kind: grpc-request is implemented in this version"],
    });
  }

  const parsed = grpcRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliError(`unexpected shape in ${entry.filePath}`, {
      details: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
    });
  }
  return parsed.data;
}

/**
 * Execute one request end to end.
 *
 * Order matters: scripts run *before* interpolation so a value they compute
 * (e.g. `trans_id`) is visible to the body, and the environment writeback happens
 * only after a successful invocation attempt.
 */
export async function runRequest(options: RunOptions): Promise<RunOutcome> {
  const { entry, workspace, resources } = options;
  const request = parseGrpcRequest(entry);

  const store = options.store ?? newStore(options);

  const rawBody = request.message?.content ?? "";

  const consoleLines: ConsoleLine[] = [];
  const tests: TestResult[] = [];

  /** Runs every script of the given types, in file order, collecting logs and tests. */
  const runScripts = (types: Set<string>, response?: ScriptResponseInfo): void => {
    for (const script of request.scripts ?? []) {
      if (!types.has(script.type.toLowerCase())) continue;
      if (!script.code || script.code.trim().length === 0) continue;
      const result = runScript({
        code: script.code,
        store,
        info: { requestName: request.name, eventName: script.type },
        request: { url: request.url, methodPath: request.methodPath, body: rawBody },
        ...(response === undefined ? {} : { response }),
      });
      consoleLines.push(...result.logs);
      tests.push(...result.tests);
    }
  };

  // 1. Pre-request scripts, which may define variables used by the body.
  runScripts(PRE_SCRIPT_TYPES);

  // 2. Interpolate everything that goes over the wire.
  const methodPath = interpolateStrict(request.methodPath, store, "methodPath");
  // `--url` replaces the request's url outright, so an unresolvable `{{grpc_url}}`
  // must not block a run that already says where to go.
  const url = options.urlOverride ? "" : interpolateStrict(request.url, store, "url");
  const metadata: Record<string, string> = {};
  for (const item of request.metadata ?? []) {
    metadata[item.key] = interpolateStrict(item.value ?? "", store, `metadata.${item.key}`);
  }

  let sentMessage: unknown = {};
  if (rawBody.trim().length > 0) {
    const body = interpolateStrict(rawBody, store, "message body");
    try {
      sentMessage = JSON.parse(body);
    } catch (cause) {
      throw new CliError(`request body is not valid JSON after interpolation: ${(cause as Error).message}`);
    }
  }

  // 3. Resolve schema and target.
  const method = resolveMethod({
    requestFilePath: entry.filePath,
    schemaLocation: request.schema?.location,
    methodDescriptor: request.methodDescriptor,
    methodPath,
    includeDirs: resources.includeDirs,
    preferDescriptor: options.preferDescriptor,
  });

  const target = resolveTarget({
    url,
    workspaceRoot: workspace.root,
    override: options.urlOverride,
    tlsOverride: options.tlsOverride,
  });

  // 4. Invoke.
  const invoke = await invokeUnary({
    target,
    method: method.definition,
    message: sentMessage,
    metadata,
    timeoutMs: options.timeoutMs,
  });

  // 5. Post-response scripts, where the `pm.test` assertions live.
  const warnings = [...method.warnings];
  if (invoke.ok) {
    const response: ScriptResponseInfo = {
      code: invoke.code,
      codeName: invoke.codeName,
      message: invoke.message,
      durationMs: invoke.durationMs,
      response: invoke.response,
      metadata: invoke.metadata,
      trailers: invoke.trailers,
    };
    runScripts(MESSAGE_SCRIPT_TYPES, response);
    runScripts(POST_SCRIPT_TYPES, response);
  } else if ((request.scripts ?? []).some((s) => POST_SCRIPT_TYPES.has(s.type.toLowerCase()))) {
    // Postman would run the script anyway and let it blow up on an absent message.
    // Reporting the transport failure is more useful than turning it into a
    // TypeError, so the scripts are skipped and the skip is surfaced.
    warnings.push("afterResponse scripts skipped: the call failed at the transport level");
  }

  // 6. Persist variables the scripts changed, post-response ones included.
  let savedVars: Record<string, string> = {};
  let savedTo: string | undefined;
  if (options.save && options.environment && store.hasChanges("environment")) {
    savedVars = store.changes("environment");
    saveEnvironmentValues(options.environment.filePath, savedVars);
    savedTo = options.environment.filePath;
  }

  const returnCode = extractReturnCode(invoke.response);
  const exitCode: ExitCode = !invoke.ok
    ? EXIT.TRANSPORT
    : returnCode !== undefined && !isBusinessSuccess(returnCode)
      ? EXIT.BUSINESS
      : countTests(tests).failed > 0
        ? EXIT.TEST
        : EXIT.OK;

  return {
    entry,
    methodPath,
    target,
    schemaSource: method.source,
    warnings,
    consoleLines,
    tests,
    sentMessage,
    metadata,
    invoke,
    returnCode,
    savedVars,
    savedTo,
    exitCode,
  };
}

/**
 * `skipped` is a request preman cannot invoke at all (a non-gRPC `$kind`);
 * `error` is one that should have run but failed before reaching the wire.
 */
export type ItemStatus = "ok" | "business" | "transport" | "test" | "error" | "skipped";

export interface GroupRunItem {
  entry: RequestEntry;
  status: ItemStatus;
  /** Present when the request reached the wire. */
  outcome: RunOutcome | undefined;
  /** Present for `error` and `skipped`. */
  error: { message: string; details: string[] } | undefined;
}

export interface GroupRunOptions extends Omit<RunOptions, "entry" | "store"> {
  /** Requests to run, in order. */
  entries: RequestEntry[];
  /** Collection or folder path, for reporting. */
  groupPath: string;
  /** Stop after the first request that does not fully succeed. */
  bail: boolean;
}

export interface GroupRunOutcome {
  groupPath: string;
  items: GroupRunItem[];
  /** True when `bail` cut the run short. */
  bailed: boolean;
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

/**
 * Run every request in a collection or folder, in Postman `order`.
 *
 * All requests share one variable store, so a `trans_id` computed by the first
 * request's script is visible to the rest. The environment writeback is deferred
 * to the end so the YAML file is rewritten once, not once per request.
 */
export async function runGroup(options: GroupRunOptions): Promise<GroupRunOutcome> {
  if (options.entries.length === 0) {
    throw new CliError(`"${options.groupPath}" contains no requests`);
  }

  const store = newStore(options);
  const started = performance.now();
  const items: GroupRunItem[] = [];
  let bailed = false;

  for (const entry of options.entries) {
    if (entry.kind !== GRPC_KIND) {
      items.push({
        entry,
        status: "skipped",
        outcome: undefined,
        error: { message: `${entry.kind} is not supported yet`, details: [] },
      });
      continue;
    }

    try {
      const outcome = await runRequest({ ...options, entry, store, save: false });
      items.push({ entry, status: statusOf(outcome), outcome, error: undefined });
    } catch (cause) {
      items.push({ entry, status: "error", outcome: undefined, error: toErrorInfo(cause) });
    }

    const status = items[items.length - 1]!.status;
    if (options.bail && status !== "ok") {
      bailed = true;
      break;
    }
  }

  let savedVars: Record<string, string> = {};
  let savedTo: string | undefined;
  if (options.save && options.environment && store.hasChanges("environment")) {
    savedVars = store.changes("environment");
    saveEnvironmentValues(options.environment.filePath, savedVars);
    savedTo = options.environment.filePath;
  }

  return {
    groupPath: options.groupPath,
    items,
    bailed,
    savedVars,
    savedTo,
    durationMs: performance.now() - started,
    exitCode: aggregateExit(items),
  };
}
