import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  compareOrderThenName,
  readRequestHeader,
  type Ordered,
  type RequestHeader,
} from "@preman/core/workspace/collections.js";
import { readGroupDefinition } from "@preman/core/workspace/definitions.js";
import { requireWorkspace, type Workspace } from "@preman/core/workspace/discover.js";
import { listEnvironments } from "@preman/core/workspace/environments.js";
import { nodeIdFor } from "@preman/core/workspace/paths.js";
import { loadResources } from "@preman/core/workspace/resources.js";
import type { SnapshotEnvironment } from "@preman/core/api/inspect.js";

const COLLECTIONS_DIR = "collections";
const ENVIRONMENTS_DIR = "environments";
const RESOURCES_DIR = ".resources";
const DEFINITION_FILE = "definition.yaml";
const REQUEST_SUFFIX = ".request.yaml";
const WORKSPACE_RESOURCES_FILE = "resources.yaml";
const COLLECTION_DEPTH = 0;
const FIRST_REVISION = 1;
/**
 * Stands in for a missing `order`. `Infinity` would sort the same but does not
 * survive JSON, and this shape crosses a process boundary.
 *
 * Exported because anything planning a reorder has to recognise it: a sibling that
 * declares no order sorts after every sibling that does, so no number can be placed
 * after it and the only honest answer is to renumber.
 */
export const ORDER_ABSENT = Number.MAX_SAFE_INTEGER;

export type CatalogNodeKind = "collection" | "folder" | "request";
export type CatalogProtocol = "http" | "grpc" | "unsupported";

/** The request kinds the engine can actually send; everything else is `unsupported`. */
const PROTOCOL_BY_KIND: Record<string, CatalogProtocol> = {
  "http-request": "http",
  "grpc-request": "grpc",
};

/**
 * One row of the sidebar.
 *
 * Flat on purpose: a nested tree cannot be virtualized without walking it, so the
 * shape carries structure in `parentId` and `depth` and leaves collapse to a filter.
 */
export interface CatalogNode {
  /** Posix path relative to the workspace root — stable across a reindex. */
  id: string;
  kind: CatalogNodeKind;
  name: string;
  /** Absolute path: the request file, or the group's own directory. */
  file: string;
  parentId: string | null;
  depth: number;
  /**
   * The YAML `order`, or {@link ORDER_ABSENT} when the file declares none. Raw
   * rather than a sibling index so a reorder can insert into an existing gap and
   * a refresh can tell that a node moved. Position is the array index; `nodes` is
   * already sorted.
   */
  order: number;
  protocol?: CatalogProtocol;
  /** "GET", or the method tail for gRPC. */
  label?: string;
}

export interface Catalog {
  root: string;
  workspaceId: string | null;
  /** Bumped by every refresh, so a renderer can drop a stale push. */
  revision: number;
  /** Flattened, pre-sorted in Postman order: a group immediately precedes its subtree. */
  nodes: CatalogNode[];
  environments: SnapshotEnvironment[];
  specs: string[];
}

function orderOf(declared: number | undefined): number {
  return declared ?? ORDER_ABSENT;
}

/** One level of the tree, resolved but not yet emitted. */
interface Child extends Ordered {
  emit: (parentId: string, depth: number, out: CatalogNode[]) => Promise<void>;
}

function requestNode(
  root: string,
  file: string,
  header: RequestHeader,
  parentId: string | null,
  depth: number,
): CatalogNode {
  return {
    id: nodeIdFor(root, file),
    kind: "request",
    name: header.name,
    file,
    parentId,
    depth,
    order: orderOf(header.order),
    protocol: PROTOCOL_BY_KIND[header.kind] ?? "unsupported",
    label: header.label,
  };
}

/**
 * Read one directory into its ordered children.
 *
 * `readdir` is the one await: the directory walk is what scales with workspace
 * size, while a YAML parse is CPU-bound and gains nothing from a promise. Core
 * stays synchronous everywhere else.
 */
async function readChildren(root: string, dir: string, parentPath: string): Promise<Child[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const children: Child[] = [];

  for (const entry of entries) {
    if (entry.name === RESOURCES_DIR || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      const definition = readGroupDefinition(full, parentPath, "folder");
      children.push({
        order: definition.order,
        name: definition.name,
        emit: (parentId, depth, out) => emitGroup(root, full, definition, "folder", parentId, depth, out),
      });
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(REQUEST_SUFFIX)) continue;

    const header = readRequestHeader(full);
    children.push({
      order: header.order,
      name: header.name,
      emit: (parentId, depth, out) => {
        out.push(requestNode(root, full, header, parentId, depth));
        return Promise.resolve();
      },
    });
  }

  children.sort(compareOrderThenName);
  return children;
}

