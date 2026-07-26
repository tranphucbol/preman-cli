import { CliError } from "../errors.js";

export interface HttpTarget {
  /** `scheme://host[:port]` actually used. */
  origin: string;
  tls: boolean;
  /** Human-readable provenance, printed before the call. */
  source: string;
}

export interface ResolveHttpUrlOptions {
  /** The request's `url`, already interpolated. */
  rawUrl: string;
  /** `--url`; replaces the origin only. */
  override?: string | undefined;
  /** `--tls` / `--plaintext`; undefined means "trust the url's scheme". */
  tlsOverride?: boolean | undefined;
}

export interface ResolvedHttpUrl {
  url: URL;
  target: HttpTarget;
  warnings: string[];
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const HTTP_SCHEMES = new Set(["http:", "https:"]);
const DEFAULT_SCHEME = "http://";
const OVERRIDE_SOURCE = "--url";
const REQUEST_SOURCE = "request url";

/**
 * The path + query + fragment of a url, without parsing it.
 *
 * Used for `--url`, which replaces the origin: everything before the first `/`
 * is discarded, so an unresolved `{{admin_http_url}}` prefix cannot break the run.
 */
export function pathPortion(rawUrl: string): string {
  const withoutScheme = rawUrl.trim().replace(SCHEME, "");
  const slash = withoutScheme.indexOf("/");
  if (slash === -1) {
    const query = withoutScheme.indexOf("?");
    return query === -1 ? "/" : `/${withoutScheme.slice(query)}`;
  }
  return withoutScheme.slice(slash);
}

function missingOrigin(rawUrl: string): CliError {
  return new CliError(`could not determine an HTTP origin from "${rawUrl}"`, {
    details: [
      "the url has no scheme or host after interpolation",
      "set the base url variable in the environment (e.g. admin_http_url), or pass --url <origin>",
    ],
  });
}

/** Parse an absolute url, prefixing `http://` when the scheme is missing. */
function parseAbsolute(raw: string, label: string): URL {
  const text = SCHEME.test(raw) ? raw : `${DEFAULT_SCHEME}${raw}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new CliError(`${label} "${raw}" is not a valid url`);
  }
  if (!HTTP_SCHEMES.has(url.protocol)) {
    throw new CliError(`${label} "${raw}" uses an unsupported scheme ${url.protocol}`, {
      details: ["only http and https are supported"],
    });
  }
  if (url.hostname.length === 0) throw missingOrigin(raw);
  return url;
}

/**
 * Decide the absolute url to call.
 *
 * `--url` replaces protocol, host and port and keeps the request's own path and
 * query — a base-url override, not a whole-url override. Without it the request's
 * url must be absolute: guessing an origin would silently hit the wrong service.
 */
export function resolveHttpUrl(options: ResolveHttpUrlOptions): ResolvedHttpUrl {
  const warnings: string[] = [];
  const raw = options.rawUrl.trim();
  const override = options.override?.trim() ?? "";

  let url: URL;
  let source: string;

  if (override.length > 0) {
    const base = parseAbsolute(override, OVERRIDE_SOURCE);
    if (base.pathname !== "/" || base.search.length > 0) {
      warnings.push(`--url path "${base.pathname}${base.search}" ignored; the request's own path is used`);
    }
    url = new URL(pathPortion(raw), base.origin);
    source = OVERRIDE_SOURCE;
  } else {
    if (raw.length === 0) throw missingOrigin(raw);
    // A leading slash means the origin never resolved, so scheme-sniff first:
    // prefixing `http://` here would turn `/api/v1/login` into the host `api`.
    if (raw.startsWith("/")) throw missingOrigin(raw);
    url = parseAbsolute(raw, REQUEST_SOURCE);
    source = REQUEST_SOURCE;
  }

  if (options.tlsOverride !== undefined) {
    url.protocol = options.tlsOverride ? "https:" : "http:";
  }

  return {
    url,
    target: { origin: url.origin, tls: url.protocol === "https:", source },
    warnings,
  };
}
