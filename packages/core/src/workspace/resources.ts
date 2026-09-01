import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
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

/**
 * The only spec kind this engine can load.
 *
 * `localResources.specs` is Postman's list of *every* local API spec a workspace declares,
 * and Postman's API spec feature puts OpenAPI documents in it beside the protos. Handing an
 * `openapi.yaml` to `@grpc/proto-loader` fails with `illegal token 'openapi'`, so a real repo
 * would open with one warning per OpenAPI file it legitimately ships. They are dropped
 * silently rather than warned about: preman having no use for a spec is not the workspace
 * being wrong. The cost is that a genuine `.proto` misnamed `.txt` is now invisible instead
 * of loudly unparseable.
 */
const PROTO_EXTENSION = ".proto";

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
  const specs = (parsed.data.localResources?.specs ?? [])
    .filter((p) => extname(p).toLowerCase() === PROTO_EXTENSION)
    .map((p) => resolve(specBase, p));

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
