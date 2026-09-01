import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { PremanError } from "@preman/core/errors.js";
import { linkRootFor, resolveSharedPath, sharedProtoRoot } from "./links.js";
import { resourcesFileSchema } from "./schemas.js";
import type { Workspace } from "./discover.js";

export interface Resources {
  workspaceId: string | undefined;
  /** Absolute paths of every declared `.proto` spec. */
  specs: string[];
  /** Every candidate proto import root in the workspace, best-first. Reported, not loaded against. */
  includeDirs: string[];
  /**
   * The include dirs to load one proto with: its own tree first, the rest of the
   * workspace after.
   *
   * Loading against the pooled list alone is wrong, and measurably so. A bare
   * `import "common.proto"` is resolved by trying include dirs in order, so a
   * `common.proto` belonging to some other declared repository can answer it — which
   * is how `bank-wrapper.proto` lost its own `Ping` and took nine methods with it.
   * Its own tree has to be offered first. The pool stays behind it, because a
   * workspace may legitimately declare a proto that imports from a repository it
   * declares separately, and that resolved before this existed.
   */
  includeDirsFor: (spec: string) => string[];
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
 *
 * Exported because `api/specs.ts` filters the file picker and the folder walk on it. Two
 * constants would let the picker offer a file this loader then drops without a word.
 */
export const PROTO_EXTENSION = ".proto";

const EMPTY_RESOURCES: Resources = {
  workspaceId: undefined,
  specs: [],
  includeDirs: [],
  includeDirsFor: () => [],
};

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
  const sharedRoot = sharedProtoRoot();
  const specs = (parsed.data.localResources?.specs ?? [])
    .filter((p) => extname(p).toLowerCase() === PROTO_EXTENSION)
    .map((p) => resolveSharedPath(resolve(specBase, p), sharedRoot));

  const pooled = deriveIncludeDirs(specs, ws.root, sharedRoot);

  return {
    workspaceId: parsed.data.workspace?.id,
    specs,
    includeDirs: pooled,
    includeDirsFor: (spec) => [...new Set([...deriveIncludeDirs([spec], ws.root, sharedRoot), ...pooled])],
  };
}

/**
 * Where the ancestor walk for one spec stops.
 *
 * A spec inside the workspace walks to the workspace root, as it always has. A spec
 * reached through the shared proto root walks to its link: an entry like
 * `/Users/Shared/postman-protos/acquiring-core` stands for a whole checkout, so its
 * tree is a legitimate set of import roots, and stopping there reproduces exactly the
 * include dirs that same repo gets when the workspace lives inside it.
 *
 * Anything else contributes only the directory it sits in. Walking an arbitrary
 * absolute path further would offer `$HOME` as an import root and let one repo's proto
 * satisfy another's import by accident — and it cannot be inferred from the filesystem
 * either, because incidental symlinks sit above ordinary paths (`/var` is one on
 * macOS), so a "nearest symlink ancestor" rule finds the wrong boundary.
 *
 * The consequence, and the reason a spec is worth putting on a link: an unlinked
 * absolute spec resolves only imports that sit beside it, so a package-qualified
 * `import "zas/common.proto"` fails until its checkout is reachable through the
 * shared root.
 */
function walkBoundary(dir: string, root: string, sharedRoot: string): string {
  if (!relative(root, dir).startsWith("..")) return root;
  return linkRootFor(dir, sharedRoot) ?? dir;
}

/**
 * Every ancestor directory of every spec, bounded by the workspace root or by the
 * shared link the spec is reached through.
 *
 * Over-inclusion is not harmless, whatever an earlier version of this comment said.
 * proto-loader tries include dirs in order and takes the first hit, so a second root
 * holding the same relative path silently answers for the first: two repositories
 * with a `common.proto` are enough to load the wrong one. Ordering is the only
 * defence a pooled list has, and it is not sufficient — which is why a proto is
 * loaded through `includeDirsFor`, with its own tree ahead of this list.
 *
 * Within the list, directories literally named `proto` are tried first, then
 * shallower before deeper.
 */
export function deriveIncludeDirs(specPaths: string[], root: string, sharedRoot: string = sharedProtoRoot()): string[] {
  const found = new Set<string>();

  for (const spec of specPaths) {
    const start = dirname(resolve(spec));
    const stop = walkBoundary(start, root, sharedRoot);
    let dir = start;
    for (;;) {
      found.add(dir);
      if (dir === stop) break;
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
