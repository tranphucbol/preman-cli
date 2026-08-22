import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { PremanError } from "@preman/core/errors.js";
import { resourcesFileSchema } from "./schemas.js";
import type { Workspace } from "./discover.js";

export interface Resources {
  workspaceId: string | undefined;
  /** Absolute paths of every declared `.proto` spec. */
  specs: string[];
  /** Candidate proto import roots, best-first, for `protoLoader` `includeDirs`. */
  includeDirs: string[];
}

const PROTO_ROOT_NAMES = new Set(["proto", "protos"]);

const EMPTY_RESOURCES: Resources = { workspaceId: undefined, specs: [], includeDirs: [] };

export function loadResources(ws: Workspace): Resources {
  // HTTP-only workspaces have no `.postman/resources.yaml`; nothing to declare.
  const resourcesPath = ws.resourcesPath;
  if (resourcesPath === undefined || !existsSync(resourcesPath)) return EMPTY_RESOURCES;

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(resourcesPath, "utf8"));
  } catch (cause) {
    throw new PremanError(`failed to parse ${resourcesPath}: ${(cause as Error).message}`);
  }

  const parsed = resourcesFileSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new PremanError(`unexpected shape in ${resourcesPath}`, {
      details: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
    });
  }

  // Spec paths in resources.yaml are relative to the `.postman/` directory itself.
  const specBase = dirname(resourcesPath);
  const specs = (parsed.data.localResources?.specs ?? []).map((p) => resolve(specBase, p));

  return {
    workspaceId: parsed.data.workspace?.id,
    specs,
    includeDirs: deriveIncludeDirs(specs, ws.root),
  };
}

/**
 * Every ancestor directory of every spec, bounded by the workspace root.
 *
 * proto-loader tries include dirs in order and simply fails to resolve against
 * the wrong ones, so over-inclusion is harmless — but ordering still matters when
 * two roots contain the same relative path. Directories literally named `proto`
 * are therefore tried first, then shallower before deeper.
 */
export function deriveIncludeDirs(specPaths: string[], root: string): string[] {
  const found = new Set<string>();

  for (const spec of specPaths) {
    let dir = dirname(resolve(spec));
    for (;;) {
      found.add(dir);
      if (dir === root || relative(root, dir).startsWith("..")) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const depth = (p: string) => p.split(sep).length;
  return [...found].sort((a, b) => {
    const aRoot = PROTO_ROOT_NAMES.has(basename(a)) ? 0 : 1;
    const bRoot = PROTO_ROOT_NAMES.has(basename(b)) ? 0 : 1;
    if (aRoot !== bRoot) return aRoot - bRoot;
    const d = depth(a) - depth(b);
    return d !== 0 ? d : a.localeCompare(b);
  });
}
