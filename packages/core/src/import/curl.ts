/**
 * A split `curl` command line to the fields of an HTTP request.
 *
 * Everything here is grammar: {@link splitWords} has already decided where the words are, and
 * `api/import.ts` decides what the fields are worth. The two rules the table below never bends
 * are decision 4 — an unrecognised flag is a warning and never a refusal, because a curl
 * produced by a newer curl than this parser must still import — and decision 13, that every
 * flag with no representation is named with one clause of why.
 */
import { EXIT, PremanError } from "@preman/core/errors.js";
import { sanitiseSegment } from "@preman/core/workspace/paths.js";
import type { DroppedFlag } from "./plan.js";

export interface KeyValueEntry {
  readonly key: string;
  readonly value: string;
}

export interface FormDataEntry {
  readonly key: string;
  readonly type: "text" | "file";
  readonly value?: string;
  readonly src?: string;
  readonly contentType?: string;
}

export type ParsedBody =
  | { readonly type: "raw"; readonly content: string }
  | { readonly type: "urlencoded"; readonly urlencoded: readonly KeyValueEntry[] }
  | { readonly type: "formdata"; readonly formdata: readonly FormDataEntry[] };

export interface ParsedAuth {
  readonly type: "basic" | "bearer";
  readonly credentials: Readonly<Record<string, string>>;
}

export interface ParsedCurl {
  readonly method: string;
  readonly url: string;
  readonly headers: readonly KeyValueEntry[];
  readonly queryParams: readonly KeyValueEntry[];
  readonly body: ParsedBody | undefined;
  readonly auth: ParsedAuth | undefined;
  readonly dropped: readonly DroppedFlag[];
  readonly warnings: readonly string[];
}

const DASH = "-";
const LONG_PREFIX = "--";
/** curl's own end-of-flags marker; everything after it is a URL. */
const END_OF_FLAGS = "--";
const EQUALS = "=";
const AT = "@";
const ANGLE = "<";
const SEMICOLON = ";";
const COLON = ":";
const AMPERSAND = "&";
const PAIR_TYPE_SUFFIX = ";type=";
const PATH_SEPARATOR = "/";

/** The program names a pasted line may start with, however it was invoked. */
const CURL_COMMANDS = new Set(["curl", "curl.exe"]);

const GET = "GET";
const POST = "POST";
const HEAD = "HEAD";

const CONTENT_TYPE_HEADER = "content-type";
const JSON_CONTENT_TYPE = "application/json";
const USER_AGENT_HEADER = "user-agent";
const REFERER_HEADER = "referer";
const COOKIE_HEADER = "cookie";

/** Short flags that consume a value, mapped to the long name the rest of the parser speaks. */
const SHORT_FLAGS_WITH_VALUE: Record<string, string> = {
  X: "request",
  H: "header",
  d: "data",
  F: "form",
  u: "user",
  A: "user-agent",
  e: "referer",
  b: "cookie",
  c: "cookie-jar",
  o: "output",
  x: "proxy",
  E: "cert",
  m: "max-time",
  T: "upload-file",
  w: "write-out",
  D: "dump-header",
  U: "proxy-user",
  r: "range",
  z: "time-cond",
};

/** Short flags that consume nothing. */
const SHORT_FLAGS: Record<string, string> = {
  G: "get",
  L: "location",
  k: "insecure",
  s: "silent",
  S: "show-error",
  v: "verbose",
  i: "include",
  I: "head",
  O: "remote-name",
  f: "fail",
  j: "junk-session-cookies",
  N: "no-buffer",
  g: "globoff",
  q: "disable",
  "#": "progress-bar",
  "4": "ipv4",
  "6": "ipv6",
};

/** Long flags that consume the next word when it is not given as `--flag=value`. */
const LONG_FLAGS_WITH_VALUE = new Set([
  "request",
  "header",
  "data",
  "data-raw",
  "data-binary",
  "data-ascii",
  "data-urlencode",
  "form",
  "form-string",
  "json",
  "user",
  "user-agent",
  "referer",
  "cookie",
  "cookie-jar",
  "output",
  "proxy",
  "proxy-user",
  "noproxy",
  "interface",
  "resolve",
  "connect-to",
  "unix-socket",
  "cacert",
  "capath",
  "cert",
  "cert-type",
  "key",
  "key-type",
  "pass",
  "ciphers",
  "max-time",
  "connect-timeout",
  "max-redirs",
  "retry",
  "retry-delay",
  "retry-max-time",
  "limit-rate",
  "range",
  "upload-file",
  "write-out",
  "dump-header",
  "time-cond",
  "url",
  "oauth2-bearer",
  "aws-sigv4",
  "local-port",
]);

