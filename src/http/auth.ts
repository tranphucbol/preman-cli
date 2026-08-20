import { renderAuth, SUPPORTED_AUTH_TYPES } from "@/auth/credentials.js";
import type { VariableStore } from "@/vars/store.js";
import type { RequestAuth } from "@/workspace/schemas.js";
import { findHeader, type KeyValue } from "./headers.js";

const AUTH_HEADER = "Authorization";

export { SUPPORTED_AUTH_TYPES };

export interface ApplyAuthOptions {
  auth: RequestAuth | undefined;
  /** Mutated in place; an existing `authorization` entry wins. */
  headers: KeyValue[];
  /** Mutated in place for `apikey` with `in: query`. */
  url: URL;
  store: VariableStore;
}

/**
 * Turn the resolved `auth` block into a header (or query param).
 *
 * An explicit `authorization` header always wins: the file said it literally, so
 * overriding it would be surprising. Unknown types are an error rather than a
 * silent unauthenticated call.
 */
export function applyAuth(options: ApplyAuthOptions): string[] {
  const { auth, headers, url, store } = options;
  const { rendered, warnings } = renderAuth(auth, store);

  if (rendered.kind === "none") return warnings;

  if (rendered.kind === "query") {
    url.searchParams.set(rendered.key, rendered.value);
    return warnings;
  }

  // The standard header carries bearer and basic; apikey names its own, so the
  // conflict message has to name whichever one actually clashed.
  const type = (auth?.type ?? "").trim().toLowerCase();
  const existing = findHeader(headers, rendered.name);
  if (existing !== undefined) {
    const standard = rendered.name === AUTH_HEADER;
    const name = standard ? existing.key : rendered.name;
    warnings.push(`request header "${name}" overrides the ${standard ? type : "apikey"} auth block`);
    return warnings;
  }

  headers.push({ key: rendered.name, value: rendered.value });
  return warnings;
}
