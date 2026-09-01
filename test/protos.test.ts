import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProtoCache } from "@preman/core/api/protos.js";
import { readVariables } from "@preman/core/api/variables.js";
import { PremanError } from "@preman/core/errors.js";
import { cloneFixtureWorkspace, FIXTURE_WS, type ClonedWorkspace } from "./helpers.js";

const ECHO = "test.echo.EchoService.Echo";
const PING = "test.echo.EchoService.Ping";
const CHAT = "test.echo.StreamService.Chat";

let clone: ClonedWorkspace | undefined;

afterEach(() => {
  clone?.cleanup();
  clone = undefined;
});

function resourcesPath(root: string): string {
  return join(root, ".postman/resources.yaml");
}

/** Add a spec to a clone's `localResources.specs`, which is relative to `.postman/`. */
function declareSpec(root: string, relative: string): void {
  const file = resourcesPath(root);
  writeFileSync(file, `${readFileSync(file, "utf8").trimEnd()}\n    - ${relative}\n`);
}

function writeProto(root: string, name: string, source: string): string {
  const file = join(root, "src/main/proto/echo", name);
  writeFileSync(file, source);
  return file;
}

describe("proto index", () => {
  it("givenEveryDeclaredProto_whenListMethods_thenAllMethodsAreOffered", () => {
    const index = new ProtoCache(FIXTURE_WS).index();

    expect(index.warnings).toEqual([]);
    expect(index.methods.map((method) => method.methodPath)).toEqual([ECHO, PING]);
    expect(index.methods[0]).toMatchObject({
      serviceName: "test.echo.EchoService",
      methodName: "Echo",
      requestType: "test.echo.EchoRequest",
      responseType: "test.echo.EchoReply",
      streaming: false,
    });
    expect(index.methods[0]?.spec).toContain("echo.proto");
  });

  it("givenStreamingMethod_whenListMethods_thenItIsOfferedAndMarkedStreaming", () => {
    clone = cloneFixtureWorkspace();
    declareSpec(clone.root, "../src/main/proto/echo/streaming.proto");

    const streaming = new ProtoCache(clone.root).index().methods.filter((method) => method.streaming);

    // Listed rather than hidden: a method missing from a picker reads as a broken index,
    // and the refusal belongs to the send. Same treatment the tree gives a websocket.
    expect(streaming.map((method) => method.methodPath)).toContain(CHAT);
  });

  it("givenUndeclaredProto_whenListMethods_thenItsMethodsAreAbsent", () => {
    // `streaming.proto` sits beside the declared ones and is not in resources.yaml.
    const paths = new ProtoCache(FIXTURE_WS).index().methods.map((method) => method.methodPath);
    expect(paths).not.toContain(CHAT);
  });

  it("givenUnloadableSpec_whenListMethods_thenOtherSpecsStillOfferMethods", () => {
    clone = cloneFixtureWorkspace();
    declareSpec(clone.root, "../src/main/proto/echo/broken.proto");
    writeProto(clone.root, "broken.proto", 'syntax = "proto3"; this is not a proto;\n');

    const index = new ProtoCache(clone.root).index();

    expect(index.methods.map((method) => method.methodPath)).toEqual([ECHO, PING]);
    expect(index.warnings.join("\n")).toContain("broken.proto");
  });

  it("givenOpenApiSpecDeclared_whenListMethods_thenItIsSkippedWithoutWarning", () => {
    // Postman's `localResources.specs` holds every local API spec, OpenAPI included. Feeding
    // one to proto-loader fails with `illegal token 'openapi'`, which is preman's problem
    // and not the workspace's, so it is dropped rather than reported.
    clone = cloneFixtureWorkspace();
    declareSpec(clone.root, "../docs/service-openapi.yaml");
    mkdirSync(join(clone.root, "docs"), { recursive: true });
    writeFileSync(join(clone.root, "docs/service-openapi.yaml"), 'openapi: "3.0.0"\n');

    const index = new ProtoCache(clone.root).index();

    expect(index.warnings).toEqual([]);
    expect(index.methods.map((method) => method.methodPath)).toEqual([ECHO, PING]);
  });

  it("givenUnchangedSpec_whenIndexedTwice_thenTheParseIsCached", () => {
    clone = cloneFixtureWorkspace();
    const cache = new ProtoCache(clone.root);
    const first = cache.index().methods[0];

    expect(cache.index().methods[0]).toBe(first);

    const spec = join(clone.root, "src/main/proto/echo/echo.proto");
    const later = new Date(Date.now() + 5_000);
    utimesSync(spec, later, later);

    expect(cache.index().methods[0]).not.toBe(first);
    expect(cache.index().methods[0]?.methodPath).toBe(ECHO);
  });
});

