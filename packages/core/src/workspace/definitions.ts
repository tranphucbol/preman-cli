import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PremanError } from "@preman/core/errors.js";
import { groupDefinitionSchema } from "./schemas.js";
import type { RequestAuth, RequestScript } from "./schemas.js";

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
    filePath,
  };
}
