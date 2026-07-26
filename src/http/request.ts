import { CliError } from "../errors.js";
import { interpolateStrict } from "../vars/interpolate.js";
import type { VariableStore } from "../vars/store.js";
import type { ResolvedAuth } from "../workspace/inherit.js";
import type { HttpRequest } from "../workspace/schemas.js";
import { applyAuth } from "./auth.js";
import { BODY_CONTENT_TYPES, readRequestBody, renderBody } from "./body.js";
import { dropEmptyValues, normalizeKeyValues, setHeaderIfAbsent, type KeyValue } from "./headers.js";
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
}

export interface BuiltHttpRequest {
  url: URL;
  method: string;
  headers: KeyValue[];
  body: string | undefined;
  target: HttpTarget;
  warnings: string[];
}

const DEFAULT_METHOD = "GET";
const CONTENT_TYPE = "content-type";
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/**
 * Turn a parsed `http-request` into everything {@link import("./invoke.js").invokeHttp} needs.
 *
 * Order matters: interpolate, normalise, merge query, then auth — so an `apikey`
 * in the query lands after the request's own params, and an explicit
 * `authorization` header is already visible when the auth block is applied.
 */
export function buildHttpRequest(options: BuildHttpRequestOptions): BuiltHttpRequest {
  const { request, store } = options;
  const warnings: string[] = [];

  const method = (request.method ?? DEFAULT_METHOD).trim().toUpperCase();
  if (!HTTP_METHODS.has(method)) {
    throw new CliError(`unsupported HTTP method "${request.method}"`, {
      details: [`supported methods: ${[...HTTP_METHODS].join(", ")}`],
    });
  }

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
    normalizeKeyValues(request.headers, `headers in ${request.url}`).map((header) => ({
      key: header.key,
      value: interpolateStrict(header.value, store, `header "${header.key}"`),
    })),
  );

  const params = normalizeKeyValues(request.queryParams, `queryParams in ${request.url}`).map((param) => ({
    key: param.key,
    value: interpolateStrict(param.value, store, `query param "${param.key}"`),
  }));
  const duplicated = mergeQuery(url, params);
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
  const body = renderBody(parsedBody, store);

  const contentType = BODY_CONTENT_TYPES[parsedBody.mode];
  if (body !== undefined && contentType !== undefined) {
    setHeaderIfAbsent(headers, CONTENT_TYPE, contentType);
  }

  return { url, method, headers, body, target: resolved.target, warnings };
}