/** The body flags whose value is a payload, and whether a leading `@` means "read a file". */
const RAW_BODY_FLAGS: Record<string, boolean> = {
  data: true,
  "data-binary": true,
  "data-ascii": true,
  "data-raw": false,
};

const TLS_REASON = "preman layers TLS through --ssl-*, --insecure and .postman/preman.yaml";
const RUN_OPTION_REASON = "a preman run option, not a request field";
const OUTPUT_REASON = "output only";
const ENCODING_REASON = "preman already negotiates response encoding";
const NO_REPRESENTATION_REASON = "a request file has no field for it";
const BODY_FILE_REASON = "reads the body from a file; paste the body text instead";
const COOKIE_FILE_REASON = "reads cookies from a file; paste the Cookie header instead";
const HEADER_REMOVAL_REASON = "removes a header curl adds; preman adds none";

/** Every flag that is understood and has nowhere to land, with the clause that says why. */
const DROP_REASONS: Record<string, string> = {
  insecure: TLS_REASON,
  cacert: TLS_REASON,
  capath: TLS_REASON,
  cert: TLS_REASON,
  "cert-type": TLS_REASON,
  key: TLS_REASON,
  "key-type": TLS_REASON,
  pass: TLS_REASON,
  ciphers: TLS_REASON,
  tlsv1: TLS_REASON,
  "tlsv1.0": TLS_REASON,
  "tlsv1.1": TLS_REASON,
  "tlsv1.2": TLS_REASON,
  "tlsv1.3": TLS_REASON,
  location: RUN_OPTION_REASON,
  "location-trusted": RUN_OPTION_REASON,
  "max-redirs": RUN_OPTION_REASON,
  "max-time": RUN_OPTION_REASON,
  "connect-timeout": RUN_OPTION_REASON,
  retry: RUN_OPTION_REASON,
  "retry-delay": RUN_OPTION_REASON,
  "retry-max-time": RUN_OPTION_REASON,
  "limit-rate": RUN_OPTION_REASON,
  output: OUTPUT_REASON,
  "remote-name": OUTPUT_REASON,
  silent: OUTPUT_REASON,
  "show-error": OUTPUT_REASON,
  verbose: OUTPUT_REASON,
  include: OUTPUT_REASON,
  fail: OUTPUT_REASON,
  "fail-with-body": OUTPUT_REASON,
  "progress-bar": OUTPUT_REASON,
  "no-progress-meter": OUTPUT_REASON,
  "write-out": OUTPUT_REASON,
  "dump-header": OUTPUT_REASON,
  trace: OUTPUT_REASON,
  "trace-ascii": OUTPUT_REASON,
  compressed: ENCODING_REASON,
  proxy: NO_REPRESENTATION_REASON,
  "proxy-user": NO_REPRESENTATION_REASON,
  noproxy: NO_REPRESENTATION_REASON,
  interface: NO_REPRESENTATION_REASON,
  resolve: NO_REPRESENTATION_REASON,
  "connect-to": NO_REPRESENTATION_REASON,
  "unix-socket": NO_REPRESENTATION_REASON,
  "cookie-jar": NO_REPRESENTATION_REASON,
  "upload-file": NO_REPRESENTATION_REASON,
  range: NO_REPRESENTATION_REASON,
  "time-cond": NO_REPRESENTATION_REASON,
  "aws-sigv4": NO_REPRESENTATION_REASON,
  "local-port": NO_REPRESENTATION_REASON,
  globoff: NO_REPRESENTATION_REASON,
  disable: NO_REPRESENTATION_REASON,
  "no-buffer": NO_REPRESENTATION_REASON,
  "junk-session-cookies": NO_REPRESENTATION_REASON,
  ipv4: NO_REPRESENTATION_REASON,
  ipv6: NO_REPRESENTATION_REASON,
  "http1.0": NO_REPRESENTATION_REASON,
  "http1.1": NO_REPRESENTATION_REASON,
  http2: NO_REPRESENTATION_REASON,
  "http2-prior-knowledge": NO_REPRESENTATION_REASON,
  http3: NO_REPRESENTATION_REASON,
};

