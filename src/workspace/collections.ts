import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CliError } from "../errors.js";
import { collectionDefinitionSchema, folderDefinitionSchema } from "./schemas.js";
import type { Workspace } from "./discover.js";

const REQUEST_SUFFIX = ".request.yaml";
const RESOURCES_DIR = ".resources";
const DEFINITION_FILE = "definition.yaml";

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
}

/** Reads a `.resources/definition.yaml` display name, falling back to the dir name. */
function readDisplayName(dir: string, isCollection: boolean): string {
  const defPath = join(dir, RESOURCES_DIR, DEFINITION_FILE);
  if (!existsSync(defPath)) return basename(dir);
  try {
    const raw = parseYaml(readFileSync(defPath, "utf8")) ?? {};
    const schema = isCollection ? collectionDefinitionSchema : folderDefinitionSchema;
    const parsed = schema.safeParse(raw);
    const name = parsed.success ? parsed.data.name : undefined;
    return name && name.length > 0 ? name : basename(dir);
  } catch {
    return basename(dir);
  }
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

function walk(dir: string, collection: string, folders: string[], out: RequestEntry[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === RESOURCES_DIR || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(full, collection, [...folders, readDisplayName(full, false)], out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(REQUEST_SUFFIX)) continue;

    const header = readRequestHeader(full);
    out.push({
      filePath: full,
      name: header.name,
      kind: header.kind,
      order: header.order,
      collection,
      folders,
      path: [collection, ...folders, header.name].join("/"),
    });
  }
}

/** All requests in the workspace, sorted by collection, folder depth, then Postman `order`. */
export function listRequests(ws: Workspace): RequestEntry[] {
  const collectionsDir = join(ws.postmanDir, "collections");
  if (!existsSync(collectionsDir)) return [];

  const out: RequestEntry[] = [];
  for (const entry of readdirSync(collectionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(collectionsDir, entry.name);
    walk(dir, readDisplayName(dir, true), [], out);
  }

  return out.sort((a, b) => {
    if (a.collection !== b.collection) return a.collection.localeCompare(b.collection);
    const af = a.folders.join("/");
    const bf = b.folders.join("/");
    if (af !== bf) return af.localeCompare(bf);
    // Missing `order` sorts last, then fall back to name for stability.
    const ao = a.order ?? Number.POSITIVE_INFINITY;
    const bo = b.order ?? Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  });
}

export interface RequestGroup {
  /** Slash-joined `collection/folders...`, e.g. `payment` or `payment/nested`. */
  path: string;
  /** Display name of the deepest segment. */
  name: string;
  kind: "collection" | "folder";
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
    const segments = [request.collection, ...request.folders];
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const path = segments.slice(0, depth).join("/");
      let group = byPath.get(path);
      if (group === undefined) {
        group = { path, name: segments[depth - 1]!, kind: depth === 1 ? "collection" : "folder", requests: [] };
        byPath.set(path, group);
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
export type RunTarget =
  | { kind: "request"; entry: RequestEntry }
  | { kind: "group"; group: RequestGroup };

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
