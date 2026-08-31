import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCatalog } from "@preman/core/api/catalog.js";
import {
  createCollection,
  createEnvironmentFile,
  createFolder,
  createRequestFile,
  deleteNode,
  duplicateRequestFile,
  editRequestFile,
  moveNode,
  renameNode,
  reorderSiblings,
} from "@preman/core/api/mutate.js";
import { PremanError, EXIT } from "@preman/core/errors.js";
import { writeFileAtomic } from "@preman/core/workspace/atomic.js";
import { nextOrder, sanitiseSegment } from "@preman/core/workspace/paths.js";
import { cloneFixtureWorkspace, collectionPath, definitionPath, type ClonedWorkspace } from "./helpers.js";

/** A request file dense with the prose real workspaces carry, so edits have something to destroy. */
const COMMENTED_REQUEST = `$kind: http-request
# The name is what a selector resolves against.
name: Commented
url: http://127.0.0.1:1/thing # trailing note
method: POST
description: |-
  First paragraph, citing handler.go:120.

  Second paragraph, which must survive an unrelated edit.
headers:
  # why this header exists
  X-Trace: abc
order: 15
`;

/** The reason to press duplicate: a script and the comment explaining it. */
const SCRIPTED_REQUEST = `$kind: http-request
name: Scripted
url: http://127.0.0.1:1/thing
method: GET
scripts:
  # the assertion this request exists to make
  - type: test
    language: javascript
    code: |-
      pm.test("ok", function () {
        pm.response.to.have.status(200);
      });
order: 25
`;

let clone: ClonedWorkspace | undefined;

function ws(): ClonedWorkspace {
  clone ??= cloneFixtureWorkspace();
  return clone;
}

function payment(...segments: string[]): string {
  return collectionPath(ws().root, "payment", ...segments);
}

function writeCommentedRequest(): string {
  const file = payment("Commented.request.yaml");
  writeFileSync(file, COMMENTED_REQUEST);
  return file;
}

async function expectUsageError(run: () => Promise<unknown>): Promise<PremanError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(PremanError);
    const premanError = error as PremanError;
    expect(premanError.exitCode).toBe(EXIT.CLI);
    expect(premanError.details.length).toBeGreaterThan(0);
    return premanError;
  }
  throw new Error("expected a PremanError");
}

afterEach(() => {
  clone?.cleanup();
  clone = undefined;
});

