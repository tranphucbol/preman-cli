import { describe, expect, it } from "vitest";
import * as core from "@preman/core";
import type { SentRequest } from "@preman/core";

const NO_PAIRS: [string, string][] = [];

/**
 * The barrel is a contract with consumers that do not live in this repo, so its runtime
 * exports are pinned by name. Types are absent here by construction: `verbatimModuleSyntax`
 * erases them, which is exactly why widening the surface has to be deliberate.
 */
const DECLARED_SURFACE = [
  "BodyStore",
  "DEFAULT_SHARED_PROTO_ROOT",
  "EXIT",
  "PremanError",
  "SHARED_PROTO_ROOT_ENV",
  "applyImportPlan",
  "applySpecPlan",
  "buildCatalog",
  "collectProtoFiles",
  "copySelection",
  "createCollection",
  "createEnvironmentFile",
  "createFolder",
  "createRequestFile",
  "deleteNode",
  "describeSpecs",
  "describeWorkspace",
  "duplicateRequestFile",
  "editDefinitionFile",
  "editRequestFile",
  "failOnAmbiguity",
  "findWorkspace",
  "flattenHeaders",
  "isProtoFile",
  "linkCheckout",
  "listCloudWorkspaces",
  "listGroups",
  "listRequests",
  "migrateCloudWorkspace",
  "moveNode",
  "planCommand",
  "planImport",
  "planSpecConversion",
  "planSpecs",
  "previewText",
  "readEnvironment",
  "readVariables",
  "refreshCatalog",
  "removeSpec",
  "renameNode",
  "reorderSiblings",
  "replaceFileText",
  "requireWorkspace",
  "runGroup",
  "runRequest",
  "runSelection",
  "selectEnvironment",
  "sharedProtoRoot",
  "targetLabel",
  "toGroupJsonReport",
  "toJsonReport",
  "toJunitReport",
  "watchWorkspace",
  "writeEnvironmentValue",
  "writeRequestFile",
];

describe("core barrel", () => {
  it("givenCoreBarrel_whenImported_thenSurfaceMatchesTheDeclaredList", () => {
    expect(Object.keys(core).sort()).toEqual(DECLARED_SURFACE);
  });

  /**
   * A type export leaves nothing behind to count, so this asserts where types still exist: the
   * `import type` above stops compiling if the barrel drops it, and these two literals stop
   * compiling if the union loses an arm or renames a field.
   */
  it("givenTheCoreEntrypoint_whenImported_thenSentRequestIsExported", () => {
    const http: SentRequest = {
      protocol: "http",
      method: "GET",
      url: "https://example.test/",
      headers: NO_PAIRS,
      body: undefined,
    };
    const grpc: SentRequest = {
      protocol: "grpc",
      methodPath: "pkg.Service.Method",
      metadata: NO_PAIRS,
      message: {},
    };

    expect([http.protocol, grpc.protocol]).toEqual(["http", "grpc"]);
  });
});
