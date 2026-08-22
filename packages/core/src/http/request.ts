import { CliError } from "@preman/core/errors.js";
import { LiveBody, LiveHttpRequest, Url } from "@preman/core/scripts/live-request.js";
import { interpolateStrict } from "@preman/core/vars/interpolate.js";
import type { VariableStore } from "@preman/core/vars/store.js";
import type { ResolvedAuth } from "@preman/core/workspace/inherit.js";
import type { HttpRequest } from "@preman/core/workspace/schemas.js";
import type { FileReader } from "@preman/core/workspace/files.js";
import { applyAuth } from "./auth.js";
import {
  BODY_CONTENT_TYPES,
  FILE_MODE,
  FORM_DATA_MODE,
  GRAPHQL_MODE,
  RAW_MODE,
  URLENCODED_MODE,
  buildBody,
  readRequestBody,
  type WireBody,
} from "./body.js";
import { dropEmptyValues, findHeader, normalizeProperties, setHeaderIfAbsent, type KeyValue } from "./headers.js";
import { mergeQuery } from "./query.js";
import { pathPortion, resolveHttpUrl, type HttpTarget } from "./target.js";

export interface BuildHttpRequestOptions {
  request: HttpRequest;
  /** Already walked up the tree; absent means unauthenticated. */
  auth: ResolvedAuth | undefined;
  store: VariableStore;
  /** `--url`; replaces the origin only. */
  urlOverride?: string | undefined;
  tlsOverride?: boolean | undefined;
  files?: FileReader | undefined;
  /** Test seam for byte-exact multipart assertions. */
  boundary?: string | undefined;
}

export interface BuiltHttpRequest {
  url: URL;
  method: string;
  headers: KeyValue[];
  body: string | Buffer | undefined;
  target: HttpTarget;
  warnings: string[];
}

export interface BuiltLiveHttpRequest {
  request: LiveHttpRequest;
  target: HttpTarget;
  /** Structured bodies are materialised before scripts so file selection cannot be scripted. */
  wireBody: PreparedWireBody | undefined;
  warnings: string[];
}

const DEFAULT_METHOD = "GET";
const CONTENT_TYPE = "content-type";
const SCRIPT_TARGET_SOURCE = "pre-request script";
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const STRUCTURED_BODY_MODES = new Set([FORM_DATA_MODE, FILE_MODE, GRAPHQL_MODE]);
const KNOWN_BODY_MODES = new Set([RAW_MODE, ...Object.keys(BODY_CONTENT_TYPES), ...STRUCTURED_BODY_MODES]);
const MULTIPART_CONTENT_TYPE = "multipart/form-data; boundary=";
const NO_FILES: FileReader = {
  resolve() {
    throw new CliError("file-backed request bodies require a configured working directory");
  },
  read() {
    throw new CliError("file-backed request bodies require a configured working directory");
  },
};

interface PreparedWireBody {
  wire: WireBody;
  /** The prepared bytes are stale once a script replaces or edits this object. */
  source: LiveBody;
}

/**
 * Turn a parsed `http-request` into everything {@link import("./invoke.js").invokeHttp} needs.
 *
 * Order matters: interpolate, normalise, merge query, then auth — so an `apikey`
 * in the query lands after the request's own params, and an explicit
 * `authorization` header is already visible when the auth block is applied.
 */
function validateMethod(value: string): string {
  const method = value.trim().toUpperCase();
  if (!HTTP_METHODS.has(method)) {
    throw new CliError(`unsupported HTTP method "${value}"`, {
      details: [`supported methods: ${[...HTTP_METHODS].join(", ")}`],
    });
  }
  return method;
}

