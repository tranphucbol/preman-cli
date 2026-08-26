import {
  cloudCollectionSchema,
  cloudEnvironmentSchema,
  itemDetailSchema,
  parseResponse,
  unwrapEnvelope,
  workspaceListSchema,
  workspaceSchema,
} from "./model.js";
import { NO_PROGRESS } from "./progress.js";
import { COLLECTION_SERVICE, SYNC_SERVICE, WORKSPACES_SERVICE } from "./proxy.js";
import type { ProgressTracker } from "./progress.js";
import type {
  CloudCollectionDetail,
  CloudItemDetail,
  CloudItemStub,
  CloudWorkspace,
  CloudWorkspaceDetail,
  PostmanSourceCollection,
  PostmanSourceItem,
  PostmanWorkspaceSource,
} from "./model.js";
import type { ProxyClient } from "./proxy.js";

/**
 * Walking a cloud workspace: five call shapes, in the order they depend on each other.
 *
 * The reason this file exists is one line of it — `extensibleCollections` is enumerated beside
 * `collections`. Postman's public API returns only the first array, with nothing in the response
 * indicating the second exists, and every gRPC request lives in the second (ADR 033).
 */

const WORKSPACES_PATH = "/workspaces";
const PERSONAL_TYPE = "personal";
const TEAM_TYPE = "team";
/** Where a phase's completed count starts. */
const NOTHING = 0;

/**
 * Postman's v3 model has no folders: a group nested inside a collection is itself a
 * `collection`, and `x-entity-type: folder` is not even in the accepted set.
 *
 * The wire keeps Postman's word and the plan keeps preman's: a nested group is reported and
 * written as a folder, because "3 collections, 41 folders" is what a user recognises, while
 * `COLLECTION_ENTITY` is what the read must claim.
 */
const COLLECTION_ENTITY = "collection";
const FOLDER_KIND = "folder";

function workspacePath(workspaceId: string): string {
  // What Postman's own client sends. It does *not* populate the dependency lists — those come
  // back as ids either way — but it is the shape the proxy allowlists, so it is sent verbatim.
  return `/workspace/${workspaceId}?populate=true`;
}

function environmentPath(environmentId: string): string {
  return `/environment/${environmentId}`;
}

function collectionPath(collectionId: string): string {
  return `/v3/collections/${collectionId}`;
}

function itemPath(collectionId: string, itemId: string): string {
  return `/v3/collections/${collectionId}/items/${itemId}`;
}

/**
 * How many proxy calls are allowed in flight at once.
 *
 * The driving workspace is 684 requests and 93 nested groups across 41 collections, one read
 * each — 822 with the workspace itself and its three environments. A naive fan-out would open
 * that many sockets against an undocumented proxy, which is both rude and the fastest way to be
 * rate limited; one at a time would take minutes. Eight is the compromise, and it is a constant
 * so that the next person tuning it can see there is a reason for it.
 */
const MAX_IN_FLIGHT = 8;

/**
 * The same client, admitting only `MAX_IN_FLIGHT` calls at a time.
 *
 * The ceiling belongs here rather than in the walk because the walk is recursive: a bounded
 * `map` whose worker recurses into another bounded `map` fans out to the *product* of the two,
 * and this tree nests four deep. One semaphore over every call holds the real number at eight
 * whatever shape the tree turns out to be, which leaves the walk free to say `Promise.all` and
 * mean it.
 *
 * It is also the one place every read passes through, so it is where reads are counted. Counting
 * at the call sites instead would mean four of them and a number threaded between, and the first
 * one anybody forgot would make the liveness signal quietly wrong.
 */
function gated(proxy: ProxyClient, progress: ProgressTracker): ProxyClient {
  let inFlight = 0;
  const waiting: (() => void)[] = [];
  return async (call) => {
    if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((admit) => waiting.push(admit));
    else inFlight += 1;
    try {
      const payload = await proxy(call);
      // Counted after it lands, so `calls` means reads that answered. A read that throws aborts
      // the migration, so there is no case where the difference is a number anyone sees.
      progress.read();
      return payload;
    } finally {
      // Hand the slot straight to the next waiter rather than releasing and re-acquiring it,
      // so the count can never dip and let a ninth call in.
      const next = waiting.shift();
      if (next === undefined) inFlight -= 1;
      else next();
    }
  };
}

/** The envelope keys the proxy has been seen to wrap payloads in. */
const DATA_KEY = "data";
const WORKSPACE_KEY = "workspace";
const WORKSPACES_KEY = "workspaces";
const COLLECTION_KEY = "collection";
const ENVIRONMENT_KEY = "environment";

function parseWorkspace(payload: unknown): CloudWorkspaceDetail {
  return parseResponse(workspaceSchema, unwrapEnvelope(unwrapEnvelope(payload, DATA_KEY), WORKSPACE_KEY), "workspace");
}

function parseCollection(payload: unknown, collectionId: string): CloudCollectionDetail {
  return parseResponse(
    cloudCollectionSchema,
    unwrapEnvelope(unwrapEnvelope(payload, DATA_KEY), COLLECTION_KEY),
    collectionPath(collectionId),
  );
}

function parseItem(payload: unknown, collectionId: string, itemId: string): CloudItemDetail {
  return parseResponse(itemDetailSchema, unwrapEnvelope(payload, DATA_KEY), itemPath(collectionId, itemId));
}

