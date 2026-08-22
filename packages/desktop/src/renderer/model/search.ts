/**
 * Where a search hit lives in the editor.
 *
 * The engine answers a search with a field path - `["scripts", 0, "code"]`, `["auth", "type"]` -
 * because that is what it can honestly say about a YAML document. Turning that into a place the
 * user can look is this file's whole job, and it is a lookup table rather than a clever rule: the
 * sub-tabs are a design decision about where fields belong, not a property of the schema.
 *
 * Pure and no React, so the mapping is a table a test can read.
 */
import type { SubTab } from "@preman/desktop/renderer/stores/tabs.js";

/**
 * Fields the method/URL bar already shows. A hit in one of these needs no navigation at all,
 * so the answer is "leave the sub-tab alone": switching away from what the user was editing to
 * show them something that was never hidden is the worse of the two outcomes.
 */
const BAR_FIELDS = new Set(["url", "method", "methodPath"]);

/**
 * First path segment to sub-tab. `metadata` and `queryParams` share `params` because the editor
 * shows whichever the protocol has there; `message` and `body` share `body` for the same reason.
 */
const SECTION_BY_FIELD: Record<string, SubTab> = {
  queryParams: "params",
  metadata: "params",
  auth: "auth",
  headers: "headers",
  body: "body",
  message: "body",
  scripts: "scripts",
  name: "settings",
  description: "settings",
  settings: "settings",
  schema: "settings",
};

/**
 * The YAML tab is the fallback and not a failure. It is the one place every field is visible, so
 * an unmapped hit still lands somewhere the match can be read - which is more than "the editor
 * opened on whatever tab was last used" would say.
 */
const FALLBACK: SubTab = "yaml";

/**
 * Which sub-tab to open a hit on, or `undefined` to leave the current one alone.
 *
 * A group's definition file has no sub-tabs of its own worth choosing between, but it goes
 * through the same table: a group document carries `auth`, `scripts` and `name` too.
 */
export function sectionFor(fieldPath: readonly (string | number)[]): SubTab | undefined {
  const [head] = fieldPath;
  if (typeof head !== "string") return FALLBACK;
  if (BAR_FIELDS.has(head)) return undefined;
  return SECTION_BY_FIELD[head] ?? FALLBACK;
}

const PATH_SEPARATOR = ".";

/** A field path as one readable token, for the dim breadcrumb on a result row. */
export function describeFieldPath(fieldPath: readonly (string | number)[]): string {
  return fieldPath.map(String).join(PATH_SEPARATOR);
}
