import { describe, expect, it } from "vitest";
import * as core from "@preman/core";

/**
 * The barrel is a contract with consumers that do not live in this repo, so its runtime
 * exports are pinned by name. Types are absent here by construction: `verbatimModuleSyntax`
 * erases them, which is exactly why widening the surface has to be deliberate.
 */
const DECLARED_SURFACE = [
  "BodyStore",
  "EXIT",
  "PremanError",
  "buildCatalog",
  "createCollection",
  "createEnvironmentFile",
  "createFolder",
  "createRequestFile",
  "deleteNode",
  "describeWorkspace",
  "editDefinitionFile",
  "editRequestFile",
  "failOnAmbiguity",
  "findWorkspace",
  "flattenHeaders",
  "listGroups",
  "listRequests",
  "moveNode",
  "readEnvironment",
  "readVariables",
  "refreshCatalog",
  "renameNode",
  "reorderSiblings",
  "replaceFileText",
  "requireWorkspace",
  "runGroup",
  "runRequest",
  "runSelection",
  "selectEnvironment",
  "targetLabel",
  "toGroupJsonReport",
  "toJsonReport",
  "toJunitReport",
  "watchWorkspace",
  "writeEnvironmentValue",
];

describe("core barrel", () => {
  it("givenCoreBarrel_whenImported_thenSurfaceMatchesTheDeclaredList", () => {
    expect(Object.keys(core).sort()).toEqual(DECLARED_SURFACE);
  });
});
