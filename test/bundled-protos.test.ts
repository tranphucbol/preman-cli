/**
 * The vendored `google/**` import root (ADR 045).
 *
 * Its own file rather than a block in `workspace.test.ts`, because the subject is different:
 * `workspace.test.ts` asserts how include dirs are *derived* from a workspace, and these assert
 * what preman adds to that list out of its own package. The two share `deriveIncludeDirs` and
 * nothing else.
 *
 * These load protos for real. Asserting the shape of an include-dir array would pass just as
 * happily against the arrangement that produced the reported `ENOENT`.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as protoLoader from "@grpc/proto-loader";
import { describe, expect, it, onTestFinished } from "vitest";
import { LOAD_OPTIONS } from "@preman/core/grpc/schema.js";
import { requireWorkspace } from "@preman/core/workspace/discover.js";
import { bundledProtoRoot, withBundledProtoRoot } from "@preman/core/workspace/bundled.js";
import { loadResources } from "@preman/core/workspace/resources.js";
import { FIXTURE_HTTP_WS, fixtureWorkspace } from "./helpers.js";

const ANNOTATIONS = "google/api/annotations.proto";
/** Bundled by protobufjs itself, so the vendored tree must not hold a copy. */
const ALREADY_BUNDLED = "google/protobuf/timestamp.proto";

/** Writes `files` into a fresh temp dir and returns it, registering its own cleanup. */
function tempTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "preman-bundled-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
}

function proto(...lines: string[]): string {
  return lines.join("\n");
}

function load(spec: string, includeDirs: string[]): { ok: boolean; keys: string[]; message: string } {
  try {
    const pkg = protoLoader.loadSync(spec, { ...LOAD_OPTIONS, includeDirs });
    return { ok: true, keys: Object.keys(pkg), message: "" };
  } catch (cause) {
    return { ok: false, keys: [], message: (cause as Error).message };
  }
}

describe("bundled google protos", () => {
  it("givenTheSourceTree_whenTheBundledRootIsResolved_thenItHoldsTheGoogleApiProtos", () => {
    const root = bundledProtoRoot();
    expect(root).toBeDefined();
    expect(existsSync(join(root ?? "", ANNOTATIONS))).toBe(true);
    // protobufjs answers `google/protobuf/*` from its own map before an include dir is
    // consulted, so a copy here would be weight the loader cannot reach.
    expect(existsSync(join(root ?? "", ALREADY_BUNDLED))).toBe(false);
  });

  it("givenAProtoImportingGoogleApiAnnotations_whenLoadedWithTheBundledRoot_thenItResolves", () => {
    const dir = tempTree({
      "svc.proto": proto(
        'syntax = "proto3";',
        "package svc;",
        `import "${ANNOTATIONS}";`,
        "service S { rpc Get (Req) returns (Req) { option (google.api.http) = { get: '/v1/x' }; } }",
        "message Req { string id = 1; }",
      ),
    });
    const spec = join(dir, "svc.proto");

    // The reported failure: with only the spec's own ancestors, proto-loader falls back to
    // resolving beside the importer and opens a path that was never going to exist.
    const without = load(spec, [dir]);
    expect(without.ok).toBe(false);
    expect(without.message).toContain(join(dir, ANNOTATIONS));

    expect(load(spec, withBundledProtoRoot([dir])).keys).toContain("svc.S");
  });

  it("givenARepoShippingItsOwnGoogleApiCopy_whenLoaded_thenTheRepoCopyWins", () => {
    // Last place is the whole contract: the version a repo compiles against is the one its
    // generated code expects, so preman's copy must never displace it.
    const dir = tempTree({
      [ANNOTATIONS]: proto('syntax = "proto3";', "package google.api;", "message LocalMarker { string who = 1; }"),
      "svc.proto": proto(
        'syntax = "proto3";',
        "package svc;",
        `import "${ANNOTATIONS}";`,
        "message Req { string id = 1; }",
      ),
    });

    expect(load(join(dir, "svc.proto"), withBundledProtoRoot([dir])).keys).toContain("google.api.LocalMarker");
  });

  it("givenAWorkspace_whenIncludeDirsAreRead_thenOnlyTheLoadingListCarriesTheBundledRoot", () => {
    const resources = loadResources(fixtureWorkspace());
    const root = bundledProtoRoot() ?? "";

    // The printed list describes the workspace. Naming preman's own root on every listing
    // would be a row the reader cannot act on.
    expect(resources.includeDirs).not.toContain(root);
    expect(resources.includeDirsFor(resources.specs[0] ?? "").at(-1)).toBe(root);
  });

  it("givenAnHttpOnlyWorkspace_whenAProtoIsLoaded_thenTheBundledRootIsStillOffered", () => {
    // No `resources.yaml` means no declared specs, but a caller can still load a proto by
    // path, and a `google/` import should not depend on a file the workspace never needed.
    expect(loadResources(requireWorkspace(FIXTURE_HTTP_WS)).includeDirsFor("anything.proto")).toEqual([
      bundledProtoRoot(),
    ]);
  });
});
