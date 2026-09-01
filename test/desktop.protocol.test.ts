import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";

import { FORMAT_LIMIT_BYTES as CORE_FORMAT_LIMIT_BYTES } from "@preman/core/api/bodies.js";
import { ORDER_ABSENT as CORE_ORDER_ABSENT } from "@preman/core/api/catalog.js";
import { EXIT } from "@preman/core/errors.js";
import { TOKEN_SOURCE as CORE_TOKEN_SOURCE } from "@preman/core/vars/interpolate.js";
import { DEFINITION_FILE, ORDER_STEP as CORE_ORDER_STEP, RESOURCES_DIR } from "@preman/core/workspace/paths.js";
import { createEngineHost, type EngineHost } from "@preman/desktop/engine/host.js";
import type {
  EngineMessage,
  EnginePayload,
  EngineRequest,
  EngineRequestKind,
  EngineResults,
  EnginePush,
  GitStatus,
  LogLevel,
  NodeDocument,
  PhaseReport,
  RunEvent,
} from "@preman/desktop/engine/protocol.js";
import {
  BODY_FORMAT_LIMIT_BYTES,
  EXIT_CODES,
  GROUP_DEFINITION_SUFFIX,
  ORDER_ABSENT,
  ORDER_STEP,
  PHASE_PREFIX,
  PHASES,
  VARIABLE_TOKEN_SOURCE,
  isEnginePush,
} from "@preman/desktop/engine/protocol.js";

import {
  cloneFixtureHttpWorkspace,
  cloneFixtureWorkspace,
  dataPath,
  HTTP_TOKEN,
  pokeUntil,
  startHttpServer,
  type ClonedWorkspace,
  type HttpTestServer,
} from "./helpers.js";

const TIMEOUT_MS = 15_000;
const RUN_SETTLE_MS = 10_000;
const POLL_MS = 25;
const PING_ID = "postman/collections/payment/Ping.request.yaml";
const PAYMENT_ID = "postman/collections/payment";
const NESTED_ID = "postman/collections/payment/nested";
const PROFILE_ID = "postman/collections/admin/Profile.request.yaml";
const ADMIN_ID = "postman/collections/admin";
const LOCAL_ENV_ID = "postman/environments/LOCAL.environment.yaml";
const ESCAPE_ID = "../../../etc/passwd";
/** Inside the root, so it fails on its contents rather than on the path check. */
const MISSING_NODE_ID = "postman/Echo/no-such-request";
/**
 * A `.proto` that will not parse. It has to actually be a `.proto`: a non-proto entry in
 * `localResources.specs` is skipped before it ever reaches the loader, so an OpenAPI document
 * here would produce no warning to log.
 */
const RESOURCES_FILE = ".postman/resources.yaml";
const UNPARSEABLE_SPEC = "src/main/proto/echo/unparseable.proto";
const UNPARSEABLE_SPEC_BODY = 'syntax = "proto3"; this is not a proto;\n';
const UNPARSEABLE_SPEC_ENTRY = `    - ../${UNPARSEABLE_SPEC}\n`;
const ECHO_NODE_ID = "postman/collections/payment/Echo.request.yaml";
/** The one fixture request with no `metadata` key at all, which is the shape that matters here. */
const DESCRIPTOR_ONLY_ID = "postman/collections/payment/Descriptor Only.request.yaml";
const FIRST_REQUEST_ID = 1;

const ECHO_METHOD = "test.echo.EchoService.Echo";
const PING_METHOD = "test.echo.EchoService.Ping";
const ECHO_SPEC_LABEL = "src/main/proto/echo/echo.proto";
/** Exactly what `Ping.request.yaml` already carries, which is the point of the assertion. */
const PING_LOCATION = "../../../src/main/proto/echo/echo.proto";
const GIT_SETTLE_MS = 10_000;
/**
 * Node's recursive `fs.watch` on Linux holds one inotify watch per file, and a `rename` over that
 * file drops it for good. Every workspace write is a temp-plus-rename (`workspace/atomic.ts`), so
 * an external edit that *follows* the app's own save is undetectable there however long we poke.
 * Reproduced outside preman: replace a file via temp+rename, then write it in place, and node
 * reports nothing where bun reports the write. macOS keeps delivering because FSEvents watches
 * paths rather than inodes. The two sibling cases below still cover the watcher on Linux; only the
 * one that needs a second event *after* a save cannot pass. See `docs/decisions/032`.
 */
const WATCH_SURVIVES_OWN_SAVE = process.platform !== "linux";

const SUITE_ID = "postman/collections/admin/suite";
const QC_ENV_PATH = "postman/environments/QC.environment.yaml";
const REQUEST_SUFFIX = ".request.yaml";
const SEPARATOR_LENGTH = 1;
/** `test/fixtures/data/users.csv` has two rows, and one request runs once per row. */
const CSV_ROWS = 2;
const MARKER_KEY = "run_marker";

/**
 * The strings the two token patterns are compared over. Each one is a case where a naive copy
 * would disagree: empty braces, surrounding whitespace, adjacency, a nested brace, and a token
 * split across a line.
 */
const TOKEN_CORPUS = [
  "{{greeting}}",
  "{{ greeting }}",
  "{{}}",
  "{{ }}",
  "a{{one}}b{{two}}c",
  "{{{nested}}}",
  "{{multi\nline}}",
  "{{a}}{{b}}",
  "no tokens here",
  "{{$guid}} {{$randomInt}}",
];
const MARKER = "written-by-a-script";

/** Succeeds outright: the collection's own auth is not needed and `/echo` answers 200. */
const ECHOED_YAML = `$kind: http-request
name: Echoed
url: "{{http_url}}/echo"
method: POST
auth:
  type: noauth
body:
  type: text
  content: '{"from":"the runner"}'
`;

/** A call that works and an assertion that does not, which is exactly `EXIT.TEST`. */
const FAILING_YAML = `$kind: http-request
name: Failing
url: "{{http_url}}/echo"
method: GET
auth:
  type: noauth
scripts:
  - type: afterResponse
    language: text/javascript
    code: |-
      pm.test("deliberately fails", function () {
        pm.expect(1).to.equal(2);
      });
`;

/**
 * Port 1 is reserved and nothing listens there, so the connection is refused immediately: a
 * transport failure with no timeout to wait out.
 */
const UNREACHABLE_YAML = `$kind: http-request
name: Unreachable
url: "http://127.0.0.1:1/nope"
method: GET
auth:
  type: noauth
`;

