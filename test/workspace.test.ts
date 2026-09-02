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
import {
  canonicalSharedPath,
  DEFAULT_SHARED_PROTO_ROOT,
  ownCheckoutPath,
  resolveSharedPath,
} from "@preman/core/workspace/links.js";
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

  it("givenSpecUnderSharedLink_whenDerivingIncludeDirs_thenWalksUpToTheLink", () => {
    const shared = `${sep}shared`;
    const dirs = deriveIncludeDirs([join(shared, "zas-spec/api/zas/admin/admin.proto")], `${sep}repo`, shared);
    // The link stands for a checkout, so its whole tree is offered — which is what lets
    // a package-qualified `import "zas/common.proto"` resolve against `api`.
    expect(dirs).toEqual([
      join(shared, "zas-spec"),
      join(shared, "zas-spec/api"),
      join(shared, "zas-spec/api/zas"),
      join(shared, "zas-spec/api/zas/admin"),
    ]);
    // Never the shared root itself: that would let one checkout's proto satisfy another's import.
    expect(dirs).not.toContain(shared);
  });

  it("givenSpecOutsideWorkspaceAndSharedRoot_whenDerivingIncludeDirs_thenOnlyItsOwnDirectory", () => {
    const dirs = deriveIncludeDirs(
      [join(`${sep}elsewhere`, "zas-spec/api/zas/admin/admin.proto")],
      `${sep}repo`,
      `${sep}shared`,
    );
    // Walking an arbitrary absolute path further would offer $HOME as an import root.
    expect(dirs).toEqual([join(`${sep}elsewhere`, "zas-spec/api/zas/admin")]);
  });
});

describe("shared links", () => {
  const LOCAL = "/opt/protos";
  const ON_LINK = join(LOCAL, "zas-spec", "api/zas/admin/admin.proto");
  const CANONICAL = join(DEFAULT_SHARED_PROTO_ROOT, "zas-spec", "api/zas/admin/admin.proto");

  it("givenAResolvedPathOnALink_whenMadeCanonical_thenItIsWrittenWithTheDefaultRoot", () => {
    expect(canonicalSharedPath(ON_LINK, LOCAL)).toBe(CANONICAL);
  });

  it("givenAPathOutsideTheSharedRoot_whenMadeCanonical_thenItIsNotOnALink", () => {
    expect(canonicalSharedPath("/repos/zas-spec/api/zas/admin/admin.proto", LOCAL)).toBeUndefined();
  });

  it("givenTheSharedRootItself_whenMadeCanonical_thenItIsNotOnALink", () => {
    expect(canonicalSharedPath(LOCAL, LOCAL)).toBeUndefined();
  });

  /**
   * The pair is what keeps an overridden root portable: the picker writes what
   * `canonicalSharedPath` says, and every reader takes it back through `resolveSharedPath`.
   * If they ever stop being inverses, a workspace declares one file and opens another.
   */
  it("givenACanonicalPath_whenResolvedAndMadeCanonicalAgain_thenItRoundTrips", () => {
    expect(resolveSharedPath(CANONICAL, LOCAL)).toBe(ON_LINK);
    expect(canonicalSharedPath(resolveSharedPath(CANONICAL, LOCAL), LOCAL)).toBe(CANONICAL);
  });

  it("givenTheDefaultRoot_whenMadeCanonical_thenThePathIsUnchanged", () => {
    expect(canonicalSharedPath(CANONICAL, DEFAULT_SHARED_PROTO_ROOT)).toBe(CANONICAL);
  });
});

/**
 * The workspace's own checkout as the resolver's second root (ADR 042). Asserted over paths
 * rather than over a real clone: `ownCheckoutPath` reads no filesystem, and the cases that need
 * a `.git` marker and a resolved file live in `specs.test.ts`.
 */
