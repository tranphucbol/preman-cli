import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PremanError, EXIT } from "@preman/core";
import { planWorkspace } from "@preman/core/postman/convert.js";
import { applyPlan } from "@preman/core/postman/write.js";
import { ORDER_STEP } from "@preman/core/workspace/paths.js";
import type { PostmanSourceItem, PostmanWorkspaceSource } from "@preman/core/postman/model.js";
import type { FilePlan } from "@preman/core/postman/plan.js";
import { cloudFixture, WORKSPACE_ID } from "./support/postman-cloud.js";

/**
 * Conversion is a pure function, so every case here composes a source out of the captured
 * fixtures rather than booting anything. `postman.fetch.test.ts` covers the walk that builds one.
 */

const GRPC_KIND = "grpc-request";
const HTTP_KIND = "http-request";
const WEBSOCKET_KIND = "websocket-request";
const FOLDER_KIND = "folder";
/** `item-grpc-exchange.json`'s `schema.location`, as Postman records it: an absolute path. */
const PROTO_LOCATION = "/Users/dev/repos/asset-exchange-v2/src/main/proto/asset/asset-exchange-v2.proto";

/** Every proxy reply is wrapped in `data`; the converter is handed what is inside it. */
function detailOf(name: string): Record<string, unknown> {
  return (cloudFixture(name) as { data: Record<string, unknown> }).data;
}

function leaf(kind: string, name: string, detail: unknown): PostmanSourceItem {
  return { kind, name, detail, children: [] };
}

function source(overrides: Partial<PostmanWorkspaceSource> = {}): PostmanWorkspaceSource {
  return {
    workspaceId: WORKSPACE_ID,
    name: "Work",
    collections: [],
    environments: [],
    ...overrides,
  };
}

function fileAt(plan: FilePlan, relativePath: string): string {
  const found = plan.files.find((file) => file.relativePath === relativePath);
  if (found === undefined) {
    throw new Error(`no ${relativePath} in plan; got:\n${plan.files.map((file) => file.relativePath).join("\n")}`);
  }
  return found.contents;
}

/** The gRPC collection exactly as it was captured: one `Exchange` request. */
function grpcCollection(name = "gRpc - Exchange", request: unknown = detailOf("item-grpc-exchange")) {
  return {
    id: "any",
    detail: { ...detailOf("collection-grpc"), name },
    items: [leaf(GRPC_KIND, "Exchange", request)],
  };
}

const temporaries: string[] = [];

function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "preman-migrate-"));
  temporaries.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaries.length > 0) rmSync(temporaries.pop()!, { recursive: true, force: true });
});

