import { describe, expect, it } from "vitest";
import * as core from "@preman/core";

/**
 * The barrel is a contract with consumers that do not live in this repo, so its runtime
 * exports are pinned by name. Types are absent here by construction: `verbatimModuleSyntax`
 * erases them, which is exactly why widening the surface has to be deliberate.
 */
const DECLARED_SURFACE = [
  "EXIT",
  "PremanError",
  "describeWorkspace",
  "failOnAmbiguity",
  "findWorkspace",
  "listGroups",
  "listRequests",
  "readEnvironment",
  "requireWorkspace",
  "runGroup",
  "runRequest",
  "runSelection",
  "selectEnvironment",
  "targetLabel",
  "toGroupJsonReport",
  "toJsonReport",
  "writeEnvironmentValue",
];

describe("core barrel", () => {
  it("givenCoreBarrel_whenImported_thenSurfaceMatchesTheDeclaredList", () => {
    expect(Object.keys(core).sort()).toEqual(DECLARED_SURFACE);
  });
});
