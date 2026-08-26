import { stringify } from "yaml";
import type { ZodType, ZodTypeDef } from "zod";
import { EXIT, PremanError } from "@preman/core/errors.js";
import {
  resolveCollisionWith,
  sanitiseSegment,
  COLLECTIONS_DIR,
  DEFINITION_FILE,
  DOT_POSTMAN_DIR,
  ENVIRONMENT_SUFFIX,
  ENVIRONMENTS_DIR,
  ORDER_STEP,
  POSTMAN_DIR,
  REQUEST_SUFFIX,
  RESOURCES_DIR,
  RESOURCES_FILE,
} from "@preman/core/workspace/paths.js";
import { grpcRequestSchema, httpRequestSchema } from "@preman/core/workspace/schemas.js";
import { cloudCollectionSchema, cloudEnvironmentSchema, parseResponse } from "./model.js";
import type { PostmanSourceItem, PostmanWorkspaceSource } from "./model.js";
import type { FilePlan, PlannedFile, SkippedItem } from "./plan.js";

/**
 * Fetched Postman JSON to a `FilePlan`, and nothing else.
 *
 * Pure: no `node:fs`, no network, no clock (ADR 033). That is what makes
 * `--dry-run` free and the conversion testable against committed fixtures.
 */

const GRPC_KIND = "grpc-request";
const HTTP_KIND = "http-request";
const COLLECTION_KIND = "collection";
const FOLDER_KIND = "folder";
const ENVIRONMENT_KIND = "environment";
/** Everything preman can put in a file. Anything else is skipped, named, not written. */
const WRITTEN_KINDS = new Set([GRPC_KIND, HTTP_KIND]);
/**
 * A folder arrives as `folder`, but Postman writes `$kind: collection` into folder
 * definitions on disk, and a nested `collection` in a tree response means the same thing.
 */
const GROUP_KINDS = new Set([FOLDER_KIND, COLLECTION_KIND]);

/**
 * Postman's identity and cache bookkeeping. Every one of these addresses a row
 * in Postman's storage, so writing it into a file would preserve a pointer to a server the
 * file will never talk to.
 */
const DROPPED_KEYS = new Set([
  "id",
  "parentId",
  "collectionId",
  "workspaceId",
  "owner",
  "isPartial",
  "isStale",
  "examples",
  "__objectPoolBusterKey",
  "meta",
  "createdAt",
  "updatedAt",
  "createdBy",
  "updatedBy",
  "revision",
  "items",
]);
const SCHEMA_KEY = "schema";
const SOURCE_KEY = "source";
const LOCATION_KEY = "location";
const FILE_SOURCE = "file";
/**
 * An environment arrives from the `sync` service rather than the collection one, so it carries
 * that service's own bookkeeping. `color` is not here: it is a label the user chose and Postman
 * Desktop still shows it.
 */
const ENVIRONMENT_DROPPED_KEYS = new Set(["team", "lastUpdatedBy", "lastRevision"]);

const KIND_KEY = "$kind";
const NAME_KEY = "name";
const ORDER_KEY = "order";

/** Field order in a written request file: identity, target, payload, then behaviour. */
const GRPC_KEY_ORDER = [
  KIND_KEY,
  NAME_KEY,
  "description",
  "url",
  "methodPath",
  SCHEMA_KEY,
  "methodDescriptor",
  "message",
  "metadata",
  "auth",
  "settings",
  "scripts",
];
const HTTP_KEY_ORDER = [
  KIND_KEY,
  NAME_KEY,
  "description",
  "method",
  "url",
  "headers",
  "queryParams",
  "body",
  "auth",
  "settings",
  "scripts",
];
const DEFINITION_KEY_ORDER = [KIND_KEY, NAME_KEY, "description", "auth", "scripts", "variables"];
const ENVIRONMENT_KEY_ORDER = [NAME_KEY, "values"];

/** Node ids and plan paths are posix on every host, so a plan means the same thing everywhere. */
const PATH_SEPARATOR = "/";
/**
 * No folding. A gRPC `methodDescriptor` is one base64 line in every real workspace, and a
 * folded one would still parse but would no longer match what Postman wrote — ADR 006 says
 * that value is carried, never regenerated, so it is not reformatted either.
 */
const YAML_OPTIONS = { lineWidth: 0 } as const;

function joinPath(...segments: string[]): string {
  return segments.join(PATH_SEPARATOR);
}

/** A mutable accumulator; `planWorkspace` is pure, its internals need not be. */
interface Accumulator {
  readonly files: PlannedFile[];
  readonly skipped: SkippedItem[];
  readonly counts: Record<string, number>;
  /** Names already claimed, keyed by the directory that holds them. */
  readonly taken: Map<string, Set<string>>;
  /** Every distinct `.proto` a request points at, for `localResources.specs`. */
  readonly specs: Set<string>;
}

