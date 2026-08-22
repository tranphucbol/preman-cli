import { CliError } from "@preman/core/errors.js";
import { interpolateStrict } from "@preman/core/vars/interpolate.js";
import type { VariableStore } from "@preman/core/vars/store.js";
import type { RequestAuth } from "@preman/core/workspace/schemas.js";

const NO_AUTH = "noauth";
const API_KEY_IN_QUERY = "query";
const AUTH_HEADER = "Authorization";
const BEARER_PREFIX = "Bearer";
const BASIC_PREFIX = "Basic";
const BASE64 = "base64";

/** Everything Postman can export that we know how to send. */
export const SUPPORTED_AUTH_TYPES = ["noauth", "bearer", "basic", "apikey"] as const;

export type RenderedAuth =
  { kind: "none" } | { kind: "header"; name: string; value: string } | { kind: "query"; key: string; value: string };

export interface RenderedAuthResult {
  rendered: RenderedAuth;
  warnings: string[];
}

const NONE: RenderedAuth = { kind: "none" };

function credential(auth: RequestAuth, name: string, store: VariableStore): string {
  const raw = auth.credentials?.[name];
  if (raw === undefined || raw === null) return "";
  const text =
    typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" || typeof raw === "bigint"
      ? String(raw)
      : (JSON.stringify(raw) ?? "");
  return interpolateStrict(text, store, `auth ${auth.type}.${name}`);
}

/**
 * Turn an `auth` block into a transport-neutral instruction.
 *
 * HTTP and gRPC both need bearer/basic/apikey rendering, and getting base64 or a
 * prefix subtly different between the two would be a nasty bug to chase — so the
 * credential handling lives here and each transport only decides where to put the
 * result.
 */
export function renderAuth(auth: RequestAuth | undefined, store: VariableStore): RenderedAuthResult {
  if (auth === undefined) return { rendered: NONE, warnings: [] };

  const type = auth.type.trim().toLowerCase();
  if (type.length === 0 || type === NO_AUTH) return { rendered: NONE, warnings: [] };

  if (!SUPPORTED_AUTH_TYPES.includes(type as (typeof SUPPORTED_AUTH_TYPES)[number])) {
    throw new CliError(`auth type "${auth.type}" is not supported`, {
      details: [`supported types: ${SUPPORTED_AUTH_TYPES.join(", ")}`],
    });
  }

  if (type === "bearer") {
    const token = credential(auth, "token", store);
    if (token.length === 0) {
      return { rendered: NONE, warnings: ["bearer token is empty; sending the request unauthenticated"] };
    }
    return { rendered: { kind: "header", name: AUTH_HEADER, value: `${BEARER_PREFIX} ${token}` }, warnings: [] };
  }

  if (type === "basic") {
    const username = credential(auth, "username", store);
    const password = credential(auth, "password", store);
    const encoded = Buffer.from(`${username}:${password}`, "utf8").toString(BASE64);
    return { rendered: { kind: "header", name: AUTH_HEADER, value: `${BASIC_PREFIX} ${encoded}` }, warnings: [] };
  }

  // apikey
  const key = credential(auth, "key", store);
  const value = credential(auth, "value", store);
  if (key.length === 0) {
    return { rendered: NONE, warnings: ["apikey auth has no key; sending the request unauthenticated"] };
  }
  const target = credential(auth, "in", store).trim().toLowerCase();
  if (target === API_KEY_IN_QUERY) return { rendered: { kind: "query", key, value }, warnings: [] };
  return { rendered: { kind: "header", name: key, value }, warnings: [] };
}