const MARKER_YAML = `$kind: http-request
name: Marker
url: "{{http_url}}/echo"
method: GET
auth:
  type: noauth
scripts:
  - type: afterResponse
    language: text/javascript
    code: |-
      pm.environment.set("${MARKER_KEY}", "${MARKER}");
`;

/**
 * A host plus the messages it pushed, which is the whole of what a renderer sees. Requests carry
 * their own ids here for the same reason the real client mints them: a response is only useful
 * if it can be matched to a call.
 */
interface LoggedLine {
  level: LogLevel;
  line: string;
}

interface Harness {
  host: EngineHost;
  pushes: EngineMessage[];
  /** What the host said to its log sink. Every failure below reaches it and the caller both. */
  logged: LoggedLine[];
  send<K extends EngineRequestKind>(kind: K, payload: EnginePayload<K>): Promise<EngineResults[K]>;
  fail<K extends EngineRequestKind>(
    kind: K,
    payload: EnginePayload<K>,
  ): Promise<{ message: string; details: string[]; exitCode: number }>;
  events(): RunEvent[];
  pushesOf<P extends EnginePush["push"]>(push: P): Extract<EnginePush, { push: P }>[];
}

function harnessFor(root: string): Harness {
  const pushes: EngineMessage[] = [];
  const logged: LoggedLine[] = [];
  let nextId = FIRST_REQUEST_ID;
  const host = createEngineHost({
    root,
    post: (message) => {
      pushes.push(message);
    },
    log: (level, line) => logged.push({ level, line }),
  });

  async function respond<K extends EngineRequestKind>(kind: K, payload: EnginePayload<K>) {
    const request = { id: nextId++, kind, ...payload } as unknown as EngineRequest;
    return host.handle(request);
  }

  return {
    host,
    pushes,
    logged,
    async send(kind, payload) {
      const response = await respond(kind, payload);
      if (!response.ok) {
        throw new Error(`${kind} failed: ${response.error.message} :: ${response.error.details.join(" | ")}`);
      }
      return response.data as never;
    },
    async fail(kind, payload) {
      const response = await respond(kind, payload);
      if (response.ok) throw new Error(`${kind} unexpectedly succeeded`);
      return response.error;
    },
    events() {
      return pushes
        .filter(
          (message): message is Extract<EnginePush, { push: "run-event" }> =>
            isEnginePush(message) && message.push === "run-event",
        )
        .map((message) => message.event);
    },
    pushesOf(push) {
      return pushes.filter(
        (message): message is Extract<EnginePush, { push: typeof push }> =>
          isEnginePush(message) && message.push === push,
      );
    },
  };
}

async function waitForRunDone(harness: Harness, runId: string): Promise<Extract<EnginePush, { push: "run-done" }>> {
  const deadline = Date.now() + RUN_SETTLE_MS;
  while (Date.now() < deadline) {
    const done = harness.pushesOf("run-done").find((message) => message.runId === runId);
    if (done !== undefined) return done;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`run ${runId} never finished`);
}

/**
 * A committed repository around a cloned workspace, so a later edit is a real `modified` row
 * rather than the whole tree being untracked. The identity is set locally because a CI runner
 * has no global one and `git commit` refuses without it.
 */
function initRepository(root: string): void {
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  run("init", "--quiet");
  run("config", "user.email", "test@preman.local");
  run("config", "user.name", "preman test");
  run("add", "--all");
  run("commit", "--quiet", "--message", "fixture");
}

/**
 * The push is driven by the watcher, so the edit has to be repeated rather than made once —
 * see `pokeUntil`. `touch` writes the same bytes every time, so what git reports cannot drift
 * with the number of attempts.
 */
async function waitForGitStatus(harness: Harness, touch: () => void): Promise<GitStatus> {
  await pokeUntil(touch, () => harness.pushesOf("git-status").length > 0, GIT_SETTLE_MS);
  const pushed = harness.pushesOf("git-status").at(-1);
  if (pushed === undefined) throw new Error("the git status was never pushed");
  return pushed.status;
}