/** A word with a scheme, or a host-looking first segment. `7` is not a URL; `localhost:8080` is. */
const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const DEFAULT_SCHEME = "https://";
const HOST_HINTS = [".", ":"];
/** Where a URL stops being a path, for the purpose of naming the request after one. */
const QUERY_PATTERN = /[?#]/;
/** When neither the path nor the host survives `sanitiseSegment`, the request still needs a name. */
const FALLBACK_NAME = "Imported request";

interface Flag {
  /** Canonical long name, without the leading dashes. */
  readonly name: string;
  /** As the user wrote it, so a message can be found in the paste. */
  readonly spelling: string;
  readonly value: string | undefined;
}

function usage(message: string, details: string[]): PremanError {
  return new PremanError(message, { exitCode: EXIT.CLI, details });
}

function requireValue(flag: Flag): string {
  if (flag.value === undefined) {
    throw usage(`${flag.spelling} needs a value`, ["the command ends before the value it expects"]);
  }
  return flag.value;
}

/**
 * The request name a URL proposes: its last path segment, or its host when there is no path.
 *
 * Lossy on purpose — the name is a label, and both front ends let it be edited before the
 * write. A URL whose last segment survives nothing `sanitiseSegment` allows falls back to the
 * host, and then to a constant, rather than refusing an import over what to call it.
 */
export function nameForUrl(url: string): string {
  const authority = url.replace(SCHEME_PATTERN, "").split(QUERY_PATTERN)[0] ?? "";
  const segments = authority.split(PATH_SEPARATOR).filter((segment) => segment.length > 0);
  const host = segments[0];
  const last = segments.length > 1 ? segments[segments.length - 1] : host;
  for (const candidate of [last, host]) {
    if (candidate === undefined) continue;
    try {
      return sanitiseSegment(candidate);
    } catch {
      // Try the host, then give up on deriving one at all.
    }
  }
  return FALLBACK_NAME;
}

export function looksLikeUrl(word: string): boolean {
  if (SCHEME_PATTERN.test(word)) return true;
  const authority = word.split(PATH_SEPARATOR)[0] ?? "";
  return HOST_HINTS.some((hint) => authority.includes(hint));
}

/** The words after the program name, if the paste led with one. */
function stripCommand(words: readonly string[]): readonly string[] {
  const first = words[0];
  if (first === undefined) return words;
  const program = first.split(PATH_SEPARATOR).pop() ?? first;
  return CURL_COMMANDS.has(program.toLowerCase()) ? words.slice(1) : words;
}

/**
 * Words to flags and positionals.
 *
 * An unrecognised flag consumes nothing unless it was written `--flag=value`. Guessing that it
 * takes the next word would swallow the URL of a command that used a flag this table has never
 * heard of, which is exactly the case decision 4 exists to keep importable.
 */
function tokenise(words: readonly string[]): { flags: Flag[]; positionals: string[] } {
  const flags: Flag[] = [];
  const positionals: string[] = [];
  let at = 0;
  let flagsEnded = false;

  while (at < words.length) {
    const word = words[at]!;
    at += 1;

    if (flagsEnded || !word.startsWith(DASH) || word === DASH) {
      positionals.push(word);
      continue;
    }
    if (word === END_OF_FLAGS) {
      flagsEnded = true;
      continue;
    }

    if (word.startsWith(LONG_PREFIX)) {
      const rest = word.slice(LONG_PREFIX.length);
      const equals = rest.indexOf(EQUALS);
      const name = equals === -1 ? rest : rest.slice(0, equals);
      const inline = equals === -1 ? undefined : rest.slice(equals + 1);
      const takesValue = inline === undefined && LONG_FLAGS_WITH_VALUE.has(name);
      const value = takesValue ? words[at] : inline;
      if (takesValue) at += 1;
      flags.push({ name, spelling: `${LONG_PREFIX}${name}`, value });
      continue;
    }

    // A short cluster: `-sSL`, and `-XPOST` where the rest of the cluster is the value.
    const cluster = word.slice(DASH.length);
    for (let index = 0; index < cluster.length; index += 1) {
      const letter = cluster[index]!;
      const spelling = `${DASH}${letter}`;
      const withValue = SHORT_FLAGS_WITH_VALUE[letter];
      if (withValue !== undefined) {
        const attached = cluster.slice(index + 1);
        const value = attached.length > 0 ? attached : words[at];
        if (attached.length === 0) at += 1;
        flags.push({ name: withValue, spelling, value });
        break;
      }
      flags.push({ name: SHORT_FLAGS[letter] ?? letter, spelling, value: undefined });
    }
  }

  return { flags, positionals };
}

function splitPairs(text: string): KeyValueEntry[] {
  return text
    .split(AMPERSAND)
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const equals = pair.indexOf(EQUALS);
      return equals === -1 ? { key: pair, value: "" } : { key: pair.slice(0, equals), value: pair.slice(equals + 1) };
    });
}

