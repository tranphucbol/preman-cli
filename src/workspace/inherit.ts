import { originOf, REQUEST_ORIGIN, type ScriptOrigin } from "../scripts/chain.js";
import type { RequestEntry } from "./collections.js";
import type { RequestAuth } from "./schemas.js";

export interface ResolvedAuth {
  auth: RequestAuth;
  origin: ScriptOrigin;
}

/**
 * Postman v2.1 auth inheritance: the request's own block wins — including an
 * explicit `noauth`, which is how a child opts out — otherwise the nearest
 * ancestor that declares one, otherwise unauthenticated.
 *
 * An absent `auth:` key therefore means "inherit", not "send nothing".
 */
export function resolveAuth(entry: RequestEntry, requestAuth: RequestAuth | undefined): ResolvedAuth | undefined {
  if (requestAuth !== undefined) return { auth: requestAuth, origin: REQUEST_ORIGIN };

  for (let i = entry.ancestors.length - 1; i >= 0; i -= 1) {
    const ancestor = entry.ancestors[i]!;
    if (ancestor.auth !== undefined) return { auth: ancestor.auth, origin: originOf(ancestor) };
  }

  return undefined;
}
