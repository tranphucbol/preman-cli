import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import { httpsRequestOptions, tlsFailureHints, type TlsCertOptions } from "@preman/core/tls/certs.js";
import type { CookieJar } from "./cookies.js";
import { findHeader, toOutgoingHeaders, type KeyValue } from "./headers.js";
import { isEventStream, SseParser, type SseFrame } from "./sse.js";

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
  /**
   * Stops the exchange on demand. Destroys the socket rather than merely stopping the
   * reading of it, and is checked between redirect hops so an aborted chain does not
   * dial the next one. Decision 051.
   */
  signal?: AbortSignal | undefined;
  /**
   * Reads a `text/event-stream` response as it arrives instead of waiting for the end of it.
   *
   * Optional, and the whole feature turns on that: a caller that passes nothing gets the
   * buffered exchange this function has always performed, `timeoutMs` and all. The window
   * passes a sink because a chat completion that takes eight seconds should not be eight
   * seconds of blank pane. The CLI passes nothing, so `--timeout` stays the ceiling it is
   * relied on to be in CI, where a subscription that never ends would otherwise never end.
   */
  stream?: HttpStreamSink | undefined;
}

/** The head of a response whose body has no end in sight. */
export interface HttpStreamOpen {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[]>;
  setCookies: string[];
  /** Time to the head. For a stream this is the only timing there is until it closes. */
  headersMs: number;
}

export interface HttpStreamSink {
  /** The stream has started. Called once, before any frame, and only for a stream. */
  open(open: HttpStreamOpen): void;
  /** The frames one chunk completed, and how many bytes of body have arrived in total. */
  frames(frames: readonly SseFrame[], byteLength: number): void;
}

/** What {@link send} knows at the head; {@link invokeHttp} owns the clock and adds the rest. */
type RawStreamOpen = Omit<HttpStreamOpen, "headersMs">;

interface RawStreamSink {
  open(open: RawStreamOpen): void;
  frames(frames: readonly SseFrame[], byteLength: number): void;
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
  /**
   * Why a stream stopped before the server closed it; undefined when it closed
   * cleanly, and always undefined for a buffered response, which has no such state.
   * It is also in `warnings`, but a caller narrating the end of a stream needs the
   * reason itself rather than a sentence that contains it.
   */
  cutShort: string | undefined;
  warnings: string[];
}

interface RawResponse {
  status: number;
  statusMessage: string;
  headers: Record<string, string | string[]>;
  setCookies: string[];
  location: string | undefined;
  buffer: Buffer;
  /** Why a stream stopped before the server closed it; undefined when it closed cleanly. */
  cutShort: string | undefined;
}

export const NO_RESPONSE_STATUS = 0;

/**
 * What an aborted exchange reports as its transport message.
 *
 * Phrased as a sentence rather than a code because it is printed verbatim - by the
 * CLI in red, and by the window's failure pane - and "cancelled" on its own reads
 * like a status the server sent.
 */
export const CANCELLED_MESSAGE = "the request was cancelled";

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
const NO_BYTES = 0;

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * What Node says when the peer destroys the socket while the body is still coming.
 *
 * The word on its own is the whole message, and it is the same word a reader who
 * pressed Cancel would expect to see, so shown unchanged it blames them for the
 * server hanging up. Every other way a stream stops already reports a sentence.
 */
const PEER_RESET_MESSAGE = "aborted";
const PEER_RESET_REASON = "the server closed the connection";