/** `-F name=value`, `-F name=@path`, `-F name=<path`, each optionally `;type=…`. */
function formEntry(raw: string): FormDataEntry {
  const equals = raw.indexOf(EQUALS);
  if (equals === -1) return { key: raw, type: "text", value: "" };
  const key = raw.slice(0, equals);
  let value = raw.slice(equals + 1);
  let contentType: string | undefined;
  const typeAt = value.indexOf(PAIR_TYPE_SUFFIX);
  if (typeAt !== -1) {
    contentType = value.slice(typeAt + PAIR_TYPE_SUFFIX.length);
    value = value.slice(0, typeAt);
  }
  if (value.startsWith(AT) || value.startsWith(ANGLE)) {
    return { key, type: "file", src: value.slice(1), contentType };
  }
  return { key, type: "text", value, contentType };
}

/** Everything the flags say, before any of it is turned into a request. */
interface CurlState {
  method: string | undefined;
  head: boolean;
  get: boolean;
  readonly headers: KeyValueEntry[];
  readonly raw: string[];
  readonly urlencoded: KeyValueEntry[];
  readonly formdata: FormDataEntry[];
  auth: ParsedAuth | undefined;
  readonly urls: string[];
  readonly dropped: DroppedFlag[];
  readonly warnings: string[];
}

function drop(state: CurlState, flag: Flag, reason: string): void {
  if (state.dropped.some((entry) => entry.flag === flag.spelling)) return;
  state.dropped.push({ flag: flag.spelling, reason });
}

/** `-H 'Name: value'`, plus curl's two shapes that mean "send nothing under this name". */
function applyHeader(state: CurlState, flag: Flag): void {
  const raw = requireValue(flag).trim();
  const colon = raw.indexOf(COLON);
  if (colon === -1) {
    const named = raw.endsWith(SEMICOLON) ? raw.slice(0, -1) : raw;
    drop(state, { ...flag, spelling: `${flag.spelling} ${named}` }, HEADER_REMOVAL_REASON);
    return;
  }
  const key = raw.slice(0, colon).trim();
  const value = raw.slice(colon + 1).trim();
  if (value.length === 0) {
    drop(state, { ...flag, spelling: `${flag.spelling} ${key}:` }, HEADER_REMOVAL_REASON);
    return;
  }
  state.headers.push({ key, value });
}