function count(acc: Accumulator, kind: string): void {
  acc.counts[kind] = (acc.counts[kind] ?? 0) + 1;
}

/**
 * A free filename in `dir`, following Postman's own ` (2)` convention.
 *
 * Resolved against the plan rather than the filesystem: the directory does not exist yet, and
 * a plan that consulted the disk would stop being a value.
 */
function claim(acc: Accumulator, dir: string, base: string, suffix: string): string {
  let names = acc.taken.get(dir);
  if (names === undefined) {
    names = new Set<string>();
    acc.taken.set(dir, names);
  }
  const names_ = names;
  const chosen = resolveCollisionWith((candidate) => names_.has(candidate.toLowerCase()), base, suffix);
  names_.add(chosen.toLowerCase());
  return chosen;
}

/** `sanitiseSegment`, but the failure says which Postman item caused it. */
function segmentFor(name: string, treePath: string): string {
  try {
    return sanitiseSegment(name);
  } catch (cause) {
    throw new PremanError(`"${treePath}" cannot be written to a file`, {
      exitCode: EXIT.CLI,
      details: [(cause as Error).message, "rename it in Postman and migrate again"],
    });
  }
}

/** Drop Postman's bookkeeping, then order what is left; unknown keys keep their own order, last. */
function shape(raw: Record<string, unknown>, order: readonly string[], extraDropped?: ReadonlySet<string>): unknown {
  const kept = new Map<string, unknown>();
  for (const [key, value] of Object.entries(raw)) {
    if (DROPPED_KEYS.has(key) || extraDropped?.has(key) === true) continue;
    if (value === undefined) continue;
    kept.set(key, value);
  }
  const out: Record<string, unknown> = {};
  for (const key of order) {
    if (kept.has(key)) {
      out[key] = kept.get(key);
      kept.delete(key);
    }
  }
  for (const [key, value] of kept) out[key] = value;
  return out;
}

/**
 * The `.proto` a gRPC request was built from, when Postman recorded a path to one.
 *
 * Postman stores one of two things here: `{source: "file", location: "<absolute path>"}`, a file
 * on the machine that authored the request, or `{source: "api", apiId, versionId}`, which
 * addresses Postman's servers and has no local counterpart. Only the first is kept, and only the
 * two keys preman reads.
 *
 * The path stays absolute on purpose. `resolveMethod` accepts an absolute `schema.location`,
 * prefers the live file over the embedded `methodDescriptor` — the file is current, the
 * descriptor is a snapshot — and falls back to the descriptor with a warning naming the path it
 * could not find. So on the machine that wrote the request this is strictly better than the
 * descriptor, and anywhere else it is one warning that says which `.proto` to go and get. The
 * request is runnable either way (ADR 033).
 */
function protoSchemaOf(detail: unknown): Record<string, string> | undefined {
  if (typeof detail !== "object" || detail === null) return undefined;
  const schema = (detail as Record<string, unknown>)[SCHEMA_KEY];
  if (typeof schema !== "object" || schema === null) return undefined;
  const record = schema as Record<string, unknown>;
  const location = record[LOCATION_KEY];
  if (typeof location !== "string" || location.length === 0) return undefined;
  const source = record[SOURCE_KEY];
  return { [SOURCE_KEY]: typeof source === "string" ? source : FILE_SOURCE, [LOCATION_KEY]: location };
}

/** A planned request file, and the `.proto` it points at if it points at one. */
interface PlannedRequest {
  readonly contents: string;
  readonly spec: string | undefined;
}

/**
 * A request file's text.
 *
 * Validated against the very schema the runner will use on the file, so a payload Postman
 * changed the shape of fails here rather than at the first `preman run`. Almost nothing
 * is transformed: Postman's internal v3 request model *is* preman's request schema, so this is
 * passthrough plus ordering, with `schema` reduced by {@link protoSchemaOf}.
 */
function requestContents(item: PostmanSourceItem, treePath: string, order: number): PlannedRequest {
  const grpc = item.kind === GRPC_KIND;
  // Widened on purpose: the two request schemas have different output types and only their
  // shared `Record` face is used here, to be stripped and reordered.
  const schema: ZodType<Record<string, unknown>, ZodTypeDef, unknown> = grpc ? grpcRequestSchema : httpRequestSchema;
  const parsed = parseResponse(schema, item.detail, treePath);
  const proto = grpc ? protoSchemaOf(parsed) : undefined;
  const shaped = shape(
    {
      ...parsed,
      [KIND_KEY]: item.kind,
      [NAME_KEY]: item.name,
      // An `api`-sourced schema is dropped rather than kept, so `undefined` here is a removal.
      ...(grpc ? { [SCHEMA_KEY]: proto } : {}),
    },
    grpc ? GRPC_KEY_ORDER : HTTP_KEY_ORDER,
  );
  return {
    contents: stringify({ ...(shaped as Record<string, unknown>), [ORDER_KEY]: order }, YAML_OPTIONS),
    spec: proto?.[LOCATION_KEY],
  };
}

