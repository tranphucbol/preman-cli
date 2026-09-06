import { renderAuth, SUPPORTED_AUTH_TYPES } from "@preman/core/auth/credentials.js";
import type { VariableStore } from "@preman/core/vars/store.js";
import type { RequestAuth } from "@preman/core/workspace/schemas.js";
import { replaceHeader, type KeyValue } from "./headers.js";

const AUTH_HEADER = "Authorization";
const REPLACED_REMEDY = "delete the auth block to send the header instead";

export { SUPPORTED_AUTH_TYPES };

export interface ApplyAuthOptions {
  auth: RequestAuth | undefined;
  /** Mutated in place; the `auth` block replaces a colliding entry. */
  headers: KeyValue[];
  /** Mutated in place for `apikey` with `in: query`. */
  url: URL;
  store: VariableStore;
}

/**
 * Turn the resolved `auth` block into a header (or query param).
 *
 * The block wins over an authored header of the same name. That is what Postman
 * does — every signer in `postman-runtime` calls `removeHeader(name, {ignoreCase:
 * true})` before adding its own — and what its docs promise: "You can't override
 * headers added by your Authorization selections in the Headers tab." Reading it
 * the other way meant a request whose Auth tab showed the live token sent the
 * stale paste sitting in its headers, and 401'd while looking correct.
 *
 * Opting out is still the block's job, not the header's: `noauth`, an absent
 * block and an empty bearer token all render to `none` and leave the authored
 * header exactly as written. Unknown types are an error rather than a silent
 * unauthenticated call.
 */
export function applyAuth(options: ApplyAuthOptions): string[] {
  const { auth, headers, url, store } = options;
  const { rendered, warnings } = renderAuth(auth, store);

  if (rendered.kind === "none") return warnings;

  if (rendered.kind === "query") {
    // `set` already replaces an authored param, so this path always matched Postman.
    url.searchParams.set(rendered.key, rendered.value);
    return warnings;
  }

  const displaced = replaceHeader(headers, rendered.name, rendered.value);
  if (displaced.length === 0) {
    headers.push({ key: rendered.name, value: rendered.value });
    return warnings;
  }

  // The standard header carries bearer and basic; apikey names its own, so the
  // message has to name whichever one actually clashed.
  const standard = rendered.name === AUTH_HEADER;
  const type = standard ? (auth?.type ?? "").trim().toLowerCase() : "apikey";
  warnings.push(`${type} auth replaced request header "${rendered.name}"; ${REPLACED_REMEDY}`);
  return warnings;
}
