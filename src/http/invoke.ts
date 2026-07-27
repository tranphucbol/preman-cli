import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import { httpsRequestOptions, tlsFailureHints, type TlsCertOptions } from "../tls/certs.js";
import type { CookieJar } from "./cookies.js";
import { findHeader, toOutgoingHeaders, type KeyValue } from "./headers.js";

export interface HttpInvokeOptions {
  url: URL;
  method: string;
  /** Exact casing is preserved; a `Cookie` entry here wins over the jar. */
  headers: KeyValue[];
  body?: string | Buffer | undefined;
  /** Budget for the whole exchange, redirects included. */
  timeoutMs: number;
  jar?: CookieJar | undefined;
  maxRedirects?: number;
  /** Resolved certificate material; inert on an `http:` hop. */
  tlsCerts: TlsCertOptions;
}

export interface RedirectHop {
  status: number;
  from: string;
  to: string;
}

export interface HttpInvokeResult {
  /** True for 2xx only. */
  ok: boolean;
  /** {@link NO_RESPONSE_STATUS} when no response arrived at all. */
  statusCode: number;
  /** Reason phrase reported by the server, e.g. `Not Found`. */
  statusMessage: string;
  /** Transport error text; empty when a response arrived. */
  message: string;
  /** Method of the final hop, which a redirect may have rewritten. */
  method: string;
  url: string;
  finalUrl: string;
  /** Headers actually sent on the final hop. */
  requestHeaders: Record<string, string | string[]>;
  requestBody: string | undefined;
  body: string;
  headers: Record<string, string | string[]>;
  setCookies: string[];
  redirects: RedirectHop[];
  durationMs: number;
  warnings: string[];
}

interface RawResponse {
  status: number;
  statusMessage: string;
  headers: Record<string, string | string[]>;
  setCookies: string[];
  location: string | undefined;
  buffer: Buffer;
}

export const NO_RESPONSE_STATUS = 0;

const HTTPS_PROTOCOL = "https:";
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const METHOD_PRESERVING_STATUSES = new Set([307, 308]);
const SEE_OTHER = 303;
const SUCCESS_MIN = 200;
const SUCCESS_MAX = 299;
const GET = "GET";
const HEAD = "HEAD";
const CONTENT_LENGTH = "content-length";
const CONTENT_TYPE = "content-type";
const CONTENT_ENCODING = "content-encoding";
const COOKIE = "Cookie";
/** Not forwarded to another origin: they were scoped to the first one. */
const CROSS_ORIGIN_STRIPPED = new Set(["authorization", "cookie"]);
const DEFAULT_CHARSET: BufferEncoding = "utf8";
const IDENTITY_ENCODINGS = new Set(["", "identity"]);

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function firstValue(headers: Record<string, string | string[]>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Decompress per `content-encoding`, degrading to the raw bytes with a warning. */
function decode(buffer: Buffer, encoding: string | undefined, warnings: string[]): Buffer {
  const codec = (encoding ?? "").trim().toLowerCase();
  if (IDENTITY_ENCODINGS.has(codec)) return buffer;
  try {
    if (codec === "gzip" || codec === "x-gzip") return gunzipSync(buffer);
    if (codec === "br") return brotliDecompressSync(buffer);
    if (codec === "deflate") {
      // Some servers send raw deflate without the zlib wrapper.
      try {
        return inflateSync(buffer);
      } catch {
        return inflateRawSync(buffer);
      }
    }
  } catch (cause) {
    warnings.push(`could not decode the ${codec} response body: ${messageOf(cause)}`);
    return buffer;
  }
  warnings.push(`unknown content-encoding "${codec}"; body left as received`);
  return buffer;
}

function charsetOf(contentType: string | undefined): BufferEncoding {
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType ?? "");
  const raw = match?.[1]?.toLowerCase().replace("utf-8", "utf8");
  return raw !== undefined && Buffer.isEncoding(raw) ? raw : DEFAULT_CHARSET;
}

/** RFC 7231 §6.4: only 307/308 preserve the method, and 303 always drops the body. */
function rewriteForRedirect(status: number, method: string): { method: string; dropBody: boolean } {
  if (METHOD_PRESERVING_STATUSES.has(status)) return { method, dropBody: false };
  if (status === SEE_OTHER) return { method: method === HEAD ? HEAD : GET, dropBody: true };
  if (method === GET || method === HEAD) return { method, dropBody: false };
  return { method: GET, dropBody: true };
}

