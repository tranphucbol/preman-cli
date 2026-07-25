import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CliError } from "../errors.js";

export interface GrpcTarget {
  /** `host:port` authority passed to grpc-js. */
  authority: string;
  tls: boolean;
  /** Human-readable provenance, printed before the call. */
  source: string;
}

export interface ResolveTargetOptions {
  /** Already-interpolated `url` from the request; may be empty. */
  url: string;
  /** Workspace root, used to read `config/application-local.yml` as a fallback. */
  workspaceRoot: string;
  /** `--url`, highest precedence. */
  override?: string | undefined;
  /** `--tls` / `--insecure`; undefined means "use the heuristic". */
  tlsOverride?: boolean | undefined;
  /** Port to assume when the fallback config has no `grpc.port`. */
  defaultPort?: number;
}

const DEFAULT_GRPC_PORT = 9090;
const LOCAL_CONFIG_REL = join("config", "application-local.yml");
const TLS_HOST_SUFFIXES = [".zalopay.vn"];

interface ParsedAuthority {
  authority: string;
  host: string;
  port: string | undefined;
  scheme: string | undefined;
}

/** Strip any URL scheme and trailing path, leaving a bare gRPC authority. */
export function parseAuthority(raw: string): ParsedAuthority {
  let rest = raw.trim();
  let scheme: string | undefined;

  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
  if (schemeMatch?.[1]) {
    scheme = schemeMatch[1].toLowerCase();
    rest = rest.slice(schemeMatch[0].length);
  }

  // Drop anything after the authority: path, query, fragment.
  rest = rest.split(/[/?#]/, 1)[0] ?? "";

  // Split host:port, being careful with bracketed IPv6 literals.
  let host = rest;
  let port: string | undefined;
  const bracket = rest.startsWith("[") ? rest.indexOf("]") : -1;
  if (bracket !== -1) {
    host = rest.slice(0, bracket + 1);
    const tail = rest.slice(bracket + 1);
    if (tail.startsWith(":")) port = tail.slice(1);
  } else {
    const colon = rest.lastIndexOf(":");
    if (colon !== -1) {
      host = rest.slice(0, colon);
      port = rest.slice(colon + 1);
    }
  }

  return { authority: rest, host, port, scheme };
}

/** TLS on for `:443`, for known TLS-terminated hosts, or for a `grpcs`/`https` scheme. */
export function shouldUseTls({ host, port, scheme }: Pick<ParsedAuthority, "host" | "port" | "scheme">): boolean {
  if (scheme === "grpcs" || scheme === "https") return true;
  if (port === "443") return true;
  const lowerHost = host.toLowerCase();
  return TLS_HOST_SUFFIXES.some((suffix) => lowerHost.endsWith(suffix));
}

/** Reads `grpc.port` out of `config/application-local.yml`, if present. */
export function readLocalGrpcPort(workspaceRoot: string): number | undefined {
  const configPath = join(workspaceRoot, LOCAL_CONFIG_REL);
  if (!existsSync(configPath)) return undefined;
  try {
    const doc = parseYaml(readFileSync(configPath, "utf8")) as { grpc?: { port?: unknown } } | null;
    const port = doc?.grpc?.port;
    const parsed = typeof port === "number" ? port : Number.parseInt(String(port ?? ""), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decide where to send the call.
 *
 * Precedence: `--url` > the request's own `url` > `grpc.port` from
 * `config/application-local.yml` on localhost. The last step exists because the
 * checked-in LOCAL environment ships `grpc_url` empty, which would otherwise make
 * every request unrunnable out of the box.
 */
export function resolveTarget(options: ResolveTargetOptions): GrpcTarget {
  const applyTls = (parsed: ParsedAuthority, source: string): GrpcTarget => {
    if (parsed.authority.length === 0) throw new CliError(`could not determine a gRPC target from ${source}`);
    if (parsed.port === undefined || parsed.port.length === 0) {
      throw new CliError(`gRPC target "${parsed.authority}" from ${source} has no port`, {
        details: ["pass an explicit host:port via --url"],
      });
    }
    return {
      authority: parsed.authority,
      tls: options.tlsOverride ?? shouldUseTls(parsed),
      source,
    };
  };

  if (options.override && options.override.trim().length > 0) {
    return applyTls(parseAuthority(options.override), "--url");
  }
  if (options.url.trim().length > 0) {
    return applyTls(parseAuthority(options.url), "request url");
  }

  const configuredPort = readLocalGrpcPort(options.workspaceRoot);
  const port = configuredPort ?? options.defaultPort ?? DEFAULT_GRPC_PORT;
  const source = configuredPort !== undefined ? `${LOCAL_CONFIG_REL} grpc.port` : "default port";
  return applyTls(parseAuthority(`localhost:${port}`), source);
}
