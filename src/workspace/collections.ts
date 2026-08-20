import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CliError } from "@/errors.js";
import { readGroupDefinition } from "./definitions.js";
import type { GroupDefinition } from "./definitions.js";
import type { Workspace } from "./discover.js";

const REQUEST_SUFFIX = ".request.yaml";
const RESOURCES_DIR = ".resources";
const COLLECTIONS_DIR = "collections";

export interface RequestEntry {
  /** Absolute path of the `*.request.yaml` file. */
  filePath: string;
  /** `name` from the YAML, falling back to the filename. */
  name: string;
  /** e.g. `grpc-request`, `http-request`. */
  kind: string;
  /** Postman sort key; missing values sort last. */
  order: number | undefined;
  /** Owning collection display name. */
  collection: string;
  /** Nested folder display names between collection and request. */
  folders: string[];
  /** Slash-joined `collection/folders.../name`, used for lookup and display. */
  path: string;
  /** Collection first, then each folder outermost to innermost. Never empty. */
  ancestors: GroupDefinition[];
}

function readRequestHeader(filePath: string): { name: string; kind: string; order: number | undefined } {
  const fallbackName = basename(filePath).slice(0, -REQUEST_SUFFIX.length);
  let raw: Record<string, unknown>;
  try {
    raw = (parseYaml(readFileSync(filePath, "utf8")) ?? {}) as Record<string, unknown>;
  } catch (cause) {
    throw new CliError(`failed to parse ${filePath}: ${(cause as Error).message}`);
  }
  return {
    name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : fallbackName,
    kind: typeof raw.$kind === "string" ? raw.$kind : "unknown",
    order: typeof raw.order === "number" ? raw.order : undefined,
  };
}

/**
 * One entry at a level of the tree: a request, or a folder to descend into.
 * Both carry the two keys Postman sorts siblings by.
 */
interface Sibling {
  order: number | undefined;
  name: string;
  emit: (out: RequestEntry[]) => void;
}

/** Postman sibling order: `order` ascending with missing last, then name. */
function compareSiblings(a: Sibling, b: Sibling): number {
  const ao = a.order ?? Number.POSITIVE_INFINITY;
  const bo = b.order ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao - bo;
  return a.name.localeCompare(b.name);
}

function walk(dir: string, ancestors: GroupDefinition[], out: RequestEntry[]): void {
  const parent = ancestors[ancestors.length - 1]!;
  const siblings: Sibling[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === RESOURCES_DIR || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      // Depth decides `kind`, not `$kind`: real workspaces write `$kind: collection`
      // on folders too, so the file cannot discriminate.
      const definition = readGroupDefinition(full, parent.path, "folder");
      siblings.push({
        order: definition.order,
        name: definition.name,
        emit: (target) => walk(full, [...ancestors, definition], target),
      });
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(REQUEST_SUFFIX)) continue;

    const header = readRequestHeader(full);
    const [collection, ...folders] = ancestors;
    const request: RequestEntry = {
      filePath: full,
      name: header.name,
      kind: header.kind,
      order: header.order,
      collection: collection!.name,
      folders: folders.map((folder) => folder.name),
      path: `${parent.path}/${header.name}`,
      ancestors,
    };
    siblings.push({ order: header.order, name: header.name, emit: (target) => target.push(request) });
  }

  siblings.sort(compareSiblings);
  for (const sibling of siblings) sibling.emit(out);
}

/**
 * All requests in the workspace, in Postman run order.
 *
 * Run order is a tree walk, not a flat sort: at every level requests and
 * subfolders interleave by `order`, so a folder with `order: 1000` runs before a
 * sibling request with `order: 3000`.
 */