describe("the engine host protocol", () => {
  let clone: ClonedWorkspace | undefined;
  let harness: Harness | undefined;

  function open(): Harness {
    clone ??= cloneFixtureWorkspace();
    harness ??= harnessFor(clone.root);
    return harness;
  }

  function root(): string {
    open();
    if (clone === undefined) throw new Error("unreachable");
    return clone.root;
  }

  afterEach(() => {
    harness?.host.dispose();
    harness = undefined;
    clone?.cleanup();
    clone = undefined;
  });

  describe("catalog", () => {
    it("givenWorkspace_whenCatalogRequested_thenNodesAreFlatAndRooted", async () => {
      const catalog = await open().send("catalog", {});

      expect(catalog.root).toBe(root());
      expect(catalog.nodes.map((node) => `${node.kind} ${node.name}`)).toEqual([
        "collection payment",
        "request Ping",
        "request Echo",
        "request Legacy Http",
        "request Descriptor Only",
        "folder nested",
        "request Deep Echo",
      ]);
      expect(catalog.environments.map((environment) => environment.name)).toContain("LOCAL");
    });

    it("givenCatalogRequestedTwice_whenNothingChanged_thenRevisionIsStable", async () => {
      const first = await open().send("catalog", {});
      const second = await open().send("catalog", {});

      expect(second.revision).toBe(first.revision);
      expect(second.nodes).toBe(first.nodes);
    });

    it("givenMutation_whenApplied_thenCatalogIsPushedWithoutBeingAsked", async () => {
      const app = open();
      await app.send("catalog", {});
      const before = app.pushesOf("catalog").length;

      await app.send("mutate", { op: { op: "create-folder", parentId: PAYMENT_ID, name: "Refunds" } });

      const pushed = app.pushesOf("catalog");
      expect(pushed.length).toBe(before + 1);
      expect(pushed.at(-1)?.catalog.nodes.some((node) => node.name === "Refunds")).toBe(true);
    });
  });

  describe("read-node and write-node", () => {
    it("givenRequestNode_whenRead_thenTextAndParsedDataBothArrive", async () => {
      const document = await open().send("read-node", { nodeId: PING_ID });

      expect(document.kind).toBe("request");
      expect(document.text).toContain("$kind: grpc-request");
      expect((document.data as { name: string }).name).toBe("Ping");
    });

    it("givenGroupNode_whenRead_thenItsDefinitionIsTheDocument", async () => {
      const document = await open().send("read-node", { nodeId: NESTED_ID });

      expect(document.kind).toBe("folder");
      expect(document.file.endsWith(".resources/definition.yaml")).toBe(true);
      expect((document.data as { name: string }).name).toBe("nested");
    });

    it("givenFieldEdit_whenWritten_thenTheFileChangesAndTheDocumentComesBack", async () => {
      const document = await open().send("write-node", {
        nodeId: PING_ID,
        edits: [{ path: ["description"], value: "written by the desktop app" }],
      });

      expect((document.data as { description: string }).description).toBe("written by the desktop app");
      expect(readFileSync(document.file, "utf8")).toContain("written by the desktop app");
    });

    it("givenEnvironmentNode_whenFieldEdited_thenRefusedWithReason", async () => {
      const error = await open().fail("write-node", {
        nodeId: LOCAL_ENV_ID,
        edits: [{ path: ["values"], value: [] }],
      });

      expect(error.message).toContain("environment");
      expect(error.exitCode).toBe(EXIT.CLI);
    });

    it("givenNodeIdEscapingTheRoot_whenRead_thenRefused", async () => {
      const error = await open().fail("read-node", { nodeId: ESCAPE_ID });

      expect(error.message).toContain("outside the workspace");
      expect(error.exitCode).toBe(EXIT.CLI);
    });

    /**
     * A real workspace held a gRPC request whose `metadata:` was a YAML map. The editor opened
     * it, ran its scripts and showed the grid, but every save was refused with
     * `metadata: Expected array, received object` - naming a field the user had not touched,
     * because validation reads the whole document, not the delta. The map shape is legal now,
     * so a save that only changes a script has nothing to say about metadata.
     */
    it("givenMapShapedMetadataOnDisk_whenOnlyAScriptIsEdited_thenTheSaveSucceeds", async () => {
      const app = open();
      await app.send("write-node", {
        nodeId: DESCRIPTOR_ONLY_ID,
        edits: [{ path: ["metadata"], value: { "client-id": "abc", "client-key": "xyz" } }],
      });

      const document = await app.send("write-node", {
        nodeId: DESCRIPTOR_ONLY_ID,
        edits: [{ path: ["scripts"], value: [{ type: "beforeInvoke", language: "javascript", code: "// touched" }] }],
      });

      expect((document.data as { metadata: unknown }).metadata).toStrictEqual({
        "client-id": "abc",
        "client-key": "xyz",
      });
    });

    it("givenWholeListEditIntoAnAbsentListField_whenWritten_thenItLandsAsAnArray", async () => {
      const app = open();

      const document = await app.send("write-node", {
        nodeId: DESCRIPTOR_ONLY_ID,
        edits: [{ path: ["metadata"], value: [{ key: "x-tenant", value: "acme" }] }],
      });

      expect((document.data as { metadata: unknown }).metadata).toStrictEqual([{ key: "x-tenant", value: "acme" }]);
    });
  });

  describe("write-text", () => {
    it("givenValidYaml_whenWritten_thenBytesLandExactly", async () => {
      const app = open();
      const before = await app.send("read-node", { nodeId: PING_ID });
      const text = `${before.text}\n# a comment the app must not eat\n`;

      const after = await app.send("write-text", { nodeId: PING_ID, text });

      expect(after.text).toBe(text);
      expect(readFileSync(after.file, "utf8")).toBe(text);
    });

    it("givenTextTheSchemaRejects_whenWritten_thenOriginalSurvives", async () => {
      const app = open();
      const before = await app.send("read-node", { nodeId: PING_ID });

      const error = await app.fail("write-text", { nodeId: PING_ID, text: "$kind: grpc-request\n" });

      expect(error.details.length).toBeGreaterThan(0);
      expect(readFileSync(before.file, "utf8")).toBe(before.text);
    });

    it("givenUnparseableYaml_whenWritten_thenOriginalSurvives", async () => {
      const app = open();
      const before = await app.send("read-node", { nodeId: PING_ID });

      await app.fail("write-text", { nodeId: PING_ID, text: "name: [unterminated\n" });

      expect(readFileSync(before.file, "utf8")).toBe(before.text);
    });
  });

  describe("mutate", () => {
    it("givenCreateRequest_whenApplied_thenTheNewNodeIdComesBack", async () => {
      const result = await open().send("mutate", {
        op: { op: "create-request", parentId: PAYMENT_ID, name: "Health", kind: "http-request" },
      });

      expect(result.nodeId).toBe("postman/collections/payment/Health.request.yaml");
      const document = await open().send("read-node", { nodeId: result.nodeId ?? "" });
      expect((document.data as { name: string }).name).toBe("Health");
    });

    it("givenRequestNodeId_whenDuplicateOpApplied_thenCatalogShowsTheCopyBelowIt", async () => {
      const app = open();
      const result = await app.send("mutate", { op: { op: "duplicate", targetId: PING_ID, order: 15 } });

      expect(result.nodeId).toBe("postman/collections/payment/Ping copy.request.yaml");
      const catalog = await app.send("catalog", {});
      const names = catalog.nodes.filter((node) => node.kind === "request").map((node) => node.name);
      expect(names[names.indexOf("Ping") + 1]).toBe("Ping copy");
    });

    it("givenGroupNodeId_whenDuplicateOpApplied_thenTheHostReportsAUsageError", async () => {
      const error = await open().fail("mutate", { op: { op: "duplicate", targetId: PAYMENT_ID } });

      expect(error.exitCode).toBe(EXIT.CLI);
      expect(error.details.join(" ")).toContain("duplicating a collection or folder is not supported");
    });

    it("givenRename_whenApplied_thenFileAndNameFieldMoveTogether", async () => {
      const app = open();
      const result = await app.send("mutate", { op: { op: "rename", targetId: PING_ID, name: "Pong" } });

      expect(result.nodeId).toBe("postman/collections/payment/Pong.request.yaml");
      const document = await app.send("read-node", { nodeId: result.nodeId ?? "" });
      expect((document.data as { name: string }).name).toBe("Pong");
    });

    it("givenMove_whenApplied_thenTheNodeIsUnderItsNewParent", async () => {
      const app = open();
      const result = await app.send("mutate", { op: { op: "move", targetId: PING_ID, parentId: NESTED_ID } });

      expect(result.nodeId).toBe("postman/collections/payment/nested/Ping.request.yaml");
      const catalog = await app.send("catalog", {});
      expect(catalog.nodes.find((node) => node.name === "Ping")?.parentId).toBe(NESTED_ID);
    });

    it("givenMoveOfAGroupIntoItsOwnDescendant_whenApplied_thenRefused", async () => {
      const error = await open().fail("mutate", {
        op: { op: "move", targetId: PAYMENT_ID, parentId: NESTED_ID },
      });

      expect(error.exitCode).toBe(EXIT.CLI);
      expect(error.details.length).toBeGreaterThan(0);
    });

    it("givenDelete_whenApplied_thenTheFileIsGoneAndNoNodeIdIsReturned", async () => {
      const app = open();
      const document = await app.send("read-node", { nodeId: PING_ID });

      const result = await app.send("mutate", { op: { op: "delete", targetId: PING_ID } });

      expect(result.nodeId).toBeNull();
      expect(existsSync(document.file)).toBe(false);
    });

    it("givenReorder_whenApplied_thenSiblingOrderFollows", async () => {
      const app = open();
      await app.send("mutate", {
        op: {
          op: "reorder",
          orderById: {
            "postman/collections/payment/Echo.request.yaml": 1,
            [PING_ID]: 2,
          },
        },
      });

      const catalog = await app.send("catalog", {});
      const names = catalog.nodes.filter((node) => node.kind === "request").map((node) => node.name);
      expect(names.indexOf("Echo")).toBeLessThan(names.indexOf("Ping"));
    });

    it("givenCreateCollection_whenApplied_thenItAppearsAtDepthZero", async () => {
      const app = open();
      const result = await app.send("mutate", { op: { op: "create-collection", name: "Ledger" } });

      const catalog = await app.send("catalog", {});
      const created = catalog.nodes.find((node) => node.id === result.nodeId);
      expect(created?.kind).toBe("collection");
      expect(created?.depth).toBe(0);
      expect(created?.parentId).toBeNull();
    });

    it("givenCreateEnvironment_whenApplied_thenTheCatalogListsIt", async () => {
      const app = open();
      await app.send("mutate", { op: { op: "create-environment", name: "STAGING" } });

      const catalog = await app.send("catalog", {});
      expect(catalog.environments.map((environment) => environment.name)).toContain("STAGING");
    });
  });

  describe("the proto index", () => {
    it("givenDeclaredProtos_whenMethodsListed_thenEachCarriesTheSpecThatDeclaredIt", async () => {
      const choices = await open().send("list-methods", {});

      expect(choices.warnings).toEqual([]);
      expect(choices.methods.map((method) => method.methodPath)).toEqual([ECHO_METHOD, PING_METHOD]);
      expect(choices.methods[0]?.specLabel).toBe(ECHO_SPEC_LABEL);
      // Without a node id there is nothing to be relative to, so no location is invented.
      expect(choices.methods[0]?.schemaLocation).toBeUndefined();
    });

    it("givenRequestNode_whenMethodsListed_thenEachChoiceCarriesTheLocationThatRequestWouldNeed", async () => {
      const choices = await open().send("list-methods", { nodeId: PING_ID });

      // Byte for byte what the fixture already has: picking a method is two field edits,
      // and the app must arrive at the path a human would have typed.
      expect(choices.methods[0]?.schemaLocation).toBe(PING_LOCATION);
    });

    it("givenMethodAndEnvironment_whenSkeletonRequested_thenStringFieldsNamedAfterVariablesUseTokens", async () => {
      const text = await open().send("message-skeleton", { methodPath: ECHO_METHOD, environment: "LOCAL" });
      const skeleton = JSON.parse(text) as Record<string, unknown>;

      expect(Object.keys(skeleton)).toEqual(["text", "amount", "trans_id", "mode"]);
      // `trans_id` is a key in LOCAL, `text` is not, and `mode` is an enum rather than a string.
      expect(skeleton.trans_id).toBe("{{trans_id}}");
      expect(skeleton.text).toBe("");
      expect(skeleton.mode).toBe("MODE_UNSPECIFIED");
    });

    it("givenNoEnvironment_whenSkeletonRequested_thenOnlyGlobalsCanBecomeTokens", async () => {
      const text = await open().send("message-skeleton", { methodPath: ECHO_METHOD, environment: null });

      expect((JSON.parse(text) as { trans_id: string }).trans_id).toBe("");
    });

    /**
     * A spec that will not parse reaches the renderer as `warnings`, which becomes a banner the
     * user dismisses — and, before this, nothing else. The banner returns on every method pick,
     * and the log was empty every time, so there was nowhere to read which spec was at fault.
     */
    it("givenASpecThatWillNotParse_whenMethodsListed_thenEachWarningIsLoggedAsAWarning", async () => {
      const repo = cloneFixtureWorkspace();
      const app = harnessFor(repo.root);
      writeFileSync(join(repo.root, UNPARSEABLE_SPEC), UNPARSEABLE_SPEC_BODY, "utf8");
      const resources = join(repo.root, RESOURCES_FILE);
      writeFileSync(resources, readFileSync(resources, "utf8") + UNPARSEABLE_SPEC_ENTRY, "utf8");

      const choices = await app.send("list-methods", {});

      expect(choices.warnings.length).toBeGreaterThan(0);
      const warnings = app.logged.filter((entry) => entry.level === "warn");
      expect(warnings.map((entry) => entry.line).join("\n")).toContain(UNPARSEABLE_SPEC);
      // Every warning the renderer was given, not a summary of them.
      expect(warnings).toHaveLength(choices.warnings.length);
      app.host.dispose();
    });
  });

  /**
   * `handle` turns every failure into an `ok: false` response, so before this an engine-side
   * error existed only in a toast. The response is the renderer's; the line is the file's.
   */
  describe("what a failed request leaves behind", () => {
    it("givenARequestThatFails_whenItIsAnswered_thenTheFailureIsLoggedAsAnError", async () => {
      const app = open();

      await app.fail("read-node", { nodeId: MISSING_NODE_ID });

      const errors = app.logged.filter((entry) => entry.level === "error");
      expect(errors).toHaveLength(1);
      expect(errors.at(0)?.line).toContain("read-node");
    });

    /**
     * Only failures. A log that also held the successful requests would be a log of what the user
     * did, which is the traffic record 035 refused — and it would bury the one line that matters.
     */
    it("givenARequestThatSucceeds_whenItIsAnswered_thenNothingIsLogged", async () => {
      const app = open();

      await app.send("read-node", { nodeId: PING_ID });

      expect(app.logged).toStrictEqual([]);
    });
  });

  describe("grep", () => {
    it("givenQuery_whenGrepped_thenMatchesCarryNodeIdsTheAppCanOpen", async () => {
      const result = await open().send("grep", { query: "test.echo.EchoService.Ping" });

      expect(result.truncated).toBe(false);
      const match = result.matches.find((each) => each.nodeId === PING_ID);
      expect(match?.fieldPath).toEqual(["methodPath"]);
      expect(match?.where).toBe("value");
    });

    it("givenLimit_whenMoreMatchesExist_thenTheResultAdmitsItWasCut", async () => {
      const result = await open().send("grep", { query: "e", limit: 1 });

      expect(result.matches.length).toBe(1);
      expect(result.truncated).toBe(true);
    });
  });

  describe("preview", () => {
    it("givenPreviewRequest_whenHostHandlesIt_thenTextIsSubstituted", async () => {
      const preview = await open().send("preview", { text: "{{greeting}} {{greetng}}", environment: "LOCAL" });

      expect(preview.text).toBe("hello {{greetng}}");
      expect(preview.missing).toEqual(["greetng"]);
      expect(preview.unsupported).toEqual([]);
    });
  });

  describe("git decorations", () => {
    it("givenWorkspaceOutsideAnyRepository_whenGitStatusRequested_thenItSaysSoRatherThanFailing", async () => {
      const status = await open().send("git-status", {});

      expect(status.repository).toBe(false);
      expect(status.files).toEqual({});
      expect(status.warning).toBeDefined();
    });

    it(
      "givenExternalEdit_whenTheWatcherFires_thenTheStatusIsPushedWithoutBeingAsked",
      async () => {
        const repo = cloneFixtureWorkspace();
        initRepository(repo.root);
        const app = harnessFor(repo.root);
        try {
          // The watcher only starts once the catalog has been built.
          await app.send("catalog", {});
          const file = join(repo.root, ECHO_NODE_ID);
          const touched = `${readFileSync(file, "utf8")}\ndescription: touched outside the app\n`;

          const status = await waitForGitStatus(app, () => writeFileSync(file, touched));
          expect(status.repository).toBe(true);
          expect(status.files[ECHO_NODE_ID]).toBe("modified");
        } finally {
          app.host.dispose();
          repo.cleanup();
        }
      },
      TIMEOUT_MS,
    );
  });

  /**
   * `reconcile` (`engine/host.ts`) suppresses the `external-change` push for a path whose disk
   * bytes still match what this host just wrote there — content, not a timer, per
   * `docs/plans/016-unsaved-is-not-modified.md` decision 9. Each test opens its own workspace
   * and watcher, for the same reason the git-decoration test above does: sharing `open()`'s
   * harness across cases would mix one test's writes into another's push counts.
   */
  describe("the watcher and the app's own writes", () => {
    it(
      "givenAppWroteFile_whenWatcherFires_thenNoExternalChangeForThatPath",
      async () => {
        const repo = cloneFixtureWorkspace();
        const app = harnessFor(repo.root);
        try {
          // The watcher only starts once the catalog has been built.
          await app.send("catalog", {});
          const before = app.pushesOf("git-status").length;

          // Repeated because the very first write can land in the gap `docs/decisions/011`
          // describes; each retry writes the same bytes, so it stays our own write throughout.
          await pokeUntil(
            async () => {
              await app.send("write-node", {
                nodeId: PING_ID,
                edits: [{ path: ["description"], value: "written by the app" }],
              });
            },
            () => app.pushesOf("git-status").length > before,
            GIT_SETTLE_MS,
          );

          expect(app.pushesOf("external-change").some((push) => push.nodeIds.includes(PING_ID))).toBe(false);
        } finally {
          app.host.dispose();
          repo.cleanup();
        }
      },
      TIMEOUT_MS,
    );

    it.skipIf(!WATCH_SURVIVES_OWN_SAVE)(
      "givenAppWroteFileThenSomeoneElseDid_whenWatcherFires_thenExternalChangeIsPublished",
      async () => {
        const repo = cloneFixtureWorkspace();
        const app = harnessFor(repo.root);
        try {
          await app.send("catalog", {});
          const file = join(repo.root, PING_ID);

          // Let the app's own write settle first, so the next report the watcher makes is
          // unambiguously about someone else's edit.
          const settledAt = app.pushesOf("git-status").length;
          // Awaited, not `void`: an app write still in flight during the external edit below
          // rewrites the file to the app's own bytes and re-arms the host's `written` map, so the
          // edit would be filtered as ours. Serialising the phases removes that race — it is not
          // why Linux fails, which is the watcher itself and is why this case is skipped there.
          await pokeUntil(
            async () => {
              await app.send("write-node", {
                nodeId: PING_ID,
                edits: [{ path: ["description"], value: "written by the app" }],
              });
            },
            () => app.pushesOf("git-status").length > settledAt,
            GIT_SETTLE_MS,
          );

          // Different bytes than the app just wrote — a poke that repeated the app's own edit
          // would keep matching `written` and this case would never distinguish itself from the
          // one above.
          const externalBytes = `${readFileSync(file, "utf8")}\n# edited outside the app\n`;
          await pokeUntil(
            () => writeFileSync(file, externalBytes),
            () => app.pushesOf("external-change").some((push) => push.nodeIds.includes(PING_ID)),
            GIT_SETTLE_MS,
          );

          expect(readFileSync(file, "utf8")).toBe(externalBytes);
        } finally {
          app.host.dispose();
          repo.cleanup();
        }
      },
      TIMEOUT_MS,
    );

    it(
      "givenAppWroteFile_whenWatcherFires_thenCatalogAndGitStatusStillRefresh",
      async () => {
        const repo = cloneFixtureWorkspace();
        const app = harnessFor(repo.root);
        try {
          await app.send("catalog", {});
          const catalogBefore = app.pushesOf("catalog").length;
          const gitBefore = app.pushesOf("git-status").length;

          // Suppression is scoped to the `external-change` push alone (decision 10): the catalog
          // must still move a renamed row, and the git overlay must still follow the save that
          // caused it, for our own writes exactly as for anyone else's.
          await pokeUntil(
            async () => {
              await app.send("write-node", {
                nodeId: PING_ID,
                edits: [{ path: ["description"], value: "written by the app" }],
              });
            },
            () => app.pushesOf("git-status").length > gitBefore,
            GIT_SETTLE_MS,
          );

          expect(app.pushesOf("catalog").length).toBeGreaterThan(catalogBefore);
          expect(app.pushesOf("external-change").some((push) => push.nodeIds.includes(PING_ID))).toBe(false);
        } finally {
          app.host.dispose();
          repo.cleanup();
        }
      },
      TIMEOUT_MS,
    );
  });

  describe("errors crossing the port", () => {
    it("givenPremanErrorInHost_whenCrossingPort_thenDetailsSurvive", async () => {
      const error = await open().fail("read-node", { nodeId: "postman/collections/payment/Nope.request.yaml" });

      expect(error.message).toContain("Nope");
      expect(error.details.length).toBeGreaterThan(0);
      expect(error.exitCode).toBe(EXIT.CLI);
    });

    it("givenAnyFailure_whenHandled_thenHandleResolvesRatherThanRejects", async () => {
      const response = await open().host.handle({ id: 99, kind: "read-node", nodeId: ESCAPE_ID });

      expect(response.ok).toBe(false);
      expect(response.id).toBe(99);
    });

    it("givenUnknownBodyHandle_whenAsked_thenAnActionableError", async () => {
      const error = await open().fail("body-head", { handle: "body-404" });

      expect(error.message).toContain("body-404");
    });
  });

  describe("two workspaces", () => {
    it("givenTwoWorkspacesOpen_whenBothAreUsed_thenEachHostHasItsOwnState", async () => {
      const http = cloneFixtureHttpWorkspace();
      const first = open();
      const second = harnessFor(http.root);
      try {
        const grpc = await first.send("catalog", {});
        const rest = await second.send("catalog", {});

        expect(grpc.root).not.toBe(rest.root);
        expect(grpc.nodes.some((node) => node.name === "Ping")).toBe(true);
        expect(rest.nodes.some((node) => node.name === "Ping")).toBe(false);
        expect(rest.nodes.some((node) => node.name === "Profile")).toBe(true);

        // A mutation in one workspace is not visible in the other, and does not push to it.
        const pushesBefore = second.pushesOf("catalog").length;
        await first.send("mutate", { op: { op: "create-folder", parentId: PAYMENT_ID, name: "Refunds" } });
        expect(second.pushesOf("catalog").length).toBe(pushesBefore);
      } finally {
        second.host.dispose();
        http.cleanup();
      }
    });
  });

  describe("dispose", () => {
    it("givenDisposedHost_whenAskedAgain_thenItRefusesRatherThanServingStaleState", async () => {
      const app = open();
      await app.send("catalog", {});

      app.host.dispose();

      const error = await app.fail("catalog", {});
      expect(error.message).toContain("closed");
    });
  });

  describe("the phase report", () => {
    /**
     * How many times a phase has been marked in this process so far.
     *
     * Marks accumulate for the life of the process and every case in this file that opens a
     * workspace adds a pair, so an absolute count says nothing. A delta across one host's first
     * catalog request does.
     */
    const marked = (report: PhaseReport, phase: string): number =>
      report.marks.filter((mark) => mark.name === phase).length;

    it("givenAnEngineHost_whenPhasesRequested_thenTheCatalogBuildIsReported", async () => {
      const app = open();

      const before = await app.send("phases", {});
      await app.send("catalog", {});
      const after = await app.send("phases", {});

      expect(marked(after, PHASES.engineCatalogEnter) - marked(before, PHASES.engineCatalogEnter)).toBe(1);
      expect(marked(after, PHASES.engineCatalogExit) - marked(before, PHASES.engineCatalogExit)).toBe(1);
      // The origin is what makes this report comparable to the window's. Without it the numbers
      // are offsets into a process nobody else can see.
      expect(after.timeOrigin).toBeGreaterThan(0);
    });

    it("givenADisposedEngineHost_whenPhasesRequested_thenItStillAnswers", async () => {
      const app = open();
      await app.send("catalog", {});

      app.host.dispose();

      // A mark is a record of something that already happened, so there is no stale answer to
      // give — and a timeline is wanted most when the thing being diagnosed has already fallen
      // over. This is the whole of the exception `dispatch` makes.
      const report = await app.send("phases", {});
      expect(report.marks.some((mark) => mark.name === PHASES.engineCatalogExit)).toBe(true);
    });

    it("givenADisposedEngineHost_whenCatalogRequested_thenItStillRefuses", async () => {
      const app = open();
      await app.send("catalog", {});

      app.host.dispose();

      // Deliberately the same assertion `dispose` above already makes, kept here as the other
      // half of the case before it: the two sit together so that widening the hole in `dispatch`
      // past `phases` fails a case next to the one that permitted it, and not only one four
      // hundred lines away.
      const error = await app.fail("catalog", {});
      expect(error.message).toContain("closed");
    });
  });
});

