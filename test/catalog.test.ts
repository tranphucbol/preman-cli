import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCatalog, refreshCatalog, type Catalog, type CatalogNode } from "@preman/core/api/catalog.js";
import { watchWorkspace } from "@preman/core/api/watch.js";
import {
  cloneFixtureWorkspace,
  collectionPath,
  definitionPath,
  FIXTURE_HTTP_WS,
  FIXTURE_WS,
  type ClonedWorkspace,
} from "./helpers.js";

/**
 * The fixture's 5 requests plus the collection and the one folder, in Postman order:
 * `order` 10/20/30/40 on the requests, and `nested` declares none so it sorts last.
 */
const EXPECTED_ROWS = [
  "collection payment",
  "request Ping",
  "request Echo",
  "request Legacy Http",
  "request Descriptor Only",
  "folder nested",
  "request Deep Echo",
];
/** macOS FSEvents is not instant; the assertion is that events arrive, not when. */
const WATCH_SETTLE_MS = 2_000;

function rows(catalog: Catalog): string[] {
  return catalog.nodes.map((node) => `${node.kind} ${node.name}`);
}

function byName(catalog: Catalog, name: string): CatalogNode {
  const node = catalog.nodes.find((candidate) => candidate.name === name);
  if (node === undefined) throw new Error(`no catalog node named ${name}`);
  return node;
}

describe("buildCatalog", () => {
  it("givenWorkspace_whenBuildCatalog_thenNodesAreFlatAndInPostmanOrder", async () => {
    const catalog = await buildCatalog(FIXTURE_WS);

    expect(rows(catalog)).toEqual(EXPECTED_ROWS);
    expect(catalog.revision).toBe(1);
    expect(catalog.workspaceId).toBe("11111111-2222-3333-4444-555555555555");
    expect(catalog.environments.map((environment) => environment.name)).toEqual(["LOCAL"]);
    expect(catalog.specs.length).toBeGreaterThan(0);
  });

  it("givenNestedFolder_whenBuildCatalog_thenDepthAndParentIdChain", async () => {
    const catalog = await buildCatalog(FIXTURE_WS);

    const collection = byName(catalog, "payment");
    const folder = byName(catalog, "nested");
    const deep = byName(catalog, "Deep Echo");

    expect(collection).toMatchObject({ depth: 0, parentId: null, id: "postman/collections/payment" });
    expect(folder).toMatchObject({ depth: 1, parentId: collection.id, id: "postman/collections/payment/nested" });
    expect(deep).toMatchObject({
      depth: 2,
      parentId: folder.id,
      id: "postman/collections/payment/nested/Deep Echo.request.yaml",
      protocol: "grpc",
      label: "Echo",
    });
  });

  it("givenUnsupportedKind_whenBuildCatalog_thenNodeIsMarkedUnsupported", async () => {
    const catalog = await buildCatalog(FIXTURE_WS);

    expect(byName(catalog, "Legacy Http").protocol).toBe("unsupported");
    expect(byName(catalog, "Ping").protocol).toBe("grpc");
  });

  it("givenHttpWorkspace_whenBuildCatalog_thenLabelIsTheVerb", async () => {
    const catalog = await buildCatalog(FIXTURE_HTTP_WS);

    expect(byName(catalog, "Login")).toMatchObject({ protocol: "http", label: "POST" });
    expect(catalog.specs).toEqual([]);
    expect(catalog.workspaceId).toBeNull();
  });
});

