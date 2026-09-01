import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { listRequests, resolveRequest } from "@preman/core/workspace/collections.js";
import { findWorkspace, requireWorkspace } from "@preman/core/workspace/discover.js";
import {
  findEnvironment,
  listEnvironments,
  loadGlobals,
  saveEnvironmentValues,
} from "@preman/core/workspace/environments.js";
import { deriveIncludeDirs, loadResources } from "@preman/core/workspace/resources.js";
import { PremanError } from "@preman/core/errors.js";
import {
  cloneFixtureWorkspace,
  collectionPath,
  definitionPath,
  FIXTURE_WS,
  fixtureWorkspace,
  type ClonedWorkspace,
} from "./helpers.js";

describe("discover", () => {
  it("givenNestedDirectory_whenFindWorkspace_thenWalksUpToPostmanRoot", () => {
    const ws = findWorkspace(join(FIXTURE_WS, "postman/collections/payment/nested"));
    expect(ws?.root).toBe(FIXTURE_WS);
    expect(ws?.postmanDir).toBe(join(FIXTURE_WS, "postman"));
  });

  it("givenDirectoryWithoutPostman_whenRequireWorkspace_thenThrowsPremanError", () => {
    const empty = mkdtempSync(join(tmpdir(), "preman-empty-"));
    try {
      expect(findWorkspace(empty)).toBeNull();
      expect(() => requireWorkspace(empty)).toThrow(PremanError);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("resources", () => {
  it("givenFixtureResources_whenLoaded_thenResolvesSpecsAndIncludeDirs", () => {
    const resources = loadResources(fixtureWorkspace());
    expect(resources.workspaceId).toBe("11111111-2222-3333-4444-555555555555");
    expect(resources.specs).toContain(join(FIXTURE_WS, "src/main/proto/echo/echo.proto"));
    expect(resources.includeDirs).toContain(join(FIXTURE_WS, "src/main/proto"));
  });

  it("givenNonProtoSpecDeclared_whenLoaded_thenItIsNeitherASpecNorAnIncludeDir", () => {
    const cloned = cloneFixtureWorkspace();
    try {
      const file = join(cloned.root, ".postman/resources.yaml");
      writeFileSync(file, `${readFileSync(file, "utf8").trimEnd()}\n    - ../docs/service-openapi.yaml\n`);

      const resources = loadResources(requireWorkspace(cloned.root));

      expect(resources.specs.every((spec) => spec.endsWith(".proto"))).toBe(true);
      // Its directory must not become an import root either, or a stray `docs/echo.proto`
      // could win a relative import over the real one.
      expect(resources.includeDirs).not.toContain(join(cloned.root, "docs"));
    } finally {
      cloned.cleanup();
    }
  });

  it("givenSpecPaths_whenDerivingIncludeDirs_thenProtoRootsComeFirst", () => {
    const root = `${sep}repo`;
    const dirs = deriveIncludeDirs(
      [join(root, "src/main/proto/asset/a.proto"), join(root, "src/test/proto/echo.proto")],
      root,
    );
    const protoRoots = dirs.filter((d) => d.endsWith(`${sep}proto`));
    expect(dirs.slice(0, protoRoots.length)).toEqual(protoRoots);
    expect(protoRoots).toEqual([join(root, "src/main/proto"), join(root, "src/test/proto")]);
    // Bounded by the workspace root; never escapes it.
    expect(dirs.every((d) => d === root || d.startsWith(root + sep))).toBe(true);
  });
});

describe("collections", () => {
  it("givenFixtureCollections_whenListed_thenSortedByFolderThenOrder", () => {
    const requests = listRequests(fixtureWorkspace());
    expect(requests.map((r) => r.path)).toEqual([
      "payment/Ping",
      "payment/Echo",
      "payment/Legacy Http",
      "payment/Descriptor Only",
      "payment/nested/Deep Echo",
    ]);
  });

  it("givenNestedRequest_whenListed_thenCarriesFolderAndKind", () => {
    const deep = listRequests(fixtureWorkspace()).find((r) => r.name === "Deep Echo");
    expect(deep?.folders).toEqual(["nested"]);
    expect(deep?.collection).toBe("payment");
    expect(deep?.kind).toBe("grpc-request");
    expect(listRequests(fixtureWorkspace()).find((r) => r.name === "Legacy Http")?.kind).toBe("websocket-request");
  });

  it("givenSelector_whenResolving_thenPrefersExactOverFuzzy", () => {
    const requests = listRequests(fixtureWorkspace());
    expect(resolveRequest(requests, "Echo").match?.path).toBe("payment/Echo");
    expect(resolveRequest(requests, "payment/nested/Deep Echo").match?.path).toBe("payment/nested/Deep Echo");
    expect(resolveRequest(requests, "deep echo").match?.path).toBe("payment/nested/Deep Echo");
    expect(resolveRequest(requests, "nope").match).toBeUndefined();
  });

  it("givenAmbiguousSubstring_whenResolving_thenReturnsAllCandidates", () => {
    const result = resolveRequest(listRequests(fixtureWorkspace()), "o");
    expect(result.match).toBeUndefined();
    expect(result.candidates.length).toBeGreaterThan(1);
  });
});

/**
 * Ordering and malformed-definition cases run against a clone: several suites
 * assert the shared fixture's exact 5-request list.
 */
describe("collection tree ordering", () => {
  function writeDefinition(clone: ClonedWorkspace, group: string[], body: string): void {
    writeFileSync(definitionPath(clone.root, ...group), body);
  }

  function addFolder(clone: ClonedWorkspace, name: string, order: number, requestName: string): void {
    const dir = collectionPath(clone.root, "payment", name);
    mkdirSync(join(dir, ".resources"), { recursive: true });
    writeFileSync(join(dir, ".resources/definition.yaml"), `$kind: collection\nname: ${name}\norder: ${order}\n`);
    writeFileSync(join(dir, `${requestName}.request.yaml`), `$kind: http-request\nname: ${requestName}\n`);
  }

  it("givenFoldersWithOrder_whenListing_thenPostmanOrderNotAlphabetical", () => {
    const clone = cloneFixtureWorkspace();
    try {
      addFolder(clone, "zeta", 1, "Zeta One");
      writeDefinition(clone, ["payment", "nested"], "$kind: collection\nname: nested\norder: 2\n");

      const folders = listRequests(clone.workspace)
        .filter((request) => request.folders.length > 0)
        .map((request) => request.path);

      // Alphabetically `nested` precedes `zeta`; `order` says otherwise and wins.
      expect(folders).toEqual(["payment/zeta/Zeta One", "payment/nested/Deep Echo"]);
    } finally {
      clone.cleanup();
    }
  });

  it("givenFolderAndRequestSiblings_whenListing_thenTheyInterleaveByOrder", () => {
    const clone = cloneFixtureWorkspace();
    try {
      // Between Echo (20) and Legacy Http (30).
      writeDefinition(clone, ["payment", "nested"], "$kind: collection\nname: nested\norder: 25\n");

      expect(listRequests(clone.workspace).map((request) => request.path)).toEqual([
        "payment/Ping",
        "payment/Echo",
        "payment/nested/Deep Echo",
        "payment/Legacy Http",
        "payment/Descriptor Only",
      ]);
    } finally {
      clone.cleanup();
    }
  });

  it("givenMalformedDefinitionYaml_whenListing_thenPremanErrorNamesTheFile", () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(clone, ["payment"], "$kind: collection\nname: [unclosed\n");

      // A file that may carry auth and scripts must never be silently ignored.
      expect(() => listRequests(clone.workspace)).toThrow(PremanError);
      expect(() => listRequests(clone.workspace)).toThrow(definitionPath(clone.root, "payment"));
    } finally {
      clone.cleanup();
    }
  });

  it("givenDefinitionYamlWithWrongTypes_whenListing_thenPremanErrorListsTheZodIssue", () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(clone, ["payment"], "$kind: collection\nname: payment\norder: soon\n");

      try {
        listRequests(clone.workspace);
        expect.unreachable("listRequests should have thrown");
      } catch (cause) {
        expect(cause).toBeInstanceOf(PremanError);
        const error = cause as PremanError;
        expect(error.message).toContain(definitionPath(clone.root, "payment"));
        expect(error.details.join("\n")).toContain("order");
      }
    } finally {
      clone.cleanup();
    }
  });
});

describe("environments", () => {
  it("givenFixtureEnvironment_whenLoaded_thenSkipsDisabledValues", () => {
    const env = findEnvironment(fixtureWorkspace(), "LOCAL");
    expect(env?.values).toEqual({
      grpc_url: "",
      trans_id: "",
      greeting: "hello",
      mode: "SUCCEED",
      nested_token: "{{greeting}} world",
    });
    expect(env?.values.disabled_var).toBeUndefined();
    expect(listEnvironments(fixtureWorkspace()).map((e) => e.name)).toEqual(["LOCAL"]);
  });

  it("givenGlobals_whenLoaded_thenReturnsValues", () => {
    expect(loadGlobals(fixtureWorkspace())).toEqual({
      greeting: "overridden-by-environment",
      global_only: "from-globals",
    });
  });

  it("givenExistingAndNewKeys_whenSaving_thenPreservesCommentsAndOrder", () => {
    const clone = cloneFixtureWorkspace();
    try {
      const file = join(clone.root, "postman/environments/LOCAL.environment.yaml");
      saveEnvironmentValues(file, { trans_id: "2607251234567890123", brand_new: "yes" });
      const after = readFileSync(file, "utf8");

      expect(after).toContain("# Local development environment.");
      expect(after).toContain("# empty on purpose: exercises the config fallback");
      expect(after.indexOf("key: grpc_url")).toBeLessThan(after.indexOf("key: trans_id"));

      const reloaded = findEnvironment(clone.workspace, "LOCAL");
      expect(reloaded?.values.trans_id).toBe("2607251234567890123");
      expect(reloaded?.values.brand_new).toBe("yes");
      // Untouched keys keep their values.
      expect(reloaded?.values.greeting).toBe("hello");
    } finally {
      clone.cleanup();
    }
  });

  it("givenNoUpdates_whenSaving_thenFileIsUntouched", () => {
    const clone = cloneFixtureWorkspace();
    try {
      const file = join(clone.root, "postman/environments/LOCAL.environment.yaml");
      const before = readFileSync(file, "utf8");
      saveEnvironmentValues(file, {});
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally {
      clone.cleanup();
    }
  });
});
