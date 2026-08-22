import type { ScriptOrigin } from "@preman/core/scripts/chain.js";

/**
 * Decision 8: only a non-request origin is named. Inheritance must not reformat the output
 * of the request-level scripts that were the only kind preman used to run.
 *
 * Shared by every reporter so a collection-level test reads the same in the terminal, in
 * JUnit XML and in the desktop app.
 */
export function originTag(origin: ScriptOrigin): string {
  return origin.level === "request" ? "" : ` [${origin.label}]`;
}
