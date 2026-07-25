import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listRequests, resolveRequest } from "../src/workspace/collections.js";
import { findWorkspace, requireWorkspace } from "../src/workspace/discover.js";
import { findEnvironment, listEnvironments, loadGlobals, saveEnvironmentValues } from "../src/workspace/environments.js";
import { deriveIncludeDirs, loadResources } from "../src/workspace/resources.js";
import { CliError } from "../src/errors.js";
import { cloneFixtureWorkspace, FIXTURE_WS, fixtureWorkspace } from "./helpers.js";
import { readFileSync } from "node:fs";

describe("discover", () => {
  it("givenNestedDirectory_whenFindWorkspace_thenWalksUpToPostmanRoot", () => {
    const ws = findWorkspace(join(FIXTURE_WS, "postman/collections/payment/nested"));
    expect(ws?.root).toBe(FIXTURE_WS);
    expect(ws?.postmanDir).toBe(join(FIXTURE_WS, "postman"));
  });

  it("givenDirectoryWithoutPostman_whenRequireWorkspace_thenThrowsCliError", () => {
    const empty = mkdtempSync(join(tmpdir(), "preman-empty-"));
    try {
      expect(findWorkspace(empty)).toBeNull();
      expect(() => requireWorkspace(empty)).toThrow(CliError);
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

describe("environments", () => {
  it("givenFixtureEnvironment_whenLoaded_thenSkipsDisabledValues", () => {
    const env = findEnvironment(fixtureWorkspace(), "LOCAL");
    expect(env?.values).toEqual({ grpc_url: "", trans_id: "", greeting: "hello", mode: "SUCCEED" });
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