describe("refreshCatalog", () => {
  let clone: ClonedWorkspace | undefined;

  afterEach(() => {
    clone?.cleanup();
    clone = undefined;
  });

  it("givenOneRequestEdited_whenRefreshCatalog_thenOnlyThatNodeIsReparsed", async () => {
    clone = cloneFixtureWorkspace();
    const before = await buildCatalog(clone.root);
    const file = collectionPath(clone.root, "payment", "Ping.request.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("test.echo.EchoService.Ping", "test.echo.EchoService.Beep"));

    const after = await refreshCatalog(before, [file]);

    expect(after.revision).toBe(before.revision + 1);
    expect(after.nodes.find((node) => node.file === file)?.label).toBe("Beep");
    // Identity is the proof: every other node came back untouched, not re-read.
    for (const node of after.nodes) {
      if (node.file === file) continue;
      expect(node).toBe(before.nodes.find((candidate) => candidate.id === node.id));
    }
  });

  it("givenRenamedRequest_whenRefreshCatalog_thenTreeIsRebuiltAndReordered", async () => {
    clone = cloneFixtureWorkspace();
    const before = await buildCatalog(clone.root);
    const file = collectionPath(clone.root, "payment", "Ping.request.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("name: Ping", "name: Aaa Ping"));

    const after = await refreshCatalog(before, [file]);

    expect(after.nodes.find((node) => node.file === file)?.name).toBe("Aaa Ping");
    expect(after.nodes.map((node) => node.name)).not.toEqual(before.nodes.map((node) => node.name));
  });

  it("givenChangedDefinition_whenRefreshCatalog_thenSubtreeIsRebuilt", async () => {
    clone = cloneFixtureWorkspace();
    const before = await buildCatalog(clone.root);
    const file = definitionPath(clone.root, "payment", "nested");
    writeFileSync(file, readFileSync(file, "utf8").replace("name: nested", "name: renested"));

    const after = await refreshCatalog(before, [file]);

    expect(after.nodes.some((node) => node.name === "renested")).toBe(true);
    expect(after.revision).toBe(before.revision + 1);
  });

  it("givenChangedEnvironment_whenRefreshCatalog_thenNodesKeepIdentity", async () => {
    clone = cloneFixtureWorkspace();
    const before = await buildCatalog(clone.root);
    const file = join(clone.root, "postman/environments/LOCAL.environment.yaml");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n  - key: added_by_test\n    value: "1"\n`);

    const after = await refreshCatalog(before, [file]);

    expect(after.environments[0]?.keys).toContain("added_by_test");
    expect(after.nodes).toBe(before.nodes);
  });

  it("givenNewRequestFile_whenRefreshCatalog_thenNodeAppears", async () => {
    clone = cloneFixtureWorkspace();
    const before = await buildCatalog(clone.root);
    const file = collectionPath(clone.root, "payment", "Fresh.request.yaml");
    writeFileSync(file, "$kind: http-request\nname: Fresh\nurl: http://127.0.0.1/x\nmethod: put\n");

    const after = await refreshCatalog(before, [file]);

    expect(after.nodes.find((node) => node.name === "Fresh")).toMatchObject({ protocol: "http", label: "PUT" });
  });
});

describe("watchWorkspace", () => {
  let clone: ClonedWorkspace | undefined;

  afterEach(() => {
    clone?.cleanup();
    clone = undefined;
  });

  it("givenExternalEdit_whenWatching_thenChangedPathsAreCoalesced", async () => {
    clone = cloneFixtureWorkspace();
    const batches: string[][] = [];
    const handle = watchWorkspace(clone.root, (paths) => batches.push(paths), { debounceMs: 20 });

    try {
      const first = collectionPath(clone.root, "payment", "Ping.request.yaml");
      const second = collectionPath(clone.root, "payment", "Echo.request.yaml");
      writeFileSync(first, readFileSync(first, "utf8"));
      writeFileSync(second, readFileSync(second, "utf8"));
      await new Promise((done) => setTimeout(done, WATCH_SETTLE_MS));
    } finally {
      handle.close();
    }

    const seen = batches.flat();
    expect(seen.some((path) => path.endsWith("Ping.request.yaml"))).toBe(true);
    expect(seen.some((path) => path.endsWith("Echo.request.yaml"))).toBe(true);
  });

  it("givenNoWatchableDirs_whenWatching_thenDegradationIsReported", () => {
    const degraded: string[] = [];
    const handle = watchWorkspace(join(FIXTURE_WS, "does-not-exist"), () => undefined, {
      onDegraded: (message) => degraded.push(message),
    });
    handle.close();

    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toContain("external edits will be missed");
  });
});
