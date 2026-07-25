import { createContext, runInContext } from "node:vm";
import { CliError } from "../errors.js";
import type { Scope, VariableStore } from "../vars/store.js";
import { expect, makeHeaderList, makeMessageList, type ResponseLike } from "./expect.js";

export interface ConsoleLine {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
}

export interface ScriptContextInfo {
  /** Request display name, surfaced as `pm.info.requestName`. */
  requestName: string;
  eventName: string;
}

export interface ScriptRequestInfo {
  url: string;
  methodPath: string;
  body: string;
}

/** Everything a post-response script can see about the call that just finished. */
export interface ScriptResponseInfo {
  /** Numeric gRPC status code. */
  code: number;
  /** Status name, e.g. `OK` or `INVALID_ARGUMENT`. */
  codeName: string;
  message: string;
  durationMs: number;
  /** Decoded response message, or `undefined` when the call failed. */
  response: unknown;
  metadata: Record<string, string | string[]>;
  trailers: Record<string, string | string[]>;
}

export interface TestResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  /** Assertion message for `failed`, otherwise `undefined`. */
  error: string | undefined;
}

export interface ScriptRunResult {
  logs: ConsoleLine[];
  tests: TestResult[];
}

export interface RunScriptOptions {
  code: string;
  store: VariableStore;
  info: ScriptContextInfo;
  request: ScriptRequestInfo;
  /** Present for `onMessage` / `afterResponse` scripts; absent for pre-request ones. */
  response?: ScriptResponseInfo;
  /** Wall-clock budget for the script. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** `pm.variables.set` has no file to persist to, so it stays in the local scope. */
const VARIABLES_WRITE_SCOPE: Scope = "local";

const ASYNC_TEST_MESSAGE =
  "async tests are not supported: pm.test callbacks must be synchronous (no done callback, no async function)";

function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isThenable(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && typeof (value as Promise<unknown>).then === "function";
}

function byteLength(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
}

/** A Postman-ish variable-scope facade backed by one {@link VariableStore} layer. */
function makeScopeApi(store: VariableStore, scope: Scope) {
  return {
    get: (key: string) => store.getIn(scope, key),
    set: (key: string, value: unknown) => store.set(scope, key, value),
    unset: (key: string) => store.unset(scope, key),
    has: (key: string) => store.getIn(scope, key) !== undefined,
    toObject: () => store.snapshot(scope),
    clear: () => {
      for (const key of Object.keys(store.snapshot(scope))) store.unset(scope, key);
    },
  };
}

/**
 * Builds the `pm.response` a post-response script sees. A unary call produces
 * exactly one message, which is also exposed as `pm.message` so `onMessage`
 * scripts written for streaming APIs keep working.
 */
function makeResponse(info: ScriptResponseInfo): ResponseLike {
  const messages = makeMessageList(info.response === undefined ? [] : [{ data: info.response, timestamp: new Date() }]);
  const metadata = makeHeaderList(info.metadata);

  const response = {
    code: info.code,
    status: info.codeName,
    message: info.message,
    responseTime: info.durationMs,
    responseSize: byteLength(info.response),
    metadata,
    /** gRPC has no headers; Postman scripts reach for it anyway, so alias metadata. */
    headers: metadata,
    trailers: makeHeaderList(info.trailers),
    messages,
  };

  // Non-enumerable so `console.log(pm.response)` does not recurse into chai.
  Object.defineProperty(response, "to", { get: () => expect(response).to, enumerable: false });
  return response as ResponseLike;
}

/**
 * Execute a request script (`beforeInvoke` / `onMessage` / `afterResponse`) against
 * a minimal `pm` shim, mutating `store` in place and collecting `pm.test` results.
 *
 * `node:vm` is isolation-by-convention, not a security boundary — that is fine
 * here because the scripts come from the user's own repository. The timeout
 * exists to catch accidental infinite loops, not hostile code.
 */
export function runScript(options: RunScriptOptions): ScriptRunResult {
  const { code, store, info, request } = options;
  const logs: ConsoleLine[] = [];
  const tests: TestResult[] = [];

  const record = (level: ConsoleLine["level"]) => (...args: unknown[]) => {
    logs.push({ level, text: args.map(formatArg).join(" ") });
  };

  const environment = makeScopeApi(store, "environment");
  const globals = makeScopeApi(store, "globals");
  const collectionVariables = makeScopeApi(store, "collection");

  /**
   * A failing assertion fails only its own test — the rest of the script keeps
   * running, exactly like Postman.
   */
  const test = (name: unknown, fn?: () => unknown): void => {
    const label = String(name);
    if (typeof fn !== "function") {
      tests.push({ name: label, status: "skipped", error: undefined });
      return;
    }
    // `done => ...` and `async () => ...` would both report a false pass, because
    // nothing here waits for them. Fail loudly instead.
    if (fn.length > 0) {
      tests.push({ name: label, status: "failed", error: ASYNC_TEST_MESSAGE });
      return;
    }
    try {
      const result = fn();
      if (isThenable(result)) {
        result.then(
          () => undefined,
          () => undefined,
        );
        tests.push({ name: label, status: "failed", error: ASYNC_TEST_MESSAGE });
        return;
      }
      tests.push({ name: label, status: "passed", error: undefined });
    } catch (cause) {
      tests.push({ name: label, status: "failed", error: messageOf(cause) });
    }
  };

  const skip = (name: unknown): void => {
    tests.push({ name: String(name), status: "skipped", error: undefined });
  };

  const pm = {
    environment,
    globals,
    collectionVariables,
    /** Reads span every scope by precedence; writes land in the local scope. */
    variables: {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(VARIABLES_WRITE_SCOPE, key, value),
      has: (key: string) => store.has(key),
      toObject: () => ({
        ...store.snapshot("globals"),
        ...store.snapshot("collection"),
        ...store.snapshot("environment"),
        ...store.snapshot("local"),
      }),
    },
    info: { requestName: info.requestName, eventName: info.eventName, iteration: 0, iterationCount: 1 },
    request: { url: request.url, methodPath: request.methodPath, body: { raw: request.body } },
    expect,
    test: Object.assign(test, { skip, todo: skip }),
    ...(options.response === undefined ? {} : responseFacade(options.response)),
  };

  const sandbox = {
    pm,
    postman: { setEnvironmentVariable: environment.set, getEnvironmentVariable: environment.get, setGlobalVariable: globals.set },
    console: {
      log: record("log"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
      debug: record("debug"),
    },
    // Explicitly provided so scripts can rely on them; everything else is absent.
    Date,
    Math,
    JSON,
    String,
    Number,
    Boolean,
    Array,
    Object,
    parseInt,
    parseFloat,
    isNaN,
    Error,
  };

  try {
    runInContext(code, createContext(sandbox), {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      filename: `${info.requestName}:${info.eventName}`,
    });
  } catch (cause) {
    throw new CliError(`script "${info.eventName}" failed: ${messageOf(cause)}`, {
      details: [
        ...logs.map((l) => `${l.level}: ${l.text}`),
        ...tests.map((t) => `test ${t.status}: ${t.name}${t.error === undefined ? "" : ` — ${t.error}`}`),
      ],
    });
  }

  return { logs, tests };
}

/** `pm.response` plus the `pm.message` alias for the first (only) unary message. */
function responseFacade(info: ScriptResponseInfo): { response: ResponseLike; message: unknown } {
  const response = makeResponse(info);
  return { response, message: response.messages.idx(0) };
}