function send(
  url: URL,
  method: string,
  headers: Record<string, string | string[]>,
  body: string | Buffer | undefined,
  timeoutMs: number,
  tlsCerts: TlsCertOptions,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const secure = url.protocol === HTTPS_PROTOCOL;
    const driver = secure ? httpsRequest : httpRequest;
    // Applied per hop rather than once up front, so a redirect into https still gets
    // the certificate material even when the first hop was cleartext.
    const tlsOptions = secure ? httpsRequestOptions(tlsCerts) : {};
    let timer: NodeJS.Timeout | undefined;
    const finish = (settle: () => void): void => {
      if (timer !== undefined) clearTimeout(timer);
      settle();
    };

    const req = driver(url, { ...tlsOptions, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", (cause) => finish(() => reject(cause)));
      res.on("end", () => {
        finish(() =>
          resolve({
            status: res.statusCode ?? NO_RESPONSE_STATUS,
            statusMessage: res.statusMessage ?? "",
            headers: { ...res.headers } as Record<string, string | string[]>,
            setCookies: res.headers["set-cookie"] ?? [],
            location: res.headers.location,
            buffer: Buffer.concat(chunks),
          }),
        );
      });
    });

    req.on("error", (cause) => finish(() => reject(cause)));
    // Covers a slow drip as well as a dead peer, which req.setTimeout alone does not.
    timer = setTimeout(() => req.destroy(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function reportBody(body: string | Buffer | undefined): string | undefined {
  return Buffer.isBuffer(body) ? `<${body.length} bytes>` : body;
}

/**
 * Perform one HTTP exchange, following redirects.
 *
 * Built on `node:http` rather than `fetch` deliberately: `fetch` rejects a GET with
 * a body (which real Postman collections do send), hides the individual
 * `Set-Cookie` lines, and cannot expose the redirect chain.
 *
 * Resolves for both success and failure — a 500 is a result, not an exception. A
 * response that never arrived is reported as {@link NO_RESPONSE_STATUS}.
 */
export async function invokeHttp(options: HttpInvokeOptions): Promise<HttpInvokeResult> {
  const startedAt = process.hrtime.bigint();
  const elapsedMs = (): number => Number(process.hrtime.bigint() - startedAt) / 1e6;

  const warnings: string[] = [];
  const redirects: RedirectHop[] = [];
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const deadline = Date.now() + options.timeoutMs;
  const initialUrl = options.url.toString();

  let url = new URL(initialUrl);
  let method = options.method;
  let headers = [...options.headers];
  let body = options.body;

  for (;;) {
    const hopHeaders = [...headers];
    if (findHeader(hopHeaders, COOKIE) === undefined) {
      const cookie = options.jar?.headerFor(url);
      if (cookie !== undefined) hopHeaders.push({ key: COOKIE, value: cookie });
    }
    if (body !== undefined && findHeader(hopHeaders, CONTENT_LENGTH) === undefined) {
      hopHeaders.push({ key: CONTENT_LENGTH, value: String(Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body)) });
    }
    const outgoing = toOutgoingHeaders(hopHeaders);

    const remaining = deadline - Date.now();
    let raw: RawResponse;
    try {
      if (remaining <= 0) throw new Error(`timed out after ${options.timeoutMs}ms`);
      raw = await send(url, method, outgoing, body, remaining, options.tlsCerts);
    } catch (cause) {
      warnings.push(...tlsFailureHints(cause));
      return {
        ok: false,
        statusCode: NO_RESPONSE_STATUS,
        statusMessage: "",
        message: messageOf(cause),
        method,
        url: initialUrl,
        finalUrl: url.toString(),
        requestHeaders: outgoing,
        requestBody: reportBody(body),
        body: "",
        headers: {},
        setCookies: [],
        redirects,
        durationMs: elapsedMs(),
        warnings,
      };
    }

    options.jar?.storeFrom(url, raw.setCookies);

    const location = REDIRECT_STATUSES.has(raw.status) ? raw.location : undefined;
    if (location !== undefined && redirects.length < maxRedirects) {
      const next = new URL(location, url);
      redirects.push({ status: raw.status, from: url.toString(), to: next.toString() });

      if (next.origin !== url.origin) {
        headers = headers.filter((header) => !CROSS_ORIGIN_STRIPPED.has(header.key.toLowerCase()));
      }
      const rewritten = rewriteForRedirect(raw.status, method);
      method = rewritten.method;
      if (rewritten.dropBody) {
        body = undefined;
        headers = headers.filter((header) => header.key.toLowerCase() !== CONTENT_TYPE);
      }
      url = next;
      continue;
    }
    if (location !== undefined) warnings.push(`stopped after ${maxRedirects} redirects`);

    const decoded = decode(raw.buffer, firstValue(raw.headers, CONTENT_ENCODING), warnings);
    return {
      ok: raw.status >= SUCCESS_MIN && raw.status <= SUCCESS_MAX,
      statusCode: raw.status,
      statusMessage: raw.statusMessage,
      message: "",
      method,
      url: initialUrl,
      finalUrl: url.toString(),
      requestHeaders: outgoing,
      requestBody: reportBody(body),
      body: decoded.toString(charsetOf(firstValue(raw.headers, CONTENT_TYPE))),
      headers: raw.headers,
      setCookies: raw.setCookies,
      redirects,
      durationMs: elapsedMs(),
      warnings,
    };
  }
}