describe("the own checkout", () => {
  const LOCAL = "/opt/protos";
  const CHECKOUT = "/Users/bob/work/refund-core";
  const REST = "api/acquiring_refund/v1/refund.proto";
  const DECLARED = join(LOCAL, "refund-core", REST);

  it("givenALinkNameMatchingTheCheckout_whenResolved_thenItReadsFromTheCheckout", () => {
    expect(ownCheckoutPath(DECLARED, LOCAL, CHECKOUT)).toBe(join(CHECKOUT, REST));
  });

  it("givenALinkNameNotMatchingTheCheckout_whenResolved_thenItIsNotOnTheCheckout", () => {
    // Decision 4 is exact: a clone in a differently-named directory gets nothing automatic,
    // because a near-miss on a link name is a guess and `refund-core-clients` is a real link.
    expect(ownCheckoutPath(DECLARED, LOCAL, `${CHECKOUT}-fix`)).toBeUndefined();
    expect(ownCheckoutPath(join(LOCAL, "refund-core-clients", "payment.proto"), LOCAL, CHECKOUT)).toBeUndefined();
  });

  it("givenTheSharedRootItself_whenResolvedAgainstACheckout_thenItIsUndefined", () => {
    expect(ownCheckoutPath(LOCAL, LOCAL, CHECKOUT)).toBeUndefined();
    expect(ownCheckoutPath("/repos/refund-core/api/refund.proto", LOCAL, CHECKOUT)).toBeUndefined();
  });

  it("givenACheckoutPath_whenMadeCanonical_thenItIsWrittenWithTheDefaultRoot", () => {
    // The resolver gained a root; the writer did not. A proto read out of the checkout is still
    // declared through the link that names it, or the picker leaks a path only this clone reads.
    expect(canonicalSharedPath(join(CHECKOUT, REST), LOCAL, CHECKOUT)).toBe(
      join(DEFAULT_SHARED_PROTO_ROOT, "refund-core", REST),
    );
  });

  it("givenACheckoutPath_whenResolvedAndMadeCanonicalAgain_thenItRoundTrips", () => {
    const canonical = join(DEFAULT_SHARED_PROTO_ROOT, "refund-core", REST);
    const read = ownCheckoutPath(resolveSharedPath(canonical, LOCAL), LOCAL, CHECKOUT);
    expect(read).toBe(join(CHECKOUT, REST));
    expect(canonicalSharedPath(read ?? "", LOCAL, CHECKOUT)).toBe(canonical);
  });

  it("givenAPathUnderNeitherRoot_whenMadeCanonical_thenItIsNotOnALink", () => {
    expect(canonicalSharedPath("/repos/zas-spec/api/admin.proto", LOCAL, CHECKOUT)).toBeUndefined();
    expect(canonicalSharedPath(CHECKOUT, LOCAL, CHECKOUT)).toBeUndefined();
  });

  it("givenASpecUnderTheCheckoutButOutsideTheWorkspace_whenDerivingIncludeDirs_thenItClimbsToTheCheckout", () => {
    const workspace = join(CHECKOUT, "tools/workspace");
    const dirs = deriveIncludeDirs([join(CHECKOUT, "pkg/client/paylater/payment.proto")], workspace, LOCAL, CHECKOUT);

    // The same import roots the link would have given, which is the equality ADR 038 rests on.
    expect(dirs).toEqual([
      CHECKOUT,
      join(CHECKOUT, "pkg"),
      join(CHECKOUT, "pkg/client"),
      join(CHECKOUT, "pkg/client/paylater"),
    ]);
  });

  it("givenNoCheckout_whenDerivingIncludeDirs_thenTheBoundariesAreUnchanged", () => {
    const spec = join(`${sep}elsewhere`, "zas-spec/api/zas/admin/admin.proto");
    expect(deriveIncludeDirs([spec], `${sep}repo`, LOCAL, undefined)).toEqual([
      join(`${sep}elsewhere`, "zas-spec/api/zas/admin"),
    ]);
    // And a checkout that the spec is not under changes nothing either.
    expect(deriveIncludeDirs([spec], `${sep}repo`, LOCAL, CHECKOUT)).toEqual([
      join(`${sep}elsewhere`, "zas-spec/api/zas/admin"),
    ]);
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