describe("the engine host running requests", () => {
  let http: HttpTestServer | undefined;
  let clone: ClonedWorkspace | undefined;
  let harness: Harness | undefined;

  beforeAll(async () => {
    http = await startHttpServer();
  });

  afterAll(async () => {
    await http?.close();
  });

  afterEach(() => {
    harness?.host.dispose();
    harness = undefined;
    clone?.cleanup();
    clone = undefined;
  });

  function open(): Harness {
    clone ??= cloneFixtureHttpWorkspace();
    harness ??= harnessFor(clone.root);
    return harness;
  }

  function httpRoot(): string {
    open();
    if (clone === undefined) throw new Error("unreachable");
    return clone.root;
  }

  /**
   * The fixture's `Profile` needs `{{http_url}}` and `{{token}}`, and the host deliberately
   * passes no `vars`, so the environment file is where they have to come from.
   */
  async function primeEnvironment(app: Harness): Promise<void> {
    const environmentId = "postman/environments/QC.environment.yaml";
    const document: NodeDocument = await app.send("read-node", { nodeId: environmentId });
    const values = (document.data as { values?: { key: string; value?: string }[] }).values ?? [];
    const next = values.map((entry) =>
      entry.key === "http_url"
        ? { ...entry, value: http?.origin }
        : entry.key === "token"
          ? { ...entry, value: HTTP_TOKEN }
          : entry,
    );
    await app.send("write-text", {
      nodeId: environmentId,
      text: `name: QC\nvalues:\n${next.map((entry) => `  - key: ${entry.key}\n    value: ${entry.value ?? ""}\n    enabled: true`).join("\n")}\n`,
    });
  }

  it(
    "givenRequestNode_whenRun_thenAcknowledgementPrecedesTheEvents",
    async () => {
      const app = open();
      await primeEnvironment(app);

      const { runId } = await app.send("run", { args: { nodeId: PROFILE_ID, environment: "QC" } });
      expect(runId).toMatch(/^run-\d+$/);

      const done = await waitForRunDone(app, runId);
      expect(done.cancelled).toBe(false);
      expect(done.error).toBeUndefined();

      const types = app.events().map((event) => event.type);
      expect(types[0]).toBe("run-start");
      expect(types).toContain("request-sent");
      expect(types).toContain("response-head");
      expect(types.at(-1)).toBe("run-end");
      expect(app.events().every((event) => event.runId === runId)).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "givenResponseBody_whenRun_thenTheHandleServesWindowsAndSearch",
    async () => {
      const app = open();
      await primeEnvironment(app);

      const { runId } = await app.send("run", { args: { nodeId: PROFILE_ID, environment: "QC" } });
      await waitForRunDone(app, runId);

      const body = app.events().find((event) => event.type === "response-body");
      if (body?.type !== "response-body") throw new Error("no response body was published");

      const head = await app.send("body-head", { handle: body.handle });
      expect(head.byteLength).toBe(body.byteLength);

      const window = await app.send("body-window", { handle: body.handle, offset: 0 });
      expect(window.text).toBe(body.preview);
      expect(window.eof).toBe(true);

      const matches = await app.send("body-search", { handle: body.handle, query: "{" });
      expect(matches.length).toBeGreaterThan(0);

      await app.send("body-release", { handle: body.handle });
      const gone = await app.fail("body-head", { handle: body.handle });
      expect(gone.message).toContain(body.handle);
    },
    TIMEOUT_MS,
  );

  it(
    "givenGroupNode_whenRun_thenEveryRequestStartPairsWithAnEnd",
    async () => {
      const app = open();
      await primeEnvironment(app);

      const { runId } = await app.send("run", { args: { nodeId: ADMIN_ID, environment: "QC", timeoutMs: 5_000 } });
      const done = await waitForRunDone(app, runId);
      expect(done.cancelled).toBe(false);

      const events = app.events();
      const started = events.filter((event) => event.type === "request-start").length;
      const ended = events.filter((event) => event.type === "request-end").length;
      expect(started).toBeGreaterThan(1);
      expect(ended).toBe(started);

      const start = events.find((event) => event.type === "run-start");
      if (start?.type !== "run-start") throw new Error("no run-start");
      expect(start.total).toBe(started);
    },
    TIMEOUT_MS,
  );

  it(
    "givenCancelledRun_whenEventsKeepArriving_thenTheyAreDroppedAndRunDoneSaysCancelled",
    async () => {
      const app = open();
      await primeEnvironment(app);

      const { runId } = await app.send("run", { args: { nodeId: ADMIN_ID, environment: "QC", timeoutMs: 5_000 } });
      await app.send("cancel", { runId });

      const done = app.pushesOf("run-done").find((message) => message.runId === runId);
      expect(done?.cancelled).toBe(true);

      const seen = app.events().length;
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(app.events().length).toBe(seen);
      // Exactly one terminal signal per run, even though the engine kept working.
      expect(app.pushesOf("run-done").filter((message) => message.runId === runId).length).toBe(1);
    },
    TIMEOUT_MS,
  );

  it(
    "givenUnknownNode_whenRun_thenRunDoneCarriesTheError",
    async () => {
      const app = open();

      const { runId } = await app.send("run", { args: { nodeId: "postman/collections/admin/Nope.request.yaml" } });
      const done = await waitForRunDone(app, runId);

      expect(done.error).toBeDefined();
      expect(done.error?.exitCode).toBe(EXIT.CLI);
    },
    TIMEOUT_MS,
  );

  /**
   * The collection runner's four options and its summary, exercised through the wire the pane
   * actually uses. The folder is built with the engine's own mutations rather than added to the
   * fixture, because several suites assert these workspaces' exact request lists.
   */
  describe("running a folder", () => {
    async function buildSuite(app: Harness): Promise<void> {
      await app.send("mutate", { op: { op: "create-folder", parentId: ADMIN_ID, name: "suite" } });
      await app.send("mutate", { op: { op: "move", targetId: PROFILE_ID, parentId: SUITE_ID } });
    }

    /** A request written into the suite byte for byte, so a test can say what it wants exactly. */
    async function addRequest(app: Harness, name: string, yaml: string): Promise<string> {
      const created = await app.send("mutate", {
        op: { op: "create-request", parentId: SUITE_ID, name, kind: "http-request" },
      });
      const nodeId = created.nodeId ?? "";
      await app.send("write-text", { nodeId, text: yaml });
      return nodeId;
    }

    function nameOf(nodeId: string): string {
      return nodeId.slice(SUITE_ID.length + SEPARATOR_LENGTH, -REQUEST_SUFFIX.length);
    }

    it(
      "givenFolderRun_whenRunning_thenPerRequestStatusStreams",
      async () => {
        const app = open();
        await primeEnvironment(app);
        await buildSuite(app);
        await addRequest(app, "Echoed", ECHOED_YAML);

        const { runId } = await app.send("run", { args: { nodeId: SUITE_ID, environment: "QC", timeoutMs: 5_000 } });
        const done = await waitForRunDone(app, runId);
        expect(done.error).toBeUndefined();

        const events = app.events();
        const start = events.find((event) => event.type === "run-start");
        if (start?.type !== "run-start") throw new Error("no run-start");
        expect(start.total).toBe(2);

        // One request at a time, each announced before it is answered and closed before the next
        // one opens: that is the invariant the runner's live list is drawn from.
        const lifecycle = events
          .filter((event) => event.type === "request-start" || event.type === "request-end")
          .map((event) => `${event.type} ${nameOf(event.nodeId)}`);
        expect(lifecycle).toEqual([
          "request-start Profile",
          "request-end Profile",
          "request-start Echoed",
          "request-end Echoed",
        ]);

        // Every item reports its own outcome, which is what colours a row rather than the run.
        const ends = events.filter((event) => event.type === "request-end");
        expect(ends.every((event) => event.type === "request-end" && event.exitCode === EXIT.OK)).toBe(true);
      },
      TIMEOUT_MS,
    );

    it(
      "givenCsvIterationData_whenRunning_thenIterationCountMatchesRows",
      async () => {
        const app = open();
        await primeEnvironment(app);
        await buildSuite(app);

        // No `iterationCount`: the rows decide, which is why the runner's iterations box is
        // empty by default rather than showing 1. An explicit count would override the file.
        const { runId } = await app.send("run", {
          args: { nodeId: SUITE_ID, environment: "QC", iterationData: dataPath("users.csv"), timeoutMs: 5_000 },
        });
        await waitForRunDone(app, runId);

        const events = app.events();
        const start = events.find((event) => event.type === "run-start");
        if (start?.type !== "run-start") throw new Error("no run-start");
        expect(start.total).toBe(CSV_ROWS);

        const iterations = events
          .filter((event) => event.type === "request-start")
          .map((event) => (event.type === "request-start" ? event.iteration : NaN));
        expect(iterations).toEqual([0, 1]);
      },
      TIMEOUT_MS,
    );

    it(
      "givenMixedOutcomes_whenRunEnds_thenWorstOutcomeIsReported",
      async () => {
        const app = open();
        await primeEnvironment(app);
        await buildSuite(app);
        const failing = await addRequest(app, "Failing", FAILING_YAML);
        const unreachable = await addRequest(app, "Unreachable", UNREACHABLE_YAML);

        const { runId } = await app.send("run", { args: { nodeId: SUITE_ID, environment: "QC", timeoutMs: 5_000 } });
        await waitForRunDone(app, runId);

        const ends = app.events().filter((event) => event.type === "request-end");
        const byNode = new Map(
          ends.map((event) => [event.nodeId, event.type === "request-end" ? event.exitCode : null]),
        );
        expect(byNode.get(failing)).toBe(EXIT.TEST);
        expect(byNode.get(unreachable)).toBe(EXIT.TRANSPORT);

        const end = app.events().find((event) => event.type === "run-end");
        if (end?.type !== "run-end") throw new Error("no run-end");
        // Transport, not the numerically largest code: core ranks a call that never happened
        // above an assertion that failed on a call that did, and the runner reports core's answer.
        expect(end.exitCode).toBe(EXIT.TRANSPORT);
      },
      TIMEOUT_MS,
    );

    it(
      "givenScriptWroteEnvValue_whenRunEnds_thenEnvironmentFileIsUpdated",
      async () => {
        const app = open();
        await primeEnvironment(app);
        await buildSuite(app);
        await addRequest(app, "Marker", MARKER_YAML);

        const { runId } = await app.send("run", { args: { nodeId: SUITE_ID, environment: "QC", timeoutMs: 5_000 } });
        await waitForRunDone(app, runId);

        // On disk, because that is the promise `pm.environment.set` makes in this app: the CLI
        // saves, so the desktop app saves, and the next run of either sees the same value.
        expect(readFileSync(join(httpRoot(), QC_ENV_PATH), "utf8")).toContain(MARKER);

        // And the variable manager reads it back without being told where it came from.
        const view = await app.send("variables", { environment: "QC" });
        const binding = view.bindings.find((each) => each.key === MARKER_KEY);
        expect(binding?.value).toBe(MARKER);
        expect(binding?.scope).toBe("environment");
      },
      TIMEOUT_MS,
    );

    it(
      "givenFinishedRun_whenReportRequested_thenBothFormatsRenderFromTheSameOutcome",
      async () => {
        const app = open();
        await primeEnvironment(app);
        await buildSuite(app);

        const { runId } = await app.send("run", { args: { nodeId: SUITE_ID, environment: "QC", timeoutMs: 5_000 } });
        await waitForRunDone(app, runId);

        const json = await app.send("run-report", { runId, format: "json" });
        expect(json.suggestedName.endsWith(`-${runId}.json`)).toBe(true);
        const report = JSON.parse(json.text) as { group?: string; items?: unknown[]; exitCode?: number };
        expect(report.group).toBe("admin/suite");
        expect(report.items?.length).toBe(1);
        expect(report.exitCode).toBe(EXIT.OK);

        const junit = await app.send("run-report", { runId, format: "junit" });
        expect(junit.suggestedName.endsWith(`-${runId}.xml`)).toBe(true);
        expect(junit.text.startsWith("<testsuites")).toBe(true);
        expect(junit.text).toContain('<testsuite name="admin/suite/Profile"');
        expect(junit.text).toContain('name="bearer auth reached the server"');
      },
      TIMEOUT_MS,
    );

    it("givenRunNobodyHasHeardOf_whenReportRequested_thenRefusedWithAReason", async () => {
      const error = await open().fail("run-report", { runId: "run-999", format: "json" });

      expect(error.message).toContain("run-999");
      expect(error.exitCode).toBe(EXIT.CLI);
    });
  });
});

/**
 * The protocol declares a handful of constants rather than re-exporting them from core, so that
 * importing the protocol never pulls a line of the engine into the renderer bundle. That
 * duplication is only safe while something checks it, which is this.
 */
/**
 * The phase names are marked in three processes and joined in one reader, so the two properties
 * the join silently depends on are pinned here rather than left to a reviewer's eye.
 */
describe("the phase vocabulary", () => {
  it("givenThePhaseRecord_whenRead_thenEveryNameIsUniqueAndPrefixed", () => {
    const names = Object.values(PHASES);

    // Two keys with one name would put two boundaries in one bucket, and the timeline would look
    // complete while having lost a step.
    expect(new Set(names).size).toBe(names.length);

    // `readPhases` keeps the marks that start with the prefix. A name without it would be marked
    // by whichever process owns it and read by nobody.
    for (const name of names) expect(name.startsWith(PHASE_PREFIX), name).toBe(true);
  });
});

describe("the wire's copies of core's constants", () => {
  it("givenProtocolExitCodes_whenComparedToCore_thenEveryValueMatches", () => {
    expect(EXIT_CODES).toStrictEqual(EXIT);
  });

  it("givenProtocolOrderConstants_whenComparedToCore_thenBothMatch", () => {
    // The renderer plans reorders and moves against these two numbers. A protocol copy that
    // drifted from core would make it compute orders the files cannot actually hold.
    expect(ORDER_STEP).toBe(CORE_ORDER_STEP);
    expect(ORDER_ABSENT).toBe(CORE_ORDER_ABSENT);
  });

  it("givenProtocolFormatLimit_whenComparedToCore_thenTheRendererRefusesExactlyWhatTheEngineWould", () => {
    // The pretty-print toggle is disabled off the protocol's copy. If it drifted above core's,
    // the toggle would offer a format the engine then refuses.
    expect(BODY_FORMAT_LIMIT_BYTES).toBe(CORE_FORMAT_LIMIT_BYTES);
  });

  it("givenProtocolDefinitionSuffix_whenComparedToCore_thenGroupRowsStripTheRightTail", () => {
    // The git overlay turns a changed definition file into a decoration on its folder row by
    // stripping this tail. A drifted copy would leave every folder undecorated and silent.
    expect(GROUP_DEFINITION_SUFFIX).toBe(`/${RESOURCES_DIR}/${DEFINITION_FILE}`);
  });

  it("givenCoreTokenSource_whenComparedToTheWire_thenTheyMatch", () => {
    expect(VARIABLE_TOKEN_SOURCE).toBe(CORE_TOKEN_SOURCE);
  });

  it("givenTokenSources_whenRunOverOneCorpus_thenTheyFindTheSameNames", () => {
    // Two identical strings only prove a copy. The same corpus through both patterns proves the
    // copy means the same thing, which is what the renderer's hit-testing actually depends on.
    const names = (source: string, text: string) =>
      [...text.matchAll(new RegExp(source, "g"))].map((match) => match[1]);

    for (const text of TOKEN_CORPUS) {
      expect(names(VARIABLE_TOKEN_SOURCE, text)).toEqual(names(CORE_TOKEN_SOURCE, text));
    }
  });
});