function applyFlag(state: CurlState, flag: Flag): void {
  switch (flag.name) {
    case "request":
      state.method = requireValue(flag).toUpperCase();
      return;
    case "head":
      state.head = true;
      return;
    case "get":
      state.get = true;
      return;
    case "url":
      state.urls.push(requireValue(flag));
      return;
    case "header":
      applyHeader(state, flag);
      return;
    case "user-agent":
      state.headers.push({ key: USER_AGENT_HEADER, value: requireValue(flag) });
      return;
    case "referer":
      state.headers.push({ key: REFERER_HEADER, value: requireValue(flag) });
      return;
    case "cookie": {
      const value = requireValue(flag);
      if (!value.includes(EQUALS)) {
        drop(state, flag, COOKIE_FILE_REASON);
        return;
      }
      state.headers.push({ key: COOKIE_HEADER, value });
      return;
    }
    case "json": {
      state.raw.push(requireValue(flag));
      if (!state.headers.some((header) => header.key.toLowerCase() === CONTENT_TYPE_HEADER)) {
        state.headers.push({ key: CONTENT_TYPE_HEADER, value: JSON_CONTENT_TYPE });
      }
      return;
    }
    case "data-urlencode": {
      const value = requireValue(flag);
      const equals = value.indexOf(EQUALS);
      const at = value.indexOf(AT);
      if (at !== -1 && (equals === -1 || at < equals)) {
        drop(state, flag, BODY_FILE_REASON);
        return;
      }
      state.urlencoded.push(
        equals === -1 ? { key: "", value } : { key: value.slice(0, equals), value: value.slice(equals + 1) },
      );
      return;
    }
    case "form":
    case "form-string":
      state.formdata.push(formEntry(requireValue(flag)));
      return;
    case "user": {
      const value = requireValue(flag);
      const colon = value.indexOf(COLON);
      const username = colon === -1 ? value : value.slice(0, colon);
      const password = colon === -1 ? "" : value.slice(colon + 1);
      state.auth = { type: "basic", credentials: { username, password } };
      return;
    }
    case "oauth2-bearer":
      state.auth = { type: "bearer", credentials: { token: requireValue(flag) } };
      return;
    default:
      break;
  }

  const readsFile = RAW_BODY_FLAGS[flag.name];
  if (readsFile !== undefined) {
    const value = requireValue(flag);
    if (readsFile && value.startsWith(AT)) {
      drop(state, flag, BODY_FILE_REASON);
      return;
    }
    state.raw.push(value);
    return;
  }

  const reason = DROP_REASONS[flag.name];
  if (reason !== undefined) {
    drop(state, flag, reason);
    return;
  }
  state.warnings.push(`${flag.spelling} is not a flag preman knows; the request was imported without it`);
}

/**
 * The body the flags describe, or `undefined`.
 *
 * `-G` empties this on purpose: its whole meaning is that the pairs belong in the query
 * (decision 11), and the caller has already read them out of the same state.
 */
function bodyFor(state: CurlState): ParsedBody | undefined {
  if (state.formdata.length > 0) return { type: "formdata", formdata: state.formdata };
  if (state.get) return undefined;
  if (state.urlencoded.length > 0) {
    return { type: "urlencoded", urlencoded: [...state.raw.flatMap(splitPairs), ...state.urlencoded] };
  }
  if (state.raw.length === 0) return undefined;
  return { type: "raw", content: state.raw.join(AMPERSAND) };
}

/** `-G` moves the body pairs to the query, which is the one case that is not left in the URL. */
function queryFor(state: CurlState): KeyValueEntry[] {
  if (!state.get) return [];
  return [...state.raw.flatMap(splitPairs), ...state.urlencoded];
}

function methodFor(state: CurlState, body: ParsedBody | undefined): string {
  if (state.method !== undefined) return state.method;
  if (state.head) return HEAD;
  return body === undefined ? GET : POST;
}

function urlFor(state: CurlState, positionals: readonly string[], warnings: string[]): string {
  const candidates = [...state.urls, ...positionals.filter(looksLikeUrl)];
  for (const word of positionals) {
    if (looksLikeUrl(word)) continue;
    warnings.push(`"${word}" is not a flag or a URL and was ignored`);
  }
  if (candidates.length === 0) {
    throw usage("the command names no URL", ["a request needs somewhere to go"]);
  }
  if (candidates.length > 1) {
    throw usage("the command names more than one URL", [
      ...candidates.map((candidate) => `  ${candidate}`),
      "one request file addresses one URL; import them one at a time",
    ]);
  }
  const url = candidates[0]!;
  // What curl itself does with a bare host, so the imported request goes where the paste went.
  return SCHEME_PATTERN.test(url) ? url : `${DEFAULT_SCHEME}${url}`;
}

export function parseCurl(words: readonly string[]): ParsedCurl {
  const { flags, positionals } = tokenise(stripCommand(words));
  const state: CurlState = {
    method: undefined,
    head: false,
    get: false,
    headers: [],
    raw: [],
    urlencoded: [],
    formdata: [],
    auth: undefined,
    urls: [],
    dropped: [],
    warnings: [],
  };

  for (const flag of flags) applyFlag(state, flag);

  const body = bodyFor(state);
  const url = urlFor(state, positionals, state.warnings);
  return {
    method: methodFor(state, body),
    url,
    headers: state.headers,
    queryParams: queryFor(state),
    body,
    auth: state.auth,
    dropped: state.dropped,
    warnings: state.warnings,
  };
}