/** Interpolate, resolve the target and render auth into the object scripts edit. */
export function buildLiveHttpRequest(options: BuildHttpRequestOptions): BuiltLiveHttpRequest {
  const { request, store } = options;
  const warnings: string[] = [];

  const method = validateMethod(request.method ?? DEFAULT_METHOD);

  const hasOverride = options.urlOverride !== undefined && options.urlOverride.trim().length > 0;
  // With --url the origin is replaced outright, so an unresolvable {{admin_http_url}}
  // must not block the run; only the path still has to resolve.
  const rawUrl = hasOverride
    ? interpolateStrict(pathPortion(request.url), store, "url path")
    : interpolateStrict(request.url, store, "url");

  const resolved = resolveHttpUrl({
    rawUrl,
    override: options.urlOverride,
    tlsOverride: options.tlsOverride,
  });
  warnings.push(...resolved.warnings);
  const url = resolved.url;

  const headers = dropEmptyValues(
    normalizeProperties(request.headers, `headers in ${request.url}`).map((header) => ({
      key: header.key,
      value: header.disabled === true ? header.value : interpolateStrict(header.value, store, `header "${header.key}"`),
      ...(header.disabled === undefined ? {} : { disabled: header.disabled }),
    })),
  );

  const params = normalizeProperties(request.queryParams, `queryParams in ${request.url}`).map((param) => ({
    key: param.key,
    value: param.disabled === true ? param.value : interpolateStrict(param.value, store, `query param "${param.key}"`),
    ...(param.disabled === undefined ? {} : { disabled: param.disabled }),
  }));
  const duplicated = mergeQuery(
    url,
    params.filter((param) => param.disabled !== true),
  );
  if (duplicated.length > 0) {
    warnings.push(`query params already in the url were not appended twice: ${duplicated.join(", ")}`);
  }

  const auth = options.auth;
  const authWarnings = applyAuth({ auth: auth?.auth, headers, url, store });
  // Silent inherited auth is exactly how a stale token turns into an unexplained 401.
  if (auth !== undefined && auth.origin.level !== "request") {
    warnings.push(`auth inherited from ${auth.origin.label}`);
  }
  warnings.push(...authWarnings);

  const parsedBody = readRequestBody(request);
  let structuredWire: WireBody | undefined;
  if (STRUCTURED_BODY_MODES.has(parsedBody.mode)) {
    const builtBody = buildBody({
      body: request.body,
      store,
      files: options.files ?? NO_FILES,
      boundary: options.boundary,
      requestLabel: request.name ?? request.url,
    });
    structuredWire = builtBody.wire;
    warnings.push(...builtBody.warnings);
  } else {
    if (
      parsedBody.mode === URLENCODED_MODE &&
      request.body?.urlencoded !== undefined &&
      request.body.content !== undefined
    ) {
      warnings.push("body.content ignored because body.urlencoded is present");
    }
    if (parsedBody.mode.length > 0 && parsedBody.raw.length > 0 && !KNOWN_BODY_MODES.has(parsedBody.mode)) {
      warnings.push(`unknown body type "${parsedBody.mode}"; content sent without a generated Content-Type`);
    }
  }
  const structuredRaw = typeof structuredWire?.content === "string" ? structuredWire.content : "";
  let raw = "";
  if (parsedBody.mode === GRAPHQL_MODE) {
    raw = structuredRaw;
  } else if (parsedBody.raw.length > 0) {
    raw = interpolateStrict(parsedBody.raw, store, "request body");
  }
  const urlencoded = (parsedBody.urlencoded ?? []).map(({ key, value, disabled }) => ({
    key,
    value: disabled === true ? value : interpolateStrict(value, store, `body field "${key}"`),
    ...(disabled === undefined ? {} : { disabled }),
  }));
  const live = new LiveHttpRequest({
    url: Url.parse(
      url.toString(),
      params.filter((param) => param.disabled === true),
    ),
    method,
    headers,
    body: new LiveBody(parsedBody.mode, raw, urlencoded),
  });

  const wireBody = structuredWire === undefined ? undefined : { wire: structuredWire, source: live.body };
  return { request: live, target: resolved.target, wireBody, warnings };
}

/** Convert a possibly script-mutated request to wire values without interpolating again. */
export function finaliseHttpRequest(
  request: LiveHttpRequest,
  target: HttpTarget,
  preparedBody?: PreparedWireBody,
): BuiltHttpRequest {
  const method = validateMethod(request.method);
  let url: URL;
  try {
    url = new URL(request.url.toString());
  } catch {
    throw new CliError(`request url "${request.url.toString()}" is not a valid url`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError(`request url "${request.url.toString()}" uses an unsupported scheme ${url.protocol}`, {
      details: ["only http and https are supported"],
    });
  }

  const headers = request.headers.enabled();
  const liveWire = request.body.toWire();
  const usePrepared = preparedBody?.source === request.body && !request.body.changed;
  const wireBody = usePrepared ? preparedBody.wire : { content: liveWire.body, contentType: liveWire.contentType };
  const { content: body, contentType } = wireBody;
  const warnings: string[] = [];
  if (
    body !== undefined &&
    contentType?.startsWith(MULTIPART_CONTENT_TYPE) === true &&
    findHeader(headers, CONTENT_TYPE) !== undefined
  ) {
    warnings.push("explicit Content-Type overrides the generated multipart boundary");
  }
  if (body !== undefined && contentType !== undefined) setHeaderIfAbsent(headers, CONTENT_TYPE, contentType);
  const source = url.origin === target.origin ? target.source : SCRIPT_TARGET_SOURCE;
  const finalTarget = { origin: url.origin, tls: url.protocol === "https:", source };
  return { url, method, headers, body, target: finalTarget, warnings };
}

/** Backwards-compatible one-pass build for callers that do not run scripts. */
export function buildHttpRequest(options: BuildHttpRequestOptions): BuiltHttpRequest {
  const built = buildLiveHttpRequest(options);
  const finalised = finaliseHttpRequest(built.request, built.target, built.wireBody);
  return { ...finalised, warnings: [...built.warnings, ...finalised.warnings] };
}
