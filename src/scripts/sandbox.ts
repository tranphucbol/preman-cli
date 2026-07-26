import CryptoJS from "crypto-js";
import { createContext, runInContext } from "node:vm";
import { CliError } from "../errors.js";
import { interpolate } from "../vars/interpolate.js";
import type { Scope, VariableStore } from "../vars/store.js";
import { CookieJar } from "../http/cookies.js";
import { NO_RESPONSE_STATUS } from "../http/invoke.js";
import { emptyTlsCerts, type TlsCertOptions } from "../tls/certs.js";
import type { ScriptOrigin } from "./chain.js";
import { expect, makeHeaderList, makeMessageList, type MessageList, type ResponseLike } from "./expect.js";
import type { LiveRequest } from "./live-request.js";
import { sendScriptRequest } from "./send-request.js";

export interface ConsoleLine {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  /** Which collection / folder / request declared the script that logged this. */
  origin: ScriptOrigin;
}

export interface ScriptContextInfo {
  /** Request display name, surfaced as `pm.info.requestName`. */
  requestName: string;
  eventName: string;
}

/** What a gRPC post-response script can see about the call that just finished. */
export interface GrpcScriptResponse {
  protocol: "grpc";
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

/** The HTTP equivalent: a status code, a reason phrase, headers and a raw body. */
export interface HttpScriptResponse {
  protocol: "http";
  /** HTTP status code. */
  code: number;
  /** Reason phrase, e.g. `OK` or `Not Found`. */
  codeName: string;
  message: string;
  durationMs: number;
  /** Raw response body; `pm.response.json()` parses it on demand. */
  body: string;
  headers: Record<string, string | string[]>;
}

export type ScriptResponseInfo = GrpcScriptResponse | HttpScriptResponse;

export interface TestResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  /** Assertion message for `failed`, otherwise `undefined`. */
  error: string | undefined;
  /** Which collection / folder / request declared the script that ran this test. */
  origin: ScriptOrigin;
}

/** One `pm.sendRequest` call, kept so the report can show what a script did. */
export interface SideRequestRecord {
  method: string;
  url: string;
  statusCode: number;
  statusMessage: string;
  message: string;
  ok: boolean;
  durationMs: number;
}

export interface ScriptRunResult {
  logs: ConsoleLine[];
  tests: TestResult[];
  sideRequests: SideRequestRecord[];
}