/**
 * A collection's or folder's `.resources/definition.yaml`.
 *
 * `$kind: collection` for folders too: that is what real workspaces contain, and
 * `workspace/collections.ts` derives folder-versus-collection from tree position.
 */
function definitionContents(detail: unknown, name: string, treePath: string, order: number): string {
  const parsed: Record<string, unknown> = parseResponse(cloudCollectionSchema, detail, treePath);
  const shaped = shape({ ...parsed, [KIND_KEY]: COLLECTION_KIND, [NAME_KEY]: name }, DEFINITION_KEY_ORDER);
  return stringify({ ...(shaped as Record<string, unknown>), [ORDER_KEY]: order }, YAML_OPTIONS);
}

function environmentContents(detail: unknown, source: string): string {
  const parsed: Record<string, unknown> = parseResponse(cloudEnvironmentSchema, detail, source);
  return stringify(shape(parsed, ENVIRONMENT_KEY_ORDER, ENVIRONMENT_DROPPED_KEYS), YAML_OPTIONS);
}

function planItems(acc: Accumulator, items: readonly PostmanSourceItem[], dir: string, treeDir: string): void {
  items.forEach((item, index) => {
    const order = index * ORDER_STEP;
    const treePath = joinPath(treeDir, item.name);

    if (GROUP_KINDS.has(item.kind)) {
      const segment = claim(acc, dir, segmentFor(item.name, treePath), "");
      const child = joinPath(dir, segment);
      acc.files.push({
        relativePath: joinPath(child, RESOURCES_DIR, DEFINITION_FILE),
        contents: definitionContents(item.detail, item.name, treePath, order),
      });
      count(acc, FOLDER_KIND);
      planItems(acc, item.children, child, treePath);
      return;
    }

    if (!WRITTEN_KINDS.has(item.kind)) {
      acc.skipped.push({ path: treePath, kind: item.kind });
      return;
    }

    const file = claim(acc, dir, segmentFor(item.name, treePath), REQUEST_SUFFIX);
    const planned = requestContents(item, treePath, order);
    acc.files.push({ relativePath: joinPath(dir, file), contents: planned.contents });
    if (planned.spec !== undefined) acc.specs.add(planned.spec);
    count(acc, item.kind);
  });
}

/**
 * Everything a migration would write, as a value.
 *
 * `collections` and `extensibleCollections` have already been flattened into one list by
 * `fetch.ts`: the split is an artefact of Postman's storage model, not of the user's intent,
 * so one Postman workspace becomes one preman workspace (ADR 033).
 */
export function planWorkspace(source: PostmanWorkspaceSource): FilePlan {
  const acc: Accumulator = { files: [], skipped: [], counts: {}, taken: new Map(), specs: new Set() };

  const collectionsDir = joinPath(POSTMAN_DIR, COLLECTIONS_DIR);
  source.collections.forEach((collection, index) => {
    const parsed = parseResponse(cloudCollectionSchema, collection.detail, `collection ${collection.id}`);
    const segment = claim(acc, collectionsDir, segmentFor(parsed.name, parsed.name), "");
    const dir = joinPath(collectionsDir, segment);
    acc.files.push({
      relativePath: joinPath(dir, RESOURCES_DIR, DEFINITION_FILE),
      contents: definitionContents(collection.detail, parsed.name, parsed.name, index * ORDER_STEP),
    });
    count(acc, COLLECTION_KIND);
    planItems(acc, collection.items, dir, parsed.name);
  });

  const environmentsDir = joinPath(POSTMAN_DIR, ENVIRONMENTS_DIR);
  for (const environment of source.environments) {
    const parsed = parseResponse(cloudEnvironmentSchema, environment, "an environment");
    const file = claim(acc, environmentsDir, segmentFor(parsed.name, parsed.name), ENVIRONMENT_SUFFIX);
    acc.files.push({
      relativePath: joinPath(environmentsDir, file),
      contents: environmentContents(environment, parsed.name),
    });
    count(acc, ENVIRONMENT_KIND);
  }

  // Planned last because it reports what the walk found, listed first because that is the file a
  // reader opens first. `localResources.specs` is what gives `deriveIncludeDirs` its roots, so a
  // request whose `schema.location` is kept without it would find the `.proto` and then fail to
  // resolve its imports. Omitted entirely when nothing points at a `.proto`.
  const specs = [...acc.specs].sort();
  acc.files.unshift({
    relativePath: joinPath(DOT_POSTMAN_DIR, RESOURCES_FILE),
    contents: stringify(
      { workspace: { id: source.workspaceId }, ...(specs.length === 0 ? {} : { localResources: { specs } }) },
      YAML_OPTIONS,
    ),
  });

  return { files: acc.files, skipped: acc.skipped, counts: acc.counts };
}