/** A group and its whole subtree, appended in pre-order so the parent precedes its rows. */
async function emitGroup(
  root: string,
  dir: string,
  definition: { name: string; order: number | undefined; path: string },
  kind: "collection" | "folder",
  parentId: string | null,
  depth: number,
  out: CatalogNode[],
): Promise<void> {
  const id = nodeIdFor(root, dir);
  out.push({ id, kind, name: definition.name, file: dir, parentId, depth, order: orderOf(definition.order) });

  for (const child of await readChildren(root, dir, definition.path)) {
    await child.emit(id, depth + 1, out);
  }
}

async function buildNodes(ws: Workspace): Promise<CatalogNode[]> {
  const collectionsDir = join(ws.postmanDir, COLLECTIONS_DIR);
  if (!existsSync(collectionsDir)) return [];

  const collections = (await readdir(collectionsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const dir = join(collectionsDir, entry.name);
      return { dir, definition: readGroupDefinition(dir, undefined, "collection") };
    })
    .sort((a, b) => compareOrderThenName(a.definition, b.definition));

  const nodes: CatalogNode[] = [];
  for (const { dir, definition } of collections) {
    await emitGroup(ws.root, dir, definition, "collection", null, COLLECTION_DEPTH, nodes);
  }
  return nodes;
}

/** Everything in a catalog that is not a node: read together because they are read together. */
function readSurroundings(ws: Workspace): Pick<Catalog, "workspaceId" | "environments" | "specs"> {
  const resources = loadResources(ws);
  return {
    workspaceId: resources.workspaceId ?? null,
    environments: listEnvironments(ws).map((environment) => ({
      name: environment.name,
      file: environment.filePath,
      keys: Object.keys(environment.values),
    })),
    specs: resources.specs,
  };
}

/** Read a whole workspace into the flat shape a virtualized sidebar renders. */
export async function buildCatalog(dir: string): Promise<Catalog> {
  const ws = requireWorkspace(dir);
  return {
    root: ws.root,
    revision: FIRST_REVISION,
    ...readSurroundings(ws),
    nodes: await buildNodes(ws),
  };
}

/** What a set of changed paths invalidates. */
interface Invalidation {
  /** Environments, specs or the workspace id — none of which move a node. */
  surroundings: boolean;
  /** Request files whose node can be re-read where it already sits. */
  requests: string[];
  /** Anything that can add, remove or move a node. Only a rebuild can place those. */
  structure: boolean;
}

function classify(prev: Catalog, changed: string[]): Invalidation {
  const byFile = new Map(prev.nodes.filter((node) => node.kind === "request").map((node) => [node.file, node]));
  const invalidation: Invalidation = { surroundings: false, requests: [], structure: false };

  for (const path of changed) {
    const id = nodeIdFor(prev.root, path);

    if (id.startsWith("..")) {
      // Outside the root. A watcher should never report this, so rebuild rather than guess.
      invalidation.structure = true;
    } else if (id.split("/").includes(ENVIRONMENTS_DIR) || id.endsWith(WORKSPACE_RESOURCES_FILE)) {
      invalidation.surroundings = true;
    } else if (id.endsWith(`${RESOURCES_DIR}/${DEFINITION_FILE}`) || !id.endsWith(REQUEST_SUFFIX)) {
      // A definition carries its group's name and `order`, so its subtree can reorder.
      invalidation.structure = true;
    } else {
      const known = byFile.get(path);
      // Unknown file, or one that has since gone: both change the shape of the tree.
      if (known === undefined || !existsSync(path)) invalidation.structure = true;
      else invalidation.requests.push(path);
    }
  }

  return invalidation;
}

/**
 * Re-read only what `changed` invalidated, and bump `revision`.
 *
 * Nodes that were not re-read keep their previous object identity. That is both the
 * point and how a caller can tell what actually moved.
 */
export async function refreshCatalog(prev: Catalog, changed: string[]): Promise<Catalog> {
  const invalidation = classify(prev, changed);
  const revision = prev.revision + 1;

  const rewritten = new Map<string, CatalogNode>();
  for (const file of invalidation.requests) {
    const previous = byFileOrThrow(prev, file);
    const header = readRequestHeader(file);
    // A new name or `order` re-sorts the node among its siblings; only a rebuild places it.
    if (header.name !== previous.name || orderOf(header.order) !== previous.order) {
      invalidation.structure = true;
      break;
    }
    rewritten.set(file, {
      ...previous,
      protocol: PROTOCOL_BY_KIND[header.kind] ?? "unsupported",
      label: header.label,
    });
  }

  if (invalidation.structure) return { ...(await buildCatalog(prev.root)), revision };

  const ws = invalidation.surroundings ? requireWorkspace(prev.root) : undefined;
  return {
    ...prev,
    ...(ws === undefined ? {} : readSurroundings(ws)),
    revision,
    nodes: rewritten.size === 0 ? prev.nodes : prev.nodes.map((node) => rewritten.get(node.file) ?? node),
  };
}

function byFileOrThrow(catalog: Catalog, file: string): CatalogNode {
  const node = catalog.nodes.find((candidate) => candidate.file === file);
  // classify() only forwards files it found, so this is a broken invariant, not user error.
  if (node === undefined) throw new Error(`catalog has no node for ${file}`);
  return node;
}
