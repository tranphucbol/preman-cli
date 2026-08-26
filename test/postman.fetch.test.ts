import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PremanError, EXIT } from "@preman/core";
import { migrateThroughProxy } from "@preman/core/api/migrate.js";
import { fetchCloudWorkspace, fetchWorkspaceList } from "@preman/core/postman/fetch.js";
import { postmanProxy } from "@preman/core/postman/proxy.js";
import { harvestToken } from "@preman/core/postman/session.js";
import type { MigrationProgress } from "@preman/core";
import type { ProxyClient } from "@preman/core/postman/proxy.js";

/** `Array.prototype.sort` is lexicographic by default, which would call `[2, 10]` unsorted. */
const rising = (left: number, right: number): number => left - right;
import {
  startProxyServer,
  ADAPTER_ID,
  ENVIRONMENT_ID,
  GRPC_COLLECTION_ID,
  POSTMAN_APPDATA_DIR,
  POSTMAN_NOT_RUNNING_DIR,
  WORKSPACE_ID,
  type ProxyTestServer,
} from "./support/postman-cloud.js";

/**
 * The transport, against an in-process stand-in for `/ws/proxy`. No test reaches Postman, and
 * none needs a Postman account: only `harvestToken` does, so only its failure paths are here.
 */

const FIXTURE_TOKEN = "not-a-real-token";

let server: ProxyTestServer;
let proxy: ProxyClient;
const temporaries: string[] = [];

function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "preman-migrate-"));
  temporaries.push(dir);
  return dir;
}

beforeEach(async () => {
  server = await startProxyServer();
  proxy = postmanProxy({ accessToken: FIXTURE_TOKEN, teamId: undefined }, server.url);
});

afterEach(async () => {
  await server.close();
  while (temporaries.length > 0) rmSync(temporaries.pop()!, { recursive: true, force: true });
});

describe("fetchCloudWorkspace", () => {
  it("givenAWorkspaceWithExtensibleCollections_whenFetched_thenBothArraysAreWalked", async () => {
    const source = await fetchCloudWorkspace(proxy, WORKSPACE_ID);

    // The whole reason this route exists: the public API can only see the first of the two.
    expect(source.collections.map((collection) => collection.id)).toEqual([ADAPTER_ID, GRPC_COLLECTION_ID]);
    const grpc = source.collections[1]!;
    expect(grpc.items.map((item) => item.kind)).toEqual(["grpc-request"]);
    expect(source.environments).toHaveLength(1);
  });

  it("givenANestedTree_whenFetched_thenChildrenKeepPostmanOrder", async () => {
    const source = await fetchCloudWorkspace(proxy, WORKSPACE_ID);

    const adapter = source.collections[0]!;
    expect(adapter.items.map((item) => item.name)).toEqual(["Legacy", "Profile"]);
    expect(adapter.items[0]!.children.map((item) => item.name)).toEqual(["Login", "Legacy Socket"]);
  });

  it("givenAnItemRead_whenFetched_thenItClaimsTheItemsOwnKind", async () => {
    await fetchCloudWorkspace(proxy, WORKSPACE_ID);

    const items = server.requests.filter((request) => request.path.includes("/items/"));
    // Five items, five reads, each declaring what it is: the endpoint refuses a read with no
    // `x-entity-type` and answers 404 when the header disagrees with the item.
    expect(items.map((request) => request.entityType).sort()).toEqual([
      "collection",
      "grpc-request",
      "http-request",
      "http-request",
      "websocket-request",
    ]);
  });

  it("givenANestedGroup_whenFetched_thenItIsACollectionOnTheWireAndAFolderInThePlan", async () => {
    const source = await fetchCloudWorkspace(proxy, WORKSPACE_ID);

    // Postman's model has no folders, so the read says `collection`; preman's vocabulary does,
    // so the source item says `folder` and the report can count the two apart.
    expect(source.collections[0]!.items[0]).toMatchObject({ kind: "folder", name: "Legacy" });
    // And the tree endpoint is not consulted at all: it cannot name anything below level two.
    expect(server.requests.some((request) => request.path.endsWith("/items/"))).toBe(false);
  });

  it("givenASession_whenFetched_thenEveryCallCarriesTheAccessToken", async () => {
    await fetchCloudWorkspace(proxy, WORKSPACE_ID);

    expect(server.requests.length).toBeGreaterThan(0);
    expect(new Set(server.requests.map((request) => request.token))).toEqual(new Set([FIXTURE_TOKEN]));
    expect(server.requests[0]).toMatchObject({ service: "sync", method: "GET" });
  });

  it("givenAnEnvironmentDependency_whenFetched_thenItIsReadOverTheSyncService", async () => {
    const source = await fetchCloudWorkspace(proxy, WORKSPACE_ID);

    // `dependencies.environments` holds ids, not documents: each one costs its own call.
    expect(server.requests).toContainEqual({
      service: "sync",
      method: "GET",
      path: `/environment/${ENVIRONMENT_ID}`,
      token: FIXTURE_TOKEN,
    });
    expect((source.environments[0] as { name: string }).name).toBe("staging");
  });

  it("givenAProxyErrorEnvelope_whenFetched_thenItRaisesTransportExitCode", async () => {
    const refusing = await startProxyServer({ errorName: "invalidServiceError" });
    try {
      const client = postmanProxy({ accessToken: FIXTURE_TOKEN, teamId: undefined }, refusing.url);
      await expect(fetchCloudWorkspace(client, WORKSPACE_ID)).rejects.toMatchObject({
        exitCode: EXIT.TRANSPORT,
      });
      await expect(fetchCloudWorkspace(client, WORKSPACE_ID)).rejects.toThrow(/invalidServiceError/);
    } finally {
      await refusing.close();
    }
  });
});