export interface RunScriptOptions {
  code: string;
  store: VariableStore;
  info: ScriptContextInfo;
  /** Where the script was declared; stamped onto every log line and test result. */
  origin: ScriptOrigin;
  request: LiveRequest;
  /** Present for `onMessage` / `afterResponse` scripts; absent for pre-request ones. */
  response?: ScriptResponseInfo;
  /** The run's cookie jar, exposed as `pm.cookies`. Empty when omitted. */
  cookies?: CookieJar;
  /** Wall-clock budget for the script. */
  timeoutMs?: number;
  /** Per-call budget for `pm.sendRequest`; falls back to the script budget. */
  requestTimeoutMs?: number;
  /** Certificate material for `pm.sendRequest`; Node's defaults when omitted. */
  tlsCerts?: TlsCertOptions;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** `pm.variables.set` has no file to persist to, so it stays in the local scope. */
const VARIABLES_WRITE_SCOPE: Scope = "local";

const ASYNC_TEST_MESSAGE =
  "async tests are not supported: pm.test callbacks must be synchronous (no done callback, no async function)";

/**
 * User code is wrapped in an async IIFE so scripts may `await` (which
 * `pm.sendRequest` needs). The wrapper opens on its own line, so every reported
 * line number is one too high without this offset.
 */
const ASYNC_WRAPPER_LINE_OFFSET = -1;

/**
 * A script that loops over `pm.sendRequest` would otherwise hammer a real
 * service until the deadline; stop early and say so instead.
 */
const MAX_SIDE_REQUESTS = 10;

function wrapAsync(code: string): string {
  return `(async () => {\n${code}\n})()`;
}

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
function makeGrpcResponse(info: GrpcScriptResponse): ResponseLike & { messages: MessageList } {
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
  return response as ResponseLike & { messages: MessageList };
}

/**
 * The HTTP `pm.response`. The body stays a string until a script asks for it:
 * `json()` on a non-JSON error page should fail in the script, not in the runner.
 */
function makeHttpResponse(info: HttpScriptResponse): ResponseLike {
  const response = {
    code: info.code,
    status: info.codeName,
    message: info.message,
    responseTime: info.durationMs,
    responseSize: Buffer.byteLength(info.body),
    headers: makeHeaderList(info.headers),
    text: () => info.body,
    json: () => {
      try {
        return JSON.parse(info.body) as unknown;
      } catch (cause) {
        throw new Error(`response body is not valid JSON: ${messageOf(cause)}`);
      }
    },
  };

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
 *
 * Scripts run as async functions, so `vm`'s own `timeout` only bounds the
 * synchronous stretch up to the first `await`; the outer deadline below covers
 * the rest.
 */
export async function runScript(options: RunScriptOptions): Promise<ScriptRunResult> {
  const { code, store, info, request, origin } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cookies = options.cookies ?? new CookieJar();
  const logs: ConsoleLine[] = [];
  const tests: TestResult[] = [];

  const record = (level: ConsoleLine["level"]) => (...args: unknown[]) => {
    logs.push({ level, text: args.map(formatArg).join(" "), origin });
  };

  /**
   * Timers a script leaves pending would keep the CLI alive long after its
   * result was reported, so they are tracked and cancelled when the script ends.
   */
  const pending = new Set<NodeJS.Timeout>();
  const cancelPending = (): void => {
    for (const handle of pending) clearTimeout(handle);
    pending.clear();
  };

  const sideRequests: SideRequestRecord[] = [];

  /** The logs and tests gathered so far, as `CliError` details. */
  const gathered = (): string[] => [
    ...logs.map((l) => `${l.level}: ${l.text}`),
    ...tests.map((t) => `test ${t.status}: ${t.name}${t.error === undefined ? "" : ` — ${t.error}`}`),
  ];

  /**
   * Decision 6: a throw from an inherited script means a shared precondition is broken, so
   * the whole group stops and the message names the owner. A request's own throw keeps its
   * existing wording and its per-request `status: "error"`.
   */
  const inherited = origin.level !== "request";
  const scriptError = (message: string, details: string[] = gathered()): CliError =>
    new CliError(inherited ? `${origin.label} ${message}` : message, {
      details,
      abortsGroup: inherited,
    });
  const failure = (cause: unknown): CliError =>
    scriptError(`script "${info.eventName}" failed: ${messageOf(cause)}`);

  /**
   * Postman's `pm.sendRequest`, in both the callback and the awaited form. It
   * shares the run's cookie jar and variable store, so a login done here is
   * indistinguishable from one done by a request file.
   */
  const performSend = async (input: unknown, callback?: unknown): Promise<ResponseLike | undefined> => {
    if (sideRequests.length >= MAX_SIDE_REQUESTS) {
      throw scriptError(`pm.sendRequest was called more than ${MAX_SIDE_REQUESTS} times in one script`, [
        "move the loop out of the script, or split the work across requests",
      ]);
    }

    const result = await sendScriptRequest({
      input,
      store,
      jar: cookies,
      timeoutMs: options.requestTimeoutMs ?? timeoutMs,
      tlsCerts: options.tlsCerts ?? emptyTlsCerts(),
    });
    sideRequests.push({
      method: result.method,
      url: result.finalUrl,
      statusCode: result.statusCode,
      statusMessage: result.statusMessage,
      message: result.message,
      ok: result.ok,
      durationMs: result.durationMs,
    });

    const done = typeof callback === "function" ? (callback as (err: unknown, res?: ResponseLike) => void) : undefined;

    if (result.statusCode === NO_RESPONSE_STATUS) {
      const error = new Error(result.message);
      // The callback form is Postman's error channel; without one, reject.
      if (done === undefined) throw error;
      done(error, undefined);
      return undefined;
    }

    const response = makeHttpResponse({
      protocol: "http",
      code: result.statusCode,
      codeName: result.statusMessage,
      message: result.message,
      durationMs: result.durationMs,
      body: result.body,
      headers: result.headers,
    });
    if (done !== undefined) done(null, response);
    return response;
  };

  /**
   * Real Postman scripts call `pm.sendRequest` with a callback and never await it,
   * so the script body finishes while the call is still on the wire. Tracking every
   * call lets the run drain them before it moves on; otherwise a callback that sets
   * a variable lands after interpolation has already read it, and the request goes
   * out unauthenticated.
   */
  const inFlight = new Set<Promise<void>>();
  let unobservedFailure: unknown;

  const sendRequest = (input: unknown, callback?: unknown): Promise<ResponseLike | undefined> => {
    const task = performSend(input, callback);
    let observed = false;

    // Attached synchronously so an ignored rejection can never surface as an
    // unhandled rejection; the drain below reports it as a script failure instead.
    const tracked = task.then(
      () => undefined,
      (cause: unknown) => {
        // A script that awaits (or chains) the call owns the error itself, and its
        // own rejection already fails the script. Reporting it twice would be noise.
        if (!observed) unobservedFailure ??= cause;
      },
    );
    inFlight.add(tracked);
    void tracked.then(() => inFlight.delete(tracked));

    // A thenable rather than the raw promise: it records that the script looked at
    // the result, which is the only way to tell an owned error from a dropped one.
    return {
      then: (onFulfilled, onRejected) => {
        observed = true;
        return task.then(onFulfilled, onRejected);
      },
      catch: (onRejected) => {
        observed = true;
        return task.catch(onRejected);
      },
      finally: (onFinally) => {
        observed = true;
        return task.finally(onFinally);
      },
    } as Promise<ResponseLike | undefined>;
  };

  /** Waits for calls the script left running, then reports one it never looked at. */
  const drainSideRequests = async (): Promise<void> => {
    while (inFlight.size > 0) await Promise.all([...inFlight]);
    if (unobservedFailure !== undefined) throw unobservedFailure;
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
      tests.push({ name: label, status: "skipped", error: undefined, origin });
      return;
    }
    // `done => ...` and `async () => ...` would both report a false pass, because
    // nothing here waits for them. Fail loudly instead.
    if (fn.length > 0) {
      tests.push({ name: label, status: "failed", error: ASYNC_TEST_MESSAGE, origin });
      return;
    }
    try {
      const result = fn();
      if (isThenable(result)) {
        result.then(
          () => undefined,
          () => undefined,
        );
        tests.push({ name: label, status: "failed", error: ASYNC_TEST_MESSAGE, origin });
        return;
      }
      tests.push({ name: label, status: "passed", error: undefined, origin });
    } catch (cause) {
      tests.push({ name: label, status: "failed", error: messageOf(cause), origin });
    }
  };

  const skip = (name: unknown): void => {
    tests.push({ name: String(name), status: "skipped", error: undefined, origin });
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
      replaceIn: (text: string) => interpolate(String(text), store).text,
      toObject: () => ({
        ...store.snapshot("globals"),
        ...store.snapshot("collection"),
        ...store.snapshot("environment"),
        ...store.snapshot("local"),
      }),
    },
    info: { requestName: info.requestName, eventName: info.eventName, iteration: 0, iterationCount: 1 },
    request,
    /**
     * Always present, even for gRPC (where the jar stays empty), so a script
     * shared between protocols cannot trip over an undefined `pm.cookies`.
     */
    cookies: {
      get: (name: string) => cookies.get(name),
      has: (name: string) => cookies.has(name),
      toObject: () => cookies.toObject(),
    },
    sendRequest,
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
    // Bundled because Postman ships it: collections that sign or encrypt a payload
    // in a pre-request script reach for `CryptoJS` and have no other way to do it.
    CryptoJS,
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
    setTimeout: (fn: unknown, ms?: number, ...args: unknown[]): NodeJS.Timeout => {
      const handle = setTimeout(() => {
        pending.delete(handle);
        if (typeof fn !== "function") return;
        // A throw from here would reach no `await` and would take the process
        // down, so it is downgraded to a console line the report can show.
        try {
          (fn as (...rest: unknown[]) => unknown)(...args);
        } catch (cause) {
          logs.push({ level: "error", text: messageOf(cause), origin });
        }
      }, ms);
      pending.add(handle);
      return handle;
    },
    clearTimeout: (handle: NodeJS.Timeout): void => {
      pending.delete(handle);
      clearTimeout(handle);
    },
  };