export function listRequests(ws: Workspace): RequestEntry[] {
  const collectionsDir = join(ws.postmanDir, COLLECTIONS_DIR);
  if (!existsSync(collectionsDir)) return [];

  const collections: Sibling[] = [];
  for (const entry of readdirSync(collectionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(collectionsDir, entry.name);
    const definition = readGroupDefinition(dir, undefined, "collection");
    collections.push({
      order: definition.order,
      name: definition.name,
      emit: (target) => walk(dir, [definition], target),
    });
  }

  collections.sort(compareSiblings);
  const out: RequestEntry[] = [];
  for (const collection of collections) collection.emit(out);
  return out;
}

export interface RequestGroup {
  /** Slash-joined `collection/folders...`, e.g. `payment` or `payment/nested`. */
  path: string;
  /** Display name of the deepest segment. */
  name: string;
  kind: "collection" | "folder";
  /** The group's own `.resources/definition.yaml`: scripts, auth and `order`. */
  definition: GroupDefinition;
  /** Every request beneath the group, nested folders included, in run order. */
  requests: RequestEntry[];
}

/**
 * Every collection and folder that holds at least one request, keyed by path.
 *
 * A request contributes to each of its ancestors, so `payment/nested/Deep Echo`
 * produces both a `payment` group and a `payment/nested` group. `requests` keeps
 * the incoming order, which {@link listRequests} has already sorted into run order.
 */
export function listGroups(requests: RequestEntry[]): RequestGroup[] {
  const byPath = new Map<string, RequestGroup>();

  for (const request of requests) {
    for (const ancestor of request.ancestors) {
      let group = byPath.get(ancestor.path);
      if (group === undefined) {
        group = {
          path: ancestor.path,
          name: ancestor.name,
          kind: ancestor.kind,
          definition: ancestor,
          requests: [],
        };
        byPath.set(ancestor.path, group);
      }
      group.requests.push(request);
    }
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export interface ResolveResult {
  match: RequestEntry | undefined;
  /** Populated when the selector was ambiguous. */
  candidates: RequestEntry[];
}

/**
 * Resolve a user selector against the request list.
 *
 * Tries, in order: exact full path, exact name, path suffix, then substring —
 * all case-insensitive. Stops at the first tier that produces any match so a
 * precise selector is never diluted by fuzzy hits.
 */
export function resolveRequest(requests: RequestEntry[], selector: string): ResolveResult {
  const needle = selector.trim().toLowerCase();
  if (needle.length === 0) return { match: undefined, candidates: [] };

  const tiers: Array<(r: RequestEntry) => boolean> = [
    (r) => r.path.toLowerCase() === needle,
    (r) => r.name.toLowerCase() === needle,
    (r) => r.path.toLowerCase().endsWith(`/${needle}`),
    (r) => r.path.toLowerCase().includes(needle),
  ];

  for (const predicate of tiers) {
    const hits = requests.filter(predicate);
    if (hits.length === 1) return { match: hits[0], candidates: hits };
    if (hits.length > 1) return { match: undefined, candidates: hits };
  }
  return { match: undefined, candidates: [] };
}

/** What a selector resolved to: one request, or a whole collection/folder. */
export type RunTarget = { kind: "request"; entry: RequestEntry } | { kind: "group"; group: RequestGroup };

export function targetPath(target: RunTarget): string {
  return target.kind === "request" ? target.entry.path : target.group.path;
}

/** Human label used in pickers and ambiguity errors. */
export function targetLabel(target: RunTarget): string {
  if (target.kind === "request") {
    return target.entry.kind === "grpc-request" ? target.entry.path : `${target.entry.path} (${target.entry.kind})`;
  }
  const { group } = target;
  const count = group.requests.length;
  return `${group.path} (${group.kind}, ${count} ${count === 1 ? "request" : "requests"})`;
}

export interface SelectorResolution {
  target: RunTarget | undefined;
  /** Populated when the selector matched more than one thing. */
  candidates: RunTarget[];
}

/**
 * Resolve a selector to a single request or to a collection/folder to run whole.
 *
 * Tiers, stopping at the first that produces any match: exact request path,
 * exact group path, exact request name, exact group name, request path suffix,
 * group path suffix, then request substring. Groups deliberately stop before the
 * substring tier — `preman run pay` should still mean the one request whose path
 * contains `pay`, not silently fan out to a whole collection.
 */
export function resolveSelector(requests: RequestEntry[], selector: string): SelectorResolution {
  const needle = selector.trim().toLowerCase();
  if (needle.length === 0) return { target: undefined, candidates: [] };

  const groups = listGroups(requests);
  const asRequest = (entry: RequestEntry): RunTarget => ({ kind: "request", entry });
  const asGroup = (group: RequestGroup): RunTarget => ({ kind: "group", group });

  const tiers: Array<() => RunTarget[]> = [
    () => requests.filter((r) => r.path.toLowerCase() === needle).map(asRequest),
    () => groups.filter((g) => g.path.toLowerCase() === needle).map(asGroup),
    () => requests.filter((r) => r.name.toLowerCase() === needle).map(asRequest),
    () => groups.filter((g) => g.name.toLowerCase() === needle).map(asGroup),
    () => requests.filter((r) => r.path.toLowerCase().endsWith(`/${needle}`)).map(asRequest),
    () => groups.filter((g) => g.path.toLowerCase().endsWith(`/${needle}`)).map(asGroup),
    () => requests.filter((r) => r.path.toLowerCase().includes(needle)).map(asRequest),
  ];

  for (const tier of tiers) {
    const hits = tier();
    if (hits.length === 1) return { target: hits[0], candidates: hits };
    if (hits.length > 1) return { target: undefined, candidates: hits };
  }
  return { target: undefined, candidates: [] };
}