describe("editRequestFile", () => {
  it("givenRequestWithComments_whenEditRequestFile_thenCommentsSurvive", async () => {
    const file = writeCommentedRequest();

    await editRequestFile(file, [{ path: ["method"], value: "PUT" }]);
    const after = readFileSync(file, "utf8");

    expect(after).toContain("# The name is what a selector resolves against.");
    expect(after).toContain("# trailing note");
    expect(after).toContain("# why this header exists");
    expect(after).toContain("method: PUT");
  });

  it("givenRequestWithBlockDescription_whenEditRequestFile_thenBlockScalarStylePreserved", async () => {
    const file = writeCommentedRequest();

    await editRequestFile(file, [{ path: ["headers", "X-Trace"], value: "def" }]);
    const after = readFileSync(file, "utf8");

    expect(after).toContain("description: |-");
    expect(after).toContain("  First paragraph, citing handler.go:120.");
    expect(after).toContain("  Second paragraph, which must survive an unrelated edit.");
  });

  it("givenGrpcRequest_whenEditMessageContent_thenMethodDescriptorUnchanged", async () => {
    const file = payment("Descriptor Only.request.yaml");
    const before = readFileSync(file, "utf8");
    const descriptor = /methodDescriptor: .*/.exec(before)?.[0];
    expect(descriptor).toBeDefined();

    await editRequestFile(file, [{ path: ["message", "content"], value: '{"text":"edited"}' }]);
    const after = readFileSync(file, "utf8");

    expect(after).toContain(descriptor!);
    expect(after).toContain('{"text":"edited"}');
  });

  it("givenNewKey_whenEditRequestFile_thenKeyIsAppended", async () => {
    const file = writeCommentedRequest();

    await editRequestFile(file, [{ path: ["headers", "X-Added"], value: "1" }]);

    expect(readFileSync(file, "utf8")).toContain("X-Added:");
  });

  // The pair grid writes the whole list when a row appears, then addresses that row's cell by
  // index on the next keystroke. Both edits arrive in one batch, so the second has to be able to
  // descend into what the first created; unwrapped, it met a raw JS array and `yaml` threw
  // `Expected YAML collection at queryParams`.
  it("givenListCreatedByEarlierEdit_whenLaterEditDescendsIntoIt_thenBothApply", async () => {
    const file = writeCommentedRequest();

    await editRequestFile(file, [
      { path: ["queryParams"], value: [{ key: "hehe", value: "" }] },
      { path: ["queryParams", 0, "value"], value: "hoho" },
    ]);
    const after = readFileSync(file, "utf8");

    expect(after).toContain("- key: hehe");
    expect(after).toContain("value: hoho");
  });

  it("givenMapCreatedByEarlierEdit_whenLaterEditAddsSibling_thenBothApply", async () => {
    const file = writeCommentedRequest();

    await editRequestFile(file, [
      { path: ["body"], value: { type: "json" } },
      { path: ["body", "content"], value: '{"a":1}' },
    ]);
    const after = readFileSync(file, "utf8");

    expect(after).toContain("type: json");
    expect(after).toContain('{"a":1}');
  });

  it("givenUndefinedValue_whenEditRequestFile_thenKeyIsDeleted", async () => {
    const file = writeCommentedRequest();

    await editRequestFile(file, [{ path: ["description"], value: undefined }]);
    const after = readFileSync(file, "utf8");

    expect(after).not.toContain("description:");
    expect(after).toContain("name: Commented");
  });

  it("givenEditThatBreaksSchema_whenEditRequestFile_thenOriginalFileUnchanged", async () => {
    const file = payment("Ping.request.yaml");
    const before = readFileSync(file, "utf8");

    // `methodPath` is required on a gRPC request, so removing it must be refused.
    await expectUsageError(() => editRequestFile(file, [{ path: ["methodPath"], value: undefined }]));

    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("givenEmptyPath_whenEditRequestFile_thenUsageError", async () => {
    const file = payment("Ping.request.yaml");

    await expectUsageError(() => editRequestFile(file, [{ path: [], value: 1 }]));
  });
});

describe("writeFileAtomic", () => {
  it("givenCrashBetweenWriteAndRename_whenReadRequest_thenOriginalIsIntact", () => {
    const file = payment("Ping.request.yaml");
    const before = readFileSync(file, "utf8");
    // Stand in for the crash: the temp file exists, the rename never happened.
    writeFileSync(`${file}.preman-tmp`, "half written");

    expect(readFileSync(file, "utf8")).toBe(before);
    // And the leftover is not a request, so nothing lists or runs it.
    expect(readdirSync(dirname(file)).filter((name) => name.endsWith(".request.yaml"))).not.toContain(
      `${basename(file)}.preman-tmp`,
    );
  });

  it("givenUnwritableTarget_whenWriteFileAtomic_thenPremanErrorAndNoLeftover", () => {
    const target = join(payment("Ping.request.yaml"), "nested", "impossible.yaml");

    expect(() => writeFileAtomic(target, "x")).toThrow(PremanError);
    expect(existsSync(`${target}.preman-tmp`)).toBe(false);
  });
});

describe("createRequestFile", () => {
  it("givenExistingName_whenCreateRequestFile_thenNameIsSuffixed", async () => {
    const created = await createRequestFile({ parentDir: payment(), name: "Ping", kind: "http-request" });

    expect(basename(created)).toBe("Ping (2).request.yaml");
    // The display name is not suffixed: only the filename had to be unique.
    expect(readFileSync(created, "utf8")).toContain("name: Ping");
  });

  it("givenNoOrder_whenCreateRequestFile_thenItSortsAfterEveryOrderedSibling", async () => {
    const created = await createRequestFile({ parentDir: payment(), name: "Zeta", kind: "grpc-request" });
    const catalog = await buildCatalog(ws().root);

    // The fixture's `nested` declares no order, so it still sorts after any number.
    const names = catalog.nodes.map((node) => node.name);
    expect(names.indexOf("Zeta")).toBeGreaterThan(names.indexOf("Descriptor Only"));
    expect(catalog.nodes.find((node) => node.file === created)).toMatchObject({ protocol: "grpc", order: 1040 });
  });

  it("givenUnsafeName_whenCreateRequestFile_thenUsageError", async () => {
    const error = await expectUsageError(() =>
      createRequestFile({ parentDir: payment(), name: "  ///  ", kind: "http-request" }),
    );

    expect(error.message).toContain("cannot be used as a file name");
  });

  it("givenMissingParent_whenCreateRequestFile_thenUsageError", async () => {
    await expectUsageError(() => createRequestFile({ parentDir: payment("nope"), name: "X", kind: "http-request" }));
  });
});

describe("duplicateRequestFile", () => {
  it("givenRequestWithCommentsAndScripts_whenDuplicated_thenBothSurviveByteForByte", async () => {
    const file = payment("Scripted.request.yaml");
    writeFileSync(file, SCRIPTED_REQUEST);

    const copy = await duplicateRequestFile({ target: file });
    const after = readFileSync(copy, "utf8");

    expect(after).toContain("# the assertion this request exists to make");
    expect(after).toContain('pm.test("ok", function () {');
    expect(after).toContain("    pm.response.to.have.status(200);");
    // The source is untouched: duplicate writes one new file and nothing else.
    expect(readFileSync(file, "utf8")).toBe(SCRIPTED_REQUEST);
  });

  it("givenRequest_whenDuplicated_thenNameAndFilenameBothSayCopy", async () => {
    const copy = await duplicateRequestFile({ target: payment("Ping.request.yaml") });

    // Asserted together: separately, either passes while the pair drifts.
    expect(basename(copy)).toBe("Ping copy.request.yaml");
    expect(readFileSync(copy, "utf8")).toContain("name: Ping copy");
  });

  it("givenExistingCopy_whenDuplicatedAgain_thenNameAndFilenameBothSayCopy2", async () => {
    const target = payment("Ping.request.yaml");
    await duplicateRequestFile({ target });

    const second = await duplicateRequestFile({ target });

    expect(basename(second)).toBe("Ping copy 2.request.yaml");
    expect(readFileSync(second, "utf8")).toContain("name: Ping copy 2");
  });

  it("givenGroup_whenDuplicated_thenUsageErrorSaysFoldersAreNotSupported", async () => {
    const error = await expectUsageError(() => duplicateRequestFile({ target: payment("nested") }));

    expect(error.details.join(" ")).toContain("duplicating a collection or folder is not supported");
  });

  it("givenMissingTarget_whenDuplicated_thenUsageError", async () => {
    const error = await expectUsageError(() => duplicateRequestFile({ target: payment("Nope.request.yaml") }));

    expect(error.message).toContain("does not exist");
  });

  it("givenNoOrder_whenDuplicated_thenItSortsAfterEveryOrderedSibling", async () => {
    const created = await duplicateRequestFile({ target: payment("Ping.request.yaml") });
    const catalog = await buildCatalog(ws().root);

    const names = catalog.nodes.map((node) => node.name);
    expect(names.indexOf("Ping copy")).toBeGreaterThan(names.indexOf("Descriptor Only"));
    expect(catalog.nodes.find((node) => node.file === created)).toMatchObject({ protocol: "grpc", order: 1040 });
  });

  it("givenExplicitOrder_whenDuplicated_thenTheCopyCarriesIt", async () => {
    const created = await duplicateRequestFile({ target: payment("Ping.request.yaml"), order: 42 });

    expect(readFileSync(created, "utf8")).toContain("order: 42");
  });
});

describe("createFolder and createCollection", () => {
  it("givenCollection_whenCreateFolder_thenCatalogShowsItLast", async () => {
    const dir = await createFolder({ parentDir: payment(), name: "Fresh Folder" });
    await createRequestFile({ parentDir: dir, name: "Inner", kind: "http-request" });
    const catalog = await buildCatalog(ws().root);

    const folder = catalog.nodes.find((node) => node.name === "Fresh Folder");
    expect(folder).toMatchObject({ kind: "folder", depth: 1 });
    expect(catalog.nodes.find((node) => node.name === "Inner")).toMatchObject({
      depth: 2,
      parentId: folder?.id,
    });
  });

  it("givenWorkspace_whenCreateCollection_thenItAppearsAtDepthZero", async () => {
    const dir = await createCollection({ root: ws().root, name: "billing" });
    await createRequestFile({ parentDir: dir, name: "Charge", kind: "http-request" });
    const catalog = await buildCatalog(ws().root);

    expect(catalog.nodes.find((node) => node.name === "billing")).toMatchObject({
      kind: "collection",
      depth: 0,
      parentId: null,
    });
  });
});

describe("createEnvironmentFile", () => {
  it("givenWorkspace_whenCreateEnvironmentFile_thenCatalogListsIt", async () => {
    const file = await createEnvironmentFile({ root: ws().root, name: "STAGING" });
    const catalog = await buildCatalog(ws().root);

    expect(basename(file)).toBe("STAGING.environment.yaml");
    expect(catalog.environments.map((environment) => environment.name).sort()).toEqual(["LOCAL", "STAGING"]);
    expect(catalog.environments.find((environment) => environment.name === "STAGING")?.keys).toEqual([]);
  });

  /*
   * The refusal, and why it is not the collision-resolving `Foo (2)` every other creation does: an
   * environment is reached by name, so two files behind one name is one of them lost. Case-blind
   * because `findEnvironment` is, and a refusal a lookup would not have made is a refusal that
   * blocks a name nothing was using.
   */
  it("givenNameAlreadyTaken_whenCreateEnvironmentFile_thenRefusedAndNothingIsWritten", async () => {
    const taken = await expectUsageError(() => createEnvironmentFile({ root: ws().root, name: "LOCAL" }));
    expect(taken.message).toContain('"LOCAL" already exists');
    // Case-blind, because `findEnvironment` is: `-e local` already reaches `LOCAL`.
    await expectUsageError(() => createEnvironmentFile({ root: ws().root, name: "local" }));

    const catalog = await buildCatalog(ws().root);
    expect(catalog.environments.map((environment) => environment.name)).toEqual(["LOCAL"]);
  });

  it("givenEnvironment_whenRenameNode_thenFileAndNameFieldAgree", async () => {
    const file = join(ws().root, "postman", "environments", "LOCAL.environment.yaml");

    const renamed = await renameNode({ target: file, name: "DEV" });
    const catalog = await buildCatalog(ws().root);

    expect(basename(renamed)).toBe("DEV.environment.yaml");
    expect(catalog.environments.map((environment) => environment.name)).toEqual(["DEV"]);
    // The comments the fixture relies on for writeback are still there.
    expect(readFileSync(renamed, "utf8")).toContain("# Local development environment.");
  });

  it("givenEnvironment_whenDeleteNode_thenItLeavesTheCatalog", async () => {
    await deleteNode(join(ws().root, "postman", "environments", "LOCAL.environment.yaml"));
    const catalog = await buildCatalog(ws().root);

    expect(catalog.environments).toEqual([]);
  });
});

describe("renameNode", () => {
  it("givenRequest_whenRenameNode_thenFileAndNameFieldAgree", async () => {
    const renamed = await renameNode({ target: payment("Ping.request.yaml"), name: "Pong" });

    expect(basename(renamed)).toBe("Pong.request.yaml");
    expect(readFileSync(renamed, "utf8")).toContain("name: Pong");
    expect(existsSync(payment("Ping.request.yaml"))).toBe(false);
  });

  it("givenRequestWithComments_whenRenameNode_thenCommentsSurvive", async () => {
    const renamed = await renameNode({ target: writeCommentedRequest(), name: "Renamed" });

    expect(readFileSync(renamed, "utf8")).toContain("# why this header exists");
  });

  it("givenFolder_whenRenameNode_thenDirectoryAndDefinitionAgree", async () => {
    const renamed = await renameNode({ target: payment("nested"), name: "deeper" });
    const catalog = await buildCatalog(ws().root);

    expect(basename(renamed)).toBe("deeper");
    expect(readFileSync(definitionPath(ws().root, "payment", "deeper"), "utf8")).toContain("name: deeper");
    expect(catalog.nodes.find((node) => node.kind === "folder")?.name).toBe("deeper");
  });

  it("givenSameName_whenRenameNode_thenPathIsUnchanged", async () => {
    const target = payment("Ping.request.yaml");

    expect(await renameNode({ target, name: "Ping" })).toBe(target);
  });

  it("givenMissingTarget_whenRenameNode_thenUsageError", async () => {
    await expectUsageError(() => renameNode({ target: payment("Gone.request.yaml"), name: "X" }));
  });
});

describe("moveNode", () => {
  it("givenRequest_whenMoveNode_thenItLandsInTheTargetFolder", async () => {
    const moved = await moveNode({ target: payment("Ping.request.yaml"), targetDir: payment("nested") });
    const catalog = await buildCatalog(ws().root);

    expect(moved).toBe(payment("nested", "Ping.request.yaml"));
    const folder = catalog.nodes.find((node) => node.kind === "folder");
    expect(catalog.nodes.find((node) => node.name === "Ping")).toMatchObject({
      depth: 2,
      parentId: folder?.id,
    });
  });

  it("givenMoveIntoOwnDescendant_whenMoveNode_thenUsageError", async () => {
    const error = await expectUsageError(() => moveNode({ target: payment(), targetDir: payment("nested") }));

    expect(error.message).toContain("into itself");
    expect(existsSync(payment("nested"))).toBe(true);
  });

  it("givenMoveIntoItself_whenMoveNode_thenUsageError", async () => {
    await expectUsageError(() => moveNode({ target: payment("nested"), targetDir: payment("nested") }));
  });

  it("givenCollidingName_whenMoveNode_thenFileIsSuffixed", async () => {
    await createRequestFile({ parentDir: payment("nested"), name: "Ping", kind: "http-request" });

    const moved = await moveNode({ target: payment("Ping.request.yaml"), targetDir: payment("nested") });

    expect(basename(moved)).toBe("Ping (2).request.yaml");
  });

  it("givenFolder_whenMoveNode_thenSubtreeFollows", async () => {
    const other = await createFolder({ parentDir: payment(), name: "outer" });

    const moved = await moveNode({ target: payment("nested"), targetDir: other });
    const catalog = await buildCatalog(ws().root);

    expect(existsSync(join(moved, "Deep Echo.request.yaml"))).toBe(true);
    expect(catalog.nodes.find((node) => node.name === "Deep Echo")?.depth).toBe(3);
  });
});

describe("deleteNode", () => {
  it("givenRequest_whenDeleteNode_thenItLeavesTheCatalog", async () => {
    await deleteNode(payment("Ping.request.yaml"));
    const catalog = await buildCatalog(ws().root);

    expect(catalog.nodes.some((node) => node.name === "Ping")).toBe(false);
  });

  it("givenFolder_whenDeleteNode_thenSubtreeIsRemoved", async () => {
    await deleteNode(payment("nested"));
    const catalog = await buildCatalog(ws().root);

    expect(catalog.nodes.some((node) => node.name === "Deep Echo")).toBe(false);
    expect(existsSync(payment("nested"))).toBe(false);
  });

  it("givenMissingTarget_whenDeleteNode_thenUsageError", async () => {
    await expectUsageError(() => deleteNode(payment("Gone.request.yaml")));
  });
});

describe("reorderSiblings", () => {
  it("givenNewOrders_whenReorderSiblings_thenCatalogOrderFollows", async () => {
    await reorderSiblings({
      orderByFile: {
        [payment("Echo.request.yaml")]: 1,
        [payment("Ping.request.yaml")]: 2,
      },
    });
    const catalog = await buildCatalog(ws().root);

    const names = catalog.nodes.filter((node) => node.kind === "request").map((node) => node.name);
    expect(names.slice(0, 2)).toEqual(["Echo", "Ping"]);
  });

  it("givenFolder_whenReorderSiblings_thenDefinitionOrderIsWritten", async () => {
    await reorderSiblings({ orderByFile: { [payment("nested")]: 1 } });
    const catalog = await buildCatalog(ws().root);

    expect(readFileSync(definitionPath(ws().root, "payment", "nested"), "utf8")).toContain("order: 1");
    expect(catalog.nodes[1]?.name).toBe("nested");
  });

  it("givenRequestWithComments_whenReorderSiblings_thenCommentsSurvive", async () => {
    const file = writeCommentedRequest();

    await reorderSiblings({ orderByFile: { [file]: 99 } });

    expect(readFileSync(file, "utf8")).toContain("# why this header exists");
  });

  it("givenMissingRequest_whenReorderSiblings_thenUsageError", async () => {
    await expectUsageError(() => reorderSiblings({ orderByFile: { [payment("Gone.request.yaml")]: 1 } }));
  });
});

describe("paths", () => {
  it("givenAwkwardNames_whenSanitised_thenSegmentIsSafe", () => {
    expect(sanitiseSegment(" Refund / Create : v2 ")).toBe("Refund Create v2");
    expect(sanitiseSegment("trailing dots...")).toBe("trailing dots");
  });

  it("givenALongName_whenSanitised_thenItFitsAFilenameWithItsSuffix", () => {
    // Real workspaces hold requests named after a URL with its query string. The segment has to
    // leave room for `.environment.yaml` and a ` (100)` marker inside the filesystem's 255.
    const segment = sanitiseSegment(`https://host/search?q=${"long".repeat(200)}`);

    expect(Buffer.byteLength(`${segment} (100).environment.yaml.preman-tmp`)).toBeLessThanOrEqual(255);
    expect(segment.startsWith("https host search q=long")).toBe(true);
  });

  it("givenAMultibyteName_whenSanitised_thenTheLimitIsBytesAndNoCharacterIsSplit", () => {
    // The limit is bytes, so a Vietnamese name reaches it well before 221 characters.
    const vietnamese = sanitiseSegment("Chuyển tiền ".repeat(40));
    expect(Buffer.byteLength(vietnamese)).toBeLessThanOrEqual(221);
    expect(vietnamese.length).toBeGreaterThan(100);

    // An emoji is four bytes and two UTF-16 units; cutting by either count would leave half.
    const emoji = sanitiseSegment("\u{1f680}".repeat(100));
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(221);
    expect([...emoji].every((character) => character === "\u{1f680}")).toBe(true);
  });

  it("givenNamesThatCannotBeFiles_whenSanitised_thenUsageError", () => {
    for (const name of ["", "   ", "..", "/", "\u0000"]) {
      expect(() => sanitiseSegment(name)).toThrow(PremanError);
    }
  });

  it("givenSiblingOrders_whenNextOrder_thenItBeatsTheHighest", () => {
    expect(nextOrder([])).toBe(1000);
    expect(nextOrder([undefined, undefined])).toBe(1000);
    expect(nextOrder([10, 40, undefined])).toBe(1040);
  });
});