  let completion: Promise<unknown>;
  try {
    completion = Promise.resolve(
      runInContext(wrapAsync(code), createContext(sandbox), {
        timeout: timeoutMs,
        lineOffset: ASYNC_WRAPPER_LINE_OFFSET,
        filename: `${info.requestName}:${info.eventName}`,
      }),
    );
  } catch (cause) {
    // A compile error never produced a promise, so there is nothing to await.
    cancelPending();
    throw failure(cause);
  }

  let deadlineHandle: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineHandle = setTimeout(() => {
      reject(scriptError(`script "${info.eventName}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([completion, deadline]);
    // The script body is done, but its fire-and-forget `pm.sendRequest` calls may
    // not be. Still raced against the deadline so a hung call cannot hang the run.
    await Promise.race([drainSideRequests(), deadline]);
  } catch (cause) {
    throw cause instanceof CliError ? cause : failure(cause);
  } finally {
    if (deadlineHandle !== undefined) clearTimeout(deadlineHandle);
    cancelPending();
  }

  return { logs, tests, sideRequests };
}

/**
 * `pm.response`, plus the `pm.message` alias for the first (only) unary message.
 * HTTP gets no `messages`/`message`: there is a single body, not a stream, and a
 * fake one-message list would invite scripts that only work here.
 */
function responseFacade(info: ScriptResponseInfo): { response: ResponseLike; message?: unknown } {
  if (info.protocol === "http") return { response: makeHttpResponse(info) };
  const response = makeGrpcResponse(info);
  return { response, message: response.messages.idx(0) };
}
