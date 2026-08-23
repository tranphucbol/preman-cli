/**
 * Turning `git status` into row decorations.
 *
 * Pure and no React, for the reason every file in `model/` is: the interesting part is the
 * mapping from paths to rows, and a test should be able to state it without mounting a tree.
 *
 * Two facts make this string work rather than a lookup. A node id is a workspace-relative posix
 * path, and so is every path `git status` reports once the host has stripped the repository
 * prefix. So a request's id *is* its path, a group's id is its path minus
 * `GROUP_DEFINITION_SUFFIX`, and an ancestor is a prefix.
 *
 * The roll-up is derived from the paths and not from the decorated nodes, because the interesting
 * case is a file with no row: a deleted request is gone from disk, so `buildCatalog` never saw it,
 * and the only honest place left to say something happened is the folder above it.
 */
import { GROUP_DEFINITION_SUFFIX, type CatalogNode, type GitFileStatus } from "@preman/desktop/engine/protocol.js";

/**
 * What a row shows. Either git's own word for that file, or `descendant`: something below this
 * row changed. The two are one union rather than two lookups so a row can subscribe once.
 */
export type GitDecoration = GitFileStatus | "descendant";

export const DESCENDANT: GitDecoration = "descendant";

const PATH_SEPARATOR = "/";
/** `lastIndexOf` returns this when there is no separator left, which is also the loop's floor. */
const NO_SEPARATOR = -1;

const EMPTY: ReadonlyMap<string, GitDecoration> = new Map();

/**
 * Which rows carry a mark, and which mark.
 *
 * A node's own status always wins over a descendant's: a folder whose definition was edited and
 * whose children were also edited is, first, a folder that was edited.
 */
export function deriveGitDecorations(
  nodes: readonly CatalogNode[],
  files: Readonly<Record<string, GitFileStatus>>,
): ReadonlyMap<string, GitDecoration> {
  const paths = Object.keys(files);
  if (paths.length === 0 || nodes.length === 0) return EMPTY;

  const requests = new Set<string>();
  const groups = new Set<string>();
  for (const node of nodes) {
    if (node.kind === "request") requests.add(node.id);
    else groups.add(node.id);
  }

  const decorations = new Map<string, GitDecoration>();

  // Own status first, so the roll-up below can never overwrite one.
  for (const path of paths) {
    const status = files[path];
    if (status === undefined) continue;
    const nodeId = ownerOf(path, requests, groups);
    if (nodeId !== undefined) decorations.set(nodeId, status);
  }

  for (const path of paths) {
    for (const ancestor of ancestorsOf(path)) {
      if (groups.has(ancestor) && !decorations.has(ancestor)) decorations.set(ancestor, DESCENDANT);
    }
  }

  return decorations;
}

/** The row this exact file belongs to, if any. Not every changed file is a node. */
function ownerOf(path: string, requests: ReadonlySet<string>, groups: ReadonlySet<string>): string | undefined {
  if (requests.has(path)) return path;
  if (!path.endsWith(GROUP_DEFINITION_SUFFIX)) return undefined;
  const directory = path.slice(0, path.length - GROUP_DEFINITION_SUFFIX.length);
  return groups.has(directory) ? directory : undefined;
}

/**
 * Every directory above a path, deepest first. Yielded rather than collected: most of them are
 * not nodes, and for the ones that are the caller only wants to know that they exist.
 */
function* ancestorsOf(path: string): Generator<string> {
  let cut = path.lastIndexOf(PATH_SEPARATOR);
  while (cut > NO_SEPARATOR) {
    yield path.slice(0, cut);
    cut = path.lastIndexOf(PATH_SEPARATOR, cut - 1);
  }
}
