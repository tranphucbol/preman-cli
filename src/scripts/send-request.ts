import { CliError } from "../errors.js";
import { applyAuth } from "../http/auth.js";
import type { CookieJar } from "../http/cookies.js";
import { normalizeKeyValues, setHeaderIfAbsent, type KeyValue } from "../http/headers.js";
import { invokeHttp, type HttpInvokeResult } from "../http/invoke.js";
import { resolveHttpUrl } from "../http/target.js";
import type { TlsCertOptions } from "../tls/certs.js";
import { interpolateStrict } from "../vars/interpolate.js";
import type { VariableStore } from "../vars/store.js";
import type { HttpRequest, KeyValueSource } from "../workspace/schemas.js";

const DEFAULT_METHOD = "GET";
const CONTENT_TYPE = "content-type";

/**
 * Postman's `body.mode` values that imply a content type. `raw` deliberately
 * does not: Postman itself makes the author set the header for raw bodies.
 */
const MODE_CONTENT_TYPES: Record<string, string> = {
  json: "application/json",
  urlencoded: "application/x-www-form-urlencoded",
};

export interface SendScriptRequestOptions {
  /** Whatever the script passed to `pm.sendRequest`. */
  input: unknown;
  store: VariableStore;
  /** Shared with the main request, so a login in a script authenticates it. */
  jar: CookieJar;
  timeoutMs: number;
  /** Shared with the main request, so a script's call trusts the same CAs. */
  tlsCerts: TlsCertOptions;
}

interface RequestShape {
  url?: unknown;
  method?: unknown;
  /** Postman's own name is `header`; `headers` is accepted too. */
  header?: unknown;
  headers?: unknown;
  body?: unknown;
  auth?: unknown;
}

function badInput(detail: string): CliError {
  return new CliError("pm.sendRequest could not read the request", {
    details: [detail, 'pass a url string, or { url, method, header, body: { mode, raw } }'],
  });
}

function asShape(input: unknown): RequestShape {
  if (typeof input === "string") return { url: input };
  if (typeof input === "object" && input !== null) return input as RequestShape;
  throw badInput(`expected a string or an object, got ${typeof input}`);
}

function readUrl(shape: RequestShape): string {
  if (typeof shape.url === "string") return shape.url;
  // Postman also accepts a parsed url object; only its `raw` form is portable.
  if (typeof shape.url === "object" && shape.url !== null) {
    const raw = (shape.url as { raw?: unknown }).raw;
    if (typeof raw === "string") return raw;
  }
  throw badInput("the request has no url");
}

function readHeaders(shape: RequestShape): KeyValue[] {
  const source = shape.header ?? shape.headers;
  if (source === undefined) return [];
  return normalizeKeyValues(source as KeyValueSource, "pm.sendRequest headers");
}

interface ReadBody {
  content: string | undefined;
  mode: string | undefined;
}

function readBody(shape: RequestShape): ReadBody {
  const { body } = shape;
  if (body === undefined || body === null) return { content: undefined, mode: undefined };
  if (typeof body === "string") return { content: body, mode: undefined };
  if (typeof body !== "object") throw badInput(`body must be a string or an object, got ${typeof body}`);

  const { mode, raw } = body as { mode?: unknown; raw?: unknown };
  return {
    content: typeof raw === "string" ? raw : undefined,
    mode: typeof mode === "string" ? mode : undefined,
  };
}

/**
 * Run one `pm.sendRequest` call. It reuses the same invoke path, cookie jar and
 * timeout as a real request, so a token fetched here behaves like one fetched by
 * a request file.
 */
export async function sendScriptRequest(options: SendScriptRequestOptions): Promise<HttpInvokeResult> {
  const shape = asShape(options.input);
  const { store } = options;

  const rawMethod = shape.method === undefined ? DEFAULT_METHOD : String(shape.method);
  const method = rawMethod.trim().toUpperCase();

  const { url } = resolveHttpUrl({ rawUrl: interpolateStrict(readUrl(shape), store, "pm.sendRequest url") });

  const headers = readHeaders(shape).map((header) => ({
    key: header.key,
    value: interpolateStrict(header.value, store, `pm.sendRequest header "${header.key}"`),
  }));

  // Auth warnings are dropped: a side request has no report line to carry them,
  // and a hard failure (unknown auth type) still throws.
  applyAuth({ auth: shape.auth as HttpRequest["auth"], headers, url, store });

  const { content, mode } = readBody(shape);
  const body = content === undefined || content === "" ? undefined : interpolateStrict(content, store, "pm.sendRequest body");

  const contentType = mode === undefined ? undefined : MODE_CONTENT_TYPES[mode];
  if (body !== undefined && contentType !== undefined) setHeaderIfAbsent(headers, CONTENT_TYPE, contentType);

  return invokeHttp({
    url,
    method,
    headers,
    body,
    timeoutMs: options.timeoutMs,
    jar: options.jar,
    tlsCerts: options.tlsCerts,
  });
}
