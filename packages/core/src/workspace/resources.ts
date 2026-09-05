import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { PremanError } from "@preman/core/errors.js";
import { withBundledProtoRoot } from "./bundled.js";
import { linkRootFor, ownCheckoutPath, repoRootFor, resolveSharedPath, sharedProtoRoot } from "./links.js";
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
   *
   * preman's own vendored `google/**` root comes last of all, so a repository that ships its
   * own copy still answers first. It is not in {@link Resources.includeDirs} above, which
   * reports the workspace and is printed (ADR 045).
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

/** Which of the resolver's two roots answered for one declared spec. */
/**
 * Which root a declaration was read from — and, when it was the checkout, whether the link
 * held the file too. `both` exists so that a reader is only told about the checkout when the
 * telling is news: on the machine where the link was made it points at that same checkout, and
 * labelling all 24 rows there says nothing (ADR 042).
 */
export type SpecVia = "link" | "own-checkout" | "both";

export interface ResolvedSpec {
  /** Where the declaration reads from on this machine. */
  path: string;
  via: SpecVia;
}

/**
 * Reads one declared spec against the two roots a workspace has: the shared link, and the
 * checkout the workspace itself sits in.
 *
 * The checkout is tried first, and only wins when the file is actually there. Trying it
 * first is what makes a repo-local workspace resolve identically on every machine: were the
 * link to win, a clone's protos would depend on machine-wide state the clone cannot see, so
 * editing a `.proto` on a feature branch would silently read some other checkout's copy.
 * Falling through when the file is absent is the escape hatch that makes that safe — a spec
 * deleted on this branch, or one that genuinely lives in another repository, resolves exactly
 * as it does today (ADR 042).
 */
export function resolveDeclaredSpec(declared: string, sharedRoot: string, repoRoot: string | undefined): ResolvedSpec {
  const linked = resolveSharedPath(declared, sharedRoot);
  if (repoRoot === undefined) return { path: linked, via: "link" };
  const own = ownCheckoutPath(linked, sharedRoot, repoRoot);
  if (own === undefined || !existsSync(own)) return { path: linked, via: "link" };
  return { path: own, via: existsSync(linked) ? "both" : "own-checkout" };
}

const EMPTY_RESOURCES: Resources = {
  workspaceId: undefined,
  specs: [],
  includeDirs: [],
  // An HTTP-only workspace declares no protos, but a caller may still load one by path, and a
  // `google/` import should not depend on whether `resources.yaml` happened to exist.
  includeDirsFor: () => withBundledProtoRoot([]),
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
  // One climb for the whole file, not one per spec: this is the catalog path, and `repoRootFor`
  // costs an `existsSync` per ancestor level.
  const repoRoot = repoRootFor(ws.root);
  const specs = (parsed.data.localResources?.specs ?? [])
    .filter((p) => extname(p).toLowerCase() === PROTO_EXTENSION)
    .map((p) => resolveDeclaredSpec(resolve(specBase, p), sharedRoot, repoRoot).path);

  const pooled = deriveIncludeDirs(specs, ws.root, sharedRoot, repoRoot);

  return {
    workspaceId: parsed.data.workspace?.id,
    specs,
    includeDirs: pooled,
    includeDirsFor: (spec) =>
      withBundledProtoRoot([...new Set([...deriveIncludeDirs([spec], ws.root, sharedRoot, repoRoot), ...pooled])]),
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
 * A spec that is under the workspace's own checkout but outside the workspace root walks to
 * that checkout, for the same reason: the fallback in {@link resolveDeclaredSpec} reads it out
 * of the checkout, and a checkout read directly has to offer the same import roots as the same
 * checkout read through a link, or the include dirs depend on whether someone ran
 * `preman protos link`.
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
function walkBoundary(dir: string, root: string, sharedRoot: string, repoRoot: string | undefined): string {
  if (!relative(root, dir).startsWith("..")) return root;
  // Only reached by a workspace nested below its checkout: when `root` *is* the checkout, the
  // case above already answered.
  if (repoRoot !== undefined && !relative(repoRoot, dir).startsWith("..")) return repoRoot;
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
export function deriveIncludeDirs(
  specPaths: string[],
  root: string,
  sharedRoot: string = sharedProtoRoot(),
  repoRoot?: string,
): string[] {
  const found = new Set<string>();

  for (const spec of specPaths) {
    const start = dirname(resolve(spec));
    const stop = walkBoundary(start, root, sharedRoot, repoRoot);
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