describe("message skeleton", () => {
  it("givenMethodPath_whenSkeletonRequested_thenJsonMatchesDescriptorFields", () => {
    const skeleton = JSON.parse(new ProtoCache(FIXTURE_WS).skeleton(ECHO)) as Record<string, unknown>;

    // Field order and names are the descriptor's, and `keepCase` is on for every load in
    // this engine, so `trans_id` is written as declared rather than camel-cased.
    expect(Object.keys(skeleton)).toEqual(["text", "amount", "trans_id", "mode"]);
    expect(skeleton.text).toBe("");
    // A string, because LOAD_OPTIONS is `longs: String` and that is what keeps a 19-digit
    // id lossless. A skeleton emitting `0` would not match the workspace's own requests.
    expect(skeleton.amount).toBe("0");
    expect(skeleton.mode).toBe("MODE_UNSPECIFIED");
  });

  it("givenEnvKeyMatchingFieldName_whenSkeletonRequested_thenFieldUsesToken", () => {
    const keys = readVariables(FIXTURE_WS, "LOCAL").bindings.map((binding) => binding.key);
    const skeleton = JSON.parse(new ProtoCache(FIXTURE_WS).skeleton(ECHO, keys)) as Record<string, unknown>;

    // `trans_id` is a key in LOCAL, so the template names it instead of leaving a blank
    // the reader has to know to fill in. `text` is not, so it stays empty.
    expect(skeleton.trans_id).toBe("{{trans_id}}");
    expect(skeleton.text).toBe("");
    // Only string fields take a token: `mode` is an enum in LOCAL too, and `"{{mode}}"`
    // there would be a template that no longer matches its own field type.
    expect(skeleton.mode).toBe("MODE_UNSPECIFIED");
  });

  it("givenNestedRepeatedAndMapFields_whenSkeletonRequested_thenShapesAreTemplated", () => {
    clone = cloneFixtureWorkspace();
    declareSpec(clone.root, "../src/main/proto/echo/shapes.proto");
    writeProto(
      clone.root,
      "shapes.proto",
      `syntax = "proto3";
package test.shapes;
import "echo/common.proto";
message Leaf { string label = 1; }
message Branch {
  Leaf leaf = 1;
  repeated Leaf leaves = 2;
  map<string, Leaf> by_name = 3;
  test.echo.ReturnCode code = 4;
  repeated string tags = 5;
  Branch child = 6;
  message Inner { bool flag = 1; }
  Inner inner = 7;
}
service ShapeService { rpc Shape(Branch) returns (Leaf); }
`,
    );

    const skeleton = JSON.parse(new ProtoCache(clone.root).skeleton("test.shapes.ShapeService.Shape")) as Record<
      string,
      unknown
    >;

    expect(skeleton.leaf).toEqual({ label: "" });
    // One element, not `[]`: an empty array says nothing about the shape to fill in, and
    // the shape is the whole reason to generate a template.
    expect(skeleton.leaves).toEqual([{ label: "" }]);
    expect(skeleton.tags).toEqual([""]);
    // A map's keys are data, so an invented example key would read as a required one.
    expect(skeleton.by_name).toEqual({});
    // Cross-file reference, resolved through the same include dirs a run uses.
    expect(skeleton.code).toBe("RETURN_CODE_UNSPECIFIED");
    expect(skeleton.inner).toEqual({ flag: false });
    // A self-reference stops here rather than recursing forever.
    expect(skeleton.child).toEqual({});
  });

  it("givenUnknownMethod_whenSkeletonRequested_thenTheErrorListsWhatIsAvailable", () => {
    const cache = new ProtoCache(FIXTURE_WS);

    try {
      cache.skeleton("test.echo.EchoService.Nope");
      expect.unreachable("an unknown method must be refused");
    } catch (cause) {
      expect(cause).toBeInstanceOf(PremanError);
      expect((cause as PremanError).details.join("\n")).toContain(ECHO);
    }
  });
});
