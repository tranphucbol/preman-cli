import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PremanError } from "@preman/core/errors.js";
import { groupDefinitionSchema } from "./schemas.js";
import type { GroupDefinitionFile, RequestAuth, RequestScript } from "./schemas.js";

const RESOURCES_DIR = ".resources";
const DEFINITION_FILE = "definition.yaml";

export type GroupKind = "collection" | "folder";

/**
 * A collection's or folder's `.resources/definition.yaml`, parsed in full.
 *
 * Postman lets a group declare `scripts` and `auth` that every descendant request
 * inherits, plus an `order` that positions the group among its siblings.
 */
export interface GroupDefinition {
  /** Slash-joined path, identical to the matching {@link RequestGroup.path}. */
  path: string;
  name: string;
  kind: GroupKind;
  order: number | undefined;
  scripts: RequestScript[];
  auth: RequestAuth | undefined;
  /**
   * The enabled `variables:` rows, coerced to strings. Read on every group, but only the
   * collection's are a scope: Postman has no folder variables, and `collectionVariablesOf`
   * reads the first ancestor and no other.
   */
  variables: Record<string, string>;
  /** Absolute path of `.resources/definition.yaml`, for error messages. */
  filePath: string | undefined;
}

/**
 * Read a group's definition file.
 *
 * A missing file is normal and yields the directory basename with no scripts or
 * auth. A file that exists but does not parse is a `PremanError`: it may carry the
 * auth and scripts every request beneath it depends on, so falling back to the
 * basename would turn a typo into an unexplained 401.
 *
 * Takes `parentPath` rather than the group's own path because `path` ends in the
 * *display* name, which only this function can know.
 */
export function readGroupDefinition(dir: string, parentPath: string | undefined, kind: GroupKind): GroupDefinition {
  const fallbackName = basename(dir);
  const filePath = join(dir, RESOURCES_DIR, DEFINITION_FILE);
  const pathOf = (name: string): string => (parentPath === undefined ? name : `${parentPath}/${name}`);
  if (!existsSync(filePath)) {
    return {
      path: pathOf(fallbackName),
      name: fallbackName,
      kind,
      order: undefined,
      scripts: [],
      auth: undefined,
      variables: {},
      filePath: undefined,
    };
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(filePath, "utf8")) ?? {};
  } catch (cause) {
    throw new PremanError(`failed to parse ${filePath}: ${(cause as Error).message}`);
  }

  const parsed = groupDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PremanError(`failed to read ${filePath}`, {
      details: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    });
  }

  const declared = parsed.data.name;
  const name = declared !== undefined && declared.length > 0 ? declared : fallbackName;
  return {
    path: pathOf(name),
    name,
    kind,
    order: parsed.data.order,
    scripts: parsed.data.scripts ?? [],
    auth: parsed.data.auth,
    variables: enabledVariables(parsed.data.variables ?? []),
    filePath,
  };
}

type VariableRow = NonNullable<GroupDefinitionFile["variables"]>[number];

function enabledVariables(rows: readonly VariableRow[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const row of rows) {
    if (row.enabled === false || row.disabled === true) continue;
    values[row.key] = stringify(row.value);
  }
  return values;
}

/** An object value is kept as JSON, the way Postman's own UI shows one, not as `[object Object]`. */
function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value.toString();
  return JSON.stringify(value);
}

/**
 * The collection scope of a request or group run: its collection's `variables:`.
 * Empty when there are no ancestors, which a request outside any collection has.
 */
export function collectionVariablesOf(ancestors: readonly GroupDefinition[]): Record<string, string> {
  return ancestors[0]?.variables ?? {};
}