describe("planWorkspace", () => {
  it("givenAGrpcItem_whenPlanned_thenMethodDescriptorSurvivesVerbatim", () => {
    const detail = detailOf("item-grpc-exchange");
    const plan = planWorkspace(source({ collections: [grpcCollection()] }));

    const written = parse(fileAt(plan, "postman/collections/gRpc - Exchange/Exchange.request.yaml")) as {
      methodDescriptor: string;
      methodPath: string;
    };
    expect(written.methodDescriptor).toBe(detail.methodDescriptor);
    expect(written.methodPath).toBe("pe.aev2.ExchangeService.Exchange");
  });

  it("givenAGrpcItem_whenPlanned_thenPostmansIdentityFieldsAreDropped", () => {
    const plan = planWorkspace(source({ collections: [grpcCollection()] }));

    const written = parse(fileAt(plan, "postman/collections/gRpc - Exchange/Exchange.request.yaml")) as Record<
      string,
      unknown
    >;
    // These address rows in Postman's storage, not anything this file will ever talk to.
    expect(Object.keys(written)).not.toContain("id");
    expect(Object.keys(written)).not.toContain("collectionId");
    expect(Object.keys(written)).not.toContain("__objectPoolBusterKey");
    // What is kept is kept: `settings` carries `secureConnection` even though nothing reads it.
    expect(written.settings).toEqual({ secureConnection: true });
  });

  it("givenAFileBackedSchema_whenPlanned_thenTheProtoPathIsKeptAndDeclared", () => {
    const plan = planWorkspace(source({ collections: [grpcCollection()] }));

    const written = parse(fileAt(plan, "postman/collections/gRpc - Exchange/Exchange.request.yaml")) as {
      schema: unknown;
    };
    // Absolute on purpose: `resolveMethod` prefers the live `.proto` over the snapshot descriptor.
    expect(written.schema).toEqual({ source: "file", location: PROTO_LOCATION });

    // And declared, because `deriveIncludeDirs` reads its import roots from `specs` alone.
    const resources = parse(fileAt(plan, ".postman/resources.yaml")) as {
      localResources: { specs: string[] };
    };
    expect(resources.localResources.specs).toEqual([PROTO_LOCATION]);
  });

  it("givenAnApiBackedSchema_whenPlanned_thenTheCloudPointerIsDropped", () => {
    const detail = { ...detailOf("item-grpc-exchange"), schema: { source: "api", apiId: "a", versionId: "v" } };
    const plan = planWorkspace(source({ collections: [grpcCollection(undefined, detail)] }));

    const written = parse(fileAt(plan, "postman/collections/gRpc - Exchange/Exchange.request.yaml")) as Record<
      string,
      unknown
    >;
    // It has no local counterpart, so keeping it would only promise a `.proto` that is not there.
    expect(written.schema).toBeUndefined();
    expect(parse(fileAt(plan, ".postman/resources.yaml"))).toEqual({ workspace: { id: WORKSPACE_ID } });
  });

  it("givenAnItemTree_whenPlanned_thenOrderFollowsTheItemsArray", () => {
    const plan = planWorkspace(
      source({
        collections: [
          {
            id: "any",
            detail: detailOf("collection-adapter"),
            items: [
              {
                kind: FOLDER_KIND,
                name: "Legacy",
                detail: detailOf("item-folder-legacy"),
                children: [leaf(HTTP_KIND, "Login", detailOf("item-http-login"))],
              },
              leaf(HTTP_KIND, "Profile", detailOf("item-http-profile")),
            ],
          },
        ],
      }),
    );

    const orderOf = (path: string) => (parse(fileAt(plan, path)) as { order: number }).order;
    expect(orderOf("postman/collections/Adapter/Legacy/.resources/definition.yaml")).toBe(0);
    expect(orderOf("postman/collections/Adapter/Profile.request.yaml")).toBe(ORDER_STEP);
    // A folder's children are ordered within the folder, not across the collection.
    expect(orderOf("postman/collections/Adapter/Legacy/Login.request.yaml")).toBe(0);
  });

  it("givenTwoCollectionsWithOneName_whenPlanned_thenTheSecondIsSuffixed", () => {
    const plan = planWorkspace(source({ collections: [grpcCollection("Adapter"), grpcCollection("Adapter")] }));

    expect(plan.files.map((file) => file.relativePath)).toContain(
      "postman/collections/Adapter (2)/.resources/definition.yaml",
    );
    // The display name is untouched: the filename only has to be unambiguous on disk.
    const definition = parse(fileAt(plan, "postman/collections/Adapter (2)/.resources/definition.yaml")) as {
      name: string;
    };
    expect(definition.name).toBe("Adapter");
  });

  it("givenACollectionNameWithASlash_whenPlanned_thenItBecomesOneSafeSegment", () => {
    const plan = planWorkspace(source({ collections: [grpcCollection("Refund / Core")] }));

    expect(plan.files.map((file) => file.relativePath)).toContain(
      "postman/collections/Refund Core/.resources/definition.yaml",
    );
    const definition = parse(fileAt(plan, "postman/collections/Refund Core/.resources/definition.yaml")) as {
      name: string;
    };
    expect(definition.name).toBe("Refund / Core");
  });

  it("givenAWebsocketItem_whenPlanned_thenItIsSkippedAndNamed", () => {
    const plan = planWorkspace(
      source({
        collections: [
          {
            id: "any",
            detail: detailOf("collection-adapter"),
            items: [leaf(WEBSOCKET_KIND, "Legacy Socket", detailOf("item-websocket"))],
          },
        ],
      }),
    );

    expect(plan.skipped).toEqual([{ path: "Adapter/Legacy Socket", kind: WEBSOCKET_KIND }]);
    expect(plan.files.map((file) => file.relativePath)).not.toContain(
      "postman/collections/Adapter/Legacy Socket.request.yaml",
    );
    expect(plan.counts[WEBSOCKET_KIND]).toBeUndefined();
  });

  it("givenAResponseMissingMethodPath_whenPlanned_thenItFailsAtTheBoundary", () => {
    const { methodPath: _dropped, ...withoutMethodPath } = detailOf("item-grpc-exchange");
    const broken = source({
      collections: [
        {
          id: "any",
          detail: detailOf("collection-grpc"),
          items: [leaf(GRPC_KIND, "Exchange", withoutMethodPath)],
        },
      ],
    });

    expect(() => planWorkspace(broken)).toThrow(PremanError);
    try {
      planWorkspace(broken);
      expect.unreachable("a request with no methodPath must not become a file");
    } catch (error) {
      const failure = error as PremanError;
      expect(failure.exitCode).toBe(EXIT.TRANSPORT);
      expect(failure.details.join("\n")).toContain("methodPath");
    }
  });

  it("givenAnHttpOnlyWorkspace_whenPlanned_thenResourcesCarriesOnlyTheWorkspaceId", () => {
    const plan = planWorkspace(
      source({
        collections: [
          {
            id: "any",
            detail: detailOf("collection-adapter"),
            items: [leaf(HTTP_KIND, "Profile", detailOf("item-http-profile"))],
          },
        ],
      }),
    );

    // Nothing points at a `.proto`, so `localResources` is absent rather than empty.
    expect(parse(fileAt(plan, ".postman/resources.yaml"))).toEqual({ workspace: { id: WORKSPACE_ID } });
  });

  it("givenAnEnvironment_whenPlanned_thenItsValuesSurvive", () => {
    const plan = planWorkspace(source({ environments: [detailOf("environment-staging")] }));

    const written = parse(fileAt(plan, "postman/environments/staging.environment.yaml")) as {
      name: string;
      values: { key: string }[];
    };
    expect(written.name).toBe("staging");
    expect(written.values.map((value) => value.key)).toEqual(["base_url", "grpc_url", "token"]);
  });
});

describe("applyPlan", () => {
  it("givenAPlan_whenApplied_thenEveryFileLandsUnderTheTarget", async () => {
    const target = join(temporaryDir(), "work");
    const plan = planWorkspace(source({ collections: [grpcCollection()] }));

    await applyPlan(target, plan);

    for (const file of plan.files) {
      expect(readFileSync(join(target, ...file.relativePath.split("/")), "utf8")).toBe(file.contents);
    }
  });

  it("givenAPlan_whenAppliedToANonEmptyDirectory_thenNothingIsWritten", () => {
    const target = temporaryDir();
    writeFileSync(join(target, "notes.txt"), "mine\n");
    const plan = planWorkspace(source({ collections: [grpcCollection()] }));

    // Refused before the first write, so the throw is synchronous: nothing is in flight to await.
    expect(() => applyPlan(target, plan)).toThrow(PremanError);
    expect(readdirSync(target)).toEqual(["notes.txt"]);
    expect(existsSync(join(target, ".postman"))).toBe(false);
  });
});