describe("fetchWorkspaceList", () => {
  it("givenACloudAccount_whenListed_thenEveryVisibleWorkspaceIsNamed", async () => {
    expect(await fetchWorkspaceList(proxy)).toEqual([
      { id: WORKSPACE_ID, name: "Work", type: "team" },
      { id: "55555555-5555-4555-8555-555555555555", name: "Work", type: "personal" },
      { id: "44444444-4444-4444-8444-444444444444", name: "My Workspace", type: "personal" },
    ]);
  });

  it("givenTheListing_whenItRuns_thenItAsksTheWorkspacesServiceAndNotSync", async () => {
    await fetchWorkspaceList(proxy);

    // `sync` answers `/workspace/{id}` but 404s the plural path; the two are not interchangeable.
    expect(server.requests).toEqual([
      { service: "workspaces", method: "GET", path: "/workspaces", token: FIXTURE_TOKEN },
    ]);
  });
});

describe("migrateThroughProxy", () => {
  it("givenAmbiguousWorkspaceName_whenMigrateRuns_thenItListsTheCandidates", async () => {
    const target = join(temporaryDir(), "work");

    await expect(migrateThroughProxy(proxy, { workspace: "Work", target, dryRun: false })).rejects.toMatchObject({
      exitCode: EXIT.CLI,
    });
    try {
      await migrateThroughProxy(proxy, { workspace: "Work", target, dryRun: false });
      expect.unreachable("an ambiguous name must not pick a workspace");
    } catch (error) {
      const failure = error as PremanError;
      expect(failure.details.join("\n")).toContain(WORKSPACE_ID);
      expect(failure.details.join("\n")).toContain("55555555-5555-4555-8555-555555555555");
    }
    expect(existsSync(target)).toBe(false);
  });

  it("givenAnUnknownWorkspaceName_whenMigrateRuns_thenItNamesWhatIsAvailable", async () => {
    const target = join(temporaryDir(), "work");

    await expect(migrateThroughProxy(proxy, { workspace: "Nowhere", target, dryRun: false })).rejects.toThrow(
      /no cloud workspace named "Nowhere"/,
    );
  });

  it("givenDryRun_whenMigrateRuns_thenNothingIsWritten", async () => {
    const target = join(temporaryDir(), "work");

    const outcome = await migrateThroughProxy(proxy, { workspace: WORKSPACE_ID, target, dryRun: true });

    expect(outcome.dryRun).toBe(true);
    expect(outcome.files).toContain(".postman/resources.yaml");
    expect(existsSync(target)).toBe(false);
  });

  it("givenAWorkspaceId_whenMigrateRuns_thenTheWorkspaceIsOnDiskAndSkippedIsReported", async () => {
    const target = join(temporaryDir(), "work");

    const outcome = await migrateThroughProxy(proxy, { workspace: WORKSPACE_ID, target, dryRun: false });

    expect(outcome.counts).toMatchObject({
      collection: 2,
      folder: 1,
      environment: 1,
      "grpc-request": 1,
      "http-request": 2,
    });
    expect(outcome.skipped).toEqual([{ path: "Adapter/Legacy/Legacy Socket", kind: "websocket-request" }]);
    expect(existsSync(join(target, ".postman/resources.yaml"))).toBe(true);
    expect(existsSync(join(target, "postman/collections/gRpc - Exchange/Exchange.request.yaml"))).toBe(true);
    expect(existsSync(join(target, "postman/environments/staging.environment.yaml"))).toBe(true);
  });

  it("givenAMigration_whenProgressIsWatched_thenEveryPhaseIsReportedInOrder", async () => {
    const target = join(temporaryDir(), "work");
    const seen: MigrationProgress[] = [];

    await migrateThroughProxy(proxy, {
      workspace: WORKSPACE_ID,
      target,
      dryRun: false,
      onProgress: (progress) => seen.push(progress),
    });

    // `connecting` belongs to the token harvest, which this seam is deliberately below.
    expect([...new Set(seen.map((progress) => progress.phase))]).toEqual([
      "reading-workspace",
      "reading-collections",
      "reading-environments",
      "converting",
      "writing",
    ]);
  });

  it("givenAMigration_whenProgressIsWatched_thenNoCountEverGoesBackwards", async () => {
    const target = join(temporaryDir(), "work");
    const seen: MigrationProgress[] = [];

    const outcome = await migrateThroughProxy(proxy, {
      workspace: WORKSPACE_ID,
      target,
      dryRun: false,
      onProgress: (progress) => seen.push(progress),
    });

    // The whole promise of this feature: a phase's ceiling is stated once and never revised, and
    // its count only rises. A denominator that grew would be the bar sliding backwards.
    for (const phase of new Set(seen.map((progress) => progress.phase))) {
      const within = seen.filter((progress) => progress.phase === phase);
      expect(new Set(within.map((progress) => progress.total)).size).toBe(1);
      expect(within.map((progress) => progress.done)).toEqual(
        [...within.map((progress) => progress.done)].sort(rising),
      );
    }
    expect(seen.map((progress) => progress.calls)).toEqual([...seen.map((progress) => progress.calls)].sort(rising));

    const collections = seen.filter((progress) => progress.phase === "reading-collections");
    // Both dependency arrays, which is the one number knowable before the walk begins.
    expect(collections[0]?.total).toBe(2);
    expect(collections[collections.length - 1]?.done).toBe(2);

    const writing = seen.filter((progress) => progress.phase === "writing");
    // Always ends on the full count, whatever the reporting interval landed on.
    expect(writing[writing.length - 1]).toMatchObject({ done: outcome.files.length, total: outcome.files.length });
  });
});

describe("harvestToken", () => {
  it("givenNoDevToolsActivePort_whenTokenIsHarvested_thenItSaysToOpenPostman", async () => {
    await expect(harvestToken(POSTMAN_NOT_RUNNING_DIR)).rejects.toThrow(
      /Postman Desktop does not appear to be running/,
    );
    try {
      await harvestToken(POSTMAN_NOT_RUNNING_DIR);
      expect.unreachable("a missing port file cannot yield a token");
    } catch (error) {
      const failure = error as PremanError;
      expect(failure.exitCode).toBe(EXIT.CLI);
      expect(failure.details.join("\n")).toContain("sign in");
    }
  });

  it("givenAnUnreadablePort_whenTokenIsHarvested_thenItQuotesTheLineItRead", async () => {
    await expect(harvestToken(POSTMAN_APPDATA_DIR)).rejects.toThrow(/could not read a debugging port/);
  });
});