/** Why a stream stopped before the server said it was finished. */
function cutShortReason(cause: unknown): string {
  const message = messageOf(cause);
  return message === PEER_RESET_MESSAGE ? PEER_RESET_REASON : message;
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

/**
 * Whether a response arriving under this head is one to read live.
 *
 * A redirect is excluded because nobody reads the body of one, and following it is the
 * next thing that happens anyway. A compressed one is excluded because the decompressors
 * here take a whole buffer and there is no whole buffer yet; servers that stream normally
 * turn compression off, and one that does not is read the old way rather than wrongly.
 */
function streamable(status: number, headers: Record<string, string | string[]>): boolean {
  if (REDIRECT_STATUSES.has(status)) return false;
  if (!isEventStream(firstValue(headers, CONTENT_TYPE))) return false;
  return IDENTITY_ENCODINGS.has((firstValue(headers, CONTENT_ENCODING) ?? "").trim().toLowerCase());
}

function send(
  url: URL,
  method: string,
  headers: Record<string, string | string[]>,
  body: string | Buffer | undefined,
  timeoutMs: number,
  tlsCerts: TlsCertOptions,
  signal: AbortSignal | undefined,
  stream: RawStreamSink | undefined,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const secure = url.protocol === HTTPS_PROTOCOL;
    const driver = secure ? httpsRequest : httpRequest;
    // Applied per hop rather than once up front, so a redirect into https still gets
    // the certificate material even when the first hop was cleartext.
    const tlsOptions = secure ? httpsRequestOptions(tlsCerts) : {};
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      settle();
    };
    /**
     * Set once a stream is open, and the whole reason it lives out here.
     *
     * Cancel destroys the request, and a destroyed request reports through the request's
     * own error listener rather than the response's. Without this, the one case the
     * feature exists to serve - the reader stopping a stream they are done with - would
     * throw away every frame it had just shown them.
     */
    let interrupt: ((cause: unknown) => RawResponse) | undefined;

    const req = driver(url, { ...tlsOptions, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      const status = res.statusCode ?? NO_RESPONSE_STATUS;
      const responseHeaders = { ...res.headers } as Record<string, string | string[]>;
      const setCookies = res.headers["set-cookie"] ?? [];
      const settle = (cutShort: string | undefined): RawResponse => ({
        status,
        statusMessage: res.statusMessage ?? "",
        headers: responseHeaders,
        setCookies,
        location: res.headers.location,
        buffer: Buffer.concat(chunks),
        cutShort,
      });

      const live =
        stream !== undefined && streamable(status, responseHeaders)
          ? { parser: new SseParser(), sink: stream }
          : undefined;
      let received = NO_BYTES;
      let flushed = false;
      /** Dispatch whatever the last bytes left in the parser. Once, however the stream ends. */
      const flush = (): void => {
        if (live === undefined || flushed) return;
        flushed = true;
        live.sink.frames(live.parser.end(Date.now()), received);
      };

      if (live !== undefined) {
        // The exchange budget covered a body that was going to end. This one is not, so
        // holding it to a deadline would just be a countdown to killing a working stream.
        // What stops it now is the server, the peer dying, or Cancel - see Decision 052.
        clearTimeout(timer);
        live.sink.open({
          statusCode: status,
          statusMessage: res.statusMessage ?? "",
          headers: responseHeaders,
          setCookies,
        });
        // A stream cut short settles with what arrived rather than rejecting: the request
        // did succeed, the response did start, and the reader who pressed Cancel wants the
        // frames they already have, not an error page where they used to be.
        interrupt = (cause) => {
          flush();
          return settle(cutShortReason(cause));
        };
      }

      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (live === undefined) return;
        received += chunk.length;
        live.sink.frames(live.parser.push(chunk, Date.now()), received);
      });
      res.on("error", (cause) => {
        const partial = interrupt;
        if (partial === undefined) {
          finish(() => reject(cause));
          return;
        }
        finish(() => resolve(partial(cause)));
      });
      res.on("end", () => {
        flush();
        finish(() => resolve(settle(undefined)));
      });
    });

    req.on("error", (cause) => {
      const partial = interrupt;
      if (partial === undefined) {
        finish(() => reject(cause));
        return;
      }
      finish(() => resolve(partial(cause)));
    });
    // Covers a slow drip as well as a dead peer, which req.setTimeout alone does not.
    const timer = setTimeout(() => req.destroy(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    // Destroying the request, not just stopping the reading of it: a response that is
    // still arriving holds the socket open until the server decides otherwise, which for
    // a stream is never. The destroy surfaces through the `error` listener above, so the
    // message reaches the caller by the same path a timeout does.
    const abort = (): void => {
      req.destroy(new Error(CANCELLED_MESSAGE));
    };
    signal?.addEventListener("abort", abort, { once: true });
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

  // The clock belongs to the whole exchange, redirects included, so the head timing is
  // stamped here rather than inside the hop that happens to have opened the stream.
  const outer = options.stream;
  const hopStream: RawStreamSink | undefined =
    outer === undefined
      ? undefined
      : {
          open: (open) => {
            outer.open({ ...open, headersMs: elapsedMs() });
          },
          frames: (frames, byteLength) => {
            outer.frames(frames, byteLength);
          },
        };

  for (;;) {
    const hopHeaders = [...headers];
    if (findHeader(hopHeaders, COOKIE) === undefined) {
      const cookie = options.jar?.headerFor(url);
      if (cookie !== undefined) hopHeaders.push({ key: COOKIE, value: cookie });
    }
    if (body !== undefined && findHeader(hopHeaders, CONTENT_LENGTH) === undefined) {
      hopHeaders.push({
        key: CONTENT_LENGTH,
        value: String(Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body)),
      });
    }
    const outgoing = toOutgoingHeaders(hopHeaders);

    const remaining = deadline - Date.now();
    let raw: RawResponse;
    try {
      // Checked before the hop as well as during it: an abort that lands between two
      // redirects would otherwise be answered by dialling the next one.
      if (options.signal?.aborted === true) throw new Error(CANCELLED_MESSAGE);
      if (remaining <= 0) throw new Error(`timed out after ${options.timeoutMs}ms`);
      raw = await send(url, method, outgoing, body, remaining, options.tlsCerts, options.signal, hopStream);
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
        cutShort: undefined,
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
    if (raw.cutShort !== undefined) warnings.push(`the stream ended early: ${raw.cutShort}`);

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
      cutShort: raw.cutShort,
      warnings,
    };
  }
}
