import { CliError } from "../errors.js";
import { interpolateStrict } from "../vars/interpolate.js";
import type { VariableStore } from "../vars/store.js";
import type { HttpRequest } from "../workspace/schemas.js";
import { findHeader, type KeyValue } from "./headers.js";

const AUTH_HEADER = "Authorization";
const NO_AUTH = "noauth";
const API_KEY_IN_QUERY = "query";

/** Everything Postman can export that we know how to send. */
export const SUPPORTED_AUTH_TYPES = ["noauth", "bearer", "basic", "apikey"] as const;

export interface ApplyAuthOptions {
  auth: HttpRequest["auth"];
  /** Mutated in place; an existing `authorization` entry wins. */
  headers: KeyValue[];
  /** Mutated in place for `apikey` with `in: query`. */
  url: URL;
  store: VariableStore;
}

function credential(auth: NonNullable<HttpRequest["auth"]>, name: string, store: VariableStore): string {
  const raw = auth.credentials?.[name];
  if (raw === undefined || raw === null) return "";
  const text = typeof raw === "string" ? raw : String(raw);
  return interpolateStrict(text, store, `auth ${auth.type}.${name}`);
}

/**
 * Turn the request's `auth` block into a header (or query param).
 *
 * An explicit `authorization` header always wins: the file said it literally, so
 * overriding it would be surprising. Unknown types are an error rather than a
 * silent unauthenticated call.
 */
export function applyAuth(options: ApplyAuthOptions): string[] {
  const { auth, headers, url, store } = options;
  if (auth === undefined) return [];

  const type = auth.type.trim().toLowerCase();
  if (type.length === 0 || type === NO_AUTH) return [];

  if (!SUPPORTED_AUTH_TYPES.includes(type as (typeof SUPPORTED_AUTH_TYPES)[number])) {
    throw new CliError(`auth type "${auth.type}" is not supported`, {
      details: [`supported types: ${SUPPORTED_AUTH_TYPES.join(", ")}`],
    });
  }

  const warnings: string[] = [];
  const setAuthHeader = (value: string): void => {
    const existing = findHeader(headers, AUTH_HEADER);
    if (existing !== undefined) {
      warnings.push(`request header "${existing.key}" overrides the ${type} auth block`);
      return;
    }
    headers.push({ key: AUTH_HEADER, value });
  };

  if (type === "bearer") {
    const token = credential(auth, "token", store);
    if (token.length === 0) {
      warnings.push("bearer token is empty; sending the request unauthenticated");
      return warnings;
    }
    setAuthHeader(`Bearer ${token}`);
    return warnings;
  }

  if (type === "basic") {
    const username = credential(auth, "username", store);
    const password = credential(auth, "password", store);
    setAuthHeader(`Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`);
    return warnings;
  }

  // apikey
  const key = credential(auth, "key", store);
  const value = credential(auth, "value", store);
  if (key.length === 0) {
    warnings.push("apikey auth has no key; sending the request unauthenticated");
    return warnings;
  }
  const target = String(auth.credentials?.["in"] ?? "").trim().toLowerCase();
  if (target === API_KEY_IN_QUERY) {
    url.searchParams.set(key, value);
    return warnings;
  }
  if (findHeader(headers, key) !== undefined) {
    warnings.push(`request header "${key}" overrides the apikey auth block`);
    return warnings;
  }
  headers.push({ key, value });
  return warnings;
}