function parseEnvironment(payload: unknown, environmentId: string): unknown {
  return parseResponse(
    cloudEnvironmentSchema,
    unwrapEnvelope(unwrapEnvelope(payload, DATA_KEY), ENVIRONMENT_KEY),
    environmentPath(environmentId),
  );
}

/**
 * Fetch one item and everything under it, one read per node.
 *
 * A read per node is not a missed batching opportunity, it is the only way to learn a name: the
 * parent's `items` array carries `{id, $kind}` and nothing else at any depth. There is a
 * `/v3/collections/{id}/items/` endpoint that names the top two levels, and it was tried — it
 * cannot name level three, so it would have to be supplemented by exactly this walk anyway
 * (ADR 033).
 *
 * A group is fetched the same way a request is: the item endpoint answers for both, and a
 * group's own `description`, `scripts` and `auth` are what its `definition.yaml` carries. One
 * code path rather than two means a folder cannot quietly lose its collection-level script.
 */
async function fetchItem(proxy: ProxyClient, collectionId: string, stub: CloudItemStub): Promise<PostmanSourceItem> {
  const detail = parseItem(
    await proxy({
      service: COLLECTION_SERVICE,
      path: itemPath(collectionId, stub.id),
      // The stub's own kind, verbatim: claiming anything else answers `RESOURCE_NOT_FOUND` for
      // an id that exists.
      entityType: stub.$kind,
    }),
    collectionId,
    stub.id,
  );
  const nested = stub.$kind === COLLECTION_ENTITY;
  const children = nested ? await Promise.all(detail.items.map((child) => fetchItem(proxy, collectionId, child))) : [];
  return { kind: nested ? FOLDER_KIND : stub.$kind, name: detail.name, detail, children };
}

async function fetchCollection(proxy: ProxyClient, collectionId: string): Promise<PostmanSourceCollection> {
  const detail = parseCollection(
    await proxy({ service: COLLECTION_SERVICE, path: collectionPath(collectionId), entityType: COLLECTION_ENTITY }),
    collectionId,
  );
  const items = await Promise.all(detail.items.map((stub) => fetchItem(proxy, collectionId, stub)));
  return { id: collectionId, detail, items };
}

/**
 * Every cloud workspace the signed-in account can see.
 *
 * Named for the transport rather than the feature: `api/migrate.ts` exports the
 * `listCloudWorkspaces` a front end calls, which acquires a session first. Nothing outside this
 * directory can build a `ProxyClient`, and that is the point.
 */
export async function fetchWorkspaceList(proxy: ProxyClient): Promise<CloudWorkspace[]> {
  // `workspaces`, not `sync`: the two services split by noun, and `sync` answers 404 for this
  // path while serving `/workspace/{id}` and `/environment/{id}` perfectly well.
  const payload = await proxy({ service: WORKSPACES_SERVICE, path: WORKSPACES_PATH });
  const list = parseResponse(
    workspaceListSchema,
    unwrapEnvelope(unwrapEnvelope(payload, DATA_KEY), WORKSPACES_KEY),
    WORKSPACES_PATH,
  );
  return list.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    type: workspace.type ?? (workspace.team === null || workspace.team === undefined ? PERSONAL_TYPE : TEAM_TYPE),
  }));
}

/**
 * Everything in one cloud workspace, as the value `planWorkspace` converts.
 *
 * The two collection arrays are concatenated here rather than in `convert.ts` because the split
 * is an artefact of Postman's storage model, not of the user's intent: one Postman workspace
 * becomes one preman workspace.
 */
export async function fetchCloudWorkspace(
  unlimited: ProxyClient,
  workspaceId: string,
  progress: ProgressTracker = NO_PROGRESS,
): Promise<PostmanWorkspaceSource> {
  // Everything below shares one ceiling, including the environment reads: they are the same
  // proxy and the same rate limit.
  const proxy = gated(unlimited, progress);
  progress.at("reading-workspace");
  const workspace = parseWorkspace(await proxy({ service: SYNC_SERVICE, path: workspacePath(workspaceId) }));
  const ids = [...workspace.dependencies.collections, ...workspace.dependencies.extensibleCollections];

  /*
   * The one reply above is what makes a proportion sayable at all, and `ids.length` is final from
   * here on: a collection is an independent subtree that resolves as a unit, so the count below
   * only ever rises and the ceiling is never revised. Everything deeper — how many folders, how
   * many requests — is still unknown and stays out of the arithmetic.
   */
  progress.at("reading-collections", NOTHING, ids.length);
  let readCollections = NOTHING;
  const collections = await Promise.all(
    ids.map(async (id) => {
      const collection = await fetchCollection(proxy, id);
      readCollections += 1;
      progress.at("reading-collections", readCollections, ids.length);
      return collection;
    }),
  );

  // An environment is a second read rather than part of the workspace payload, because the
  // workspace payload holds its id and nothing else.
  const environmentIds = workspace.dependencies.environments;
  progress.at("reading-environments", NOTHING, environmentIds.length);
  let readEnvironments = NOTHING;
  const environments = await Promise.all(
    environmentIds.map(async (id) => {
      const environment = parseEnvironment(await proxy({ service: SYNC_SERVICE, path: environmentPath(id) }), id);
      readEnvironments += 1;
      progress.at("reading-environments", readEnvironments, environmentIds.length);
      return environment;
    }),
  );
  return { workspaceId: workspace.id, name: workspace.name, collections, environments };
}
