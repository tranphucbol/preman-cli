import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";

import { EXIT } from "@preman/core/errors.js";
import { createEngineHost, type EngineHost } from "@preman/desktop/engine/host.js";
import type {
  EngineMessage,
  EnginePayload,
  EngineRequest,
  EngineRequestKind,
  EngineResults,
  EnginePush,
  NodeDocument,
  RunEvent,
} from "@preman/desktop/engine/protocol.js";
import { EXIT_CODES, isEnginePush } from "@preman/desktop/engine/protocol.js";

import {
  cloneFixtureHttpWorkspace,
  cloneFixtureWorkspace,
  HTTP_TOKEN,
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
const FIRST_REQUEST_ID = 1;

/**
 * A host plus the messages it pushed, which is the whole of what a renderer sees. Requests carry
 * their own ids here for the same reason the real client mints them: a response is only useful
 * if it can be matched to a call.
 */
interface Harness {
  host: EngineHost;
  pushes: EngineMessage[];
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
  let nextId = FIRST_REQUEST_ID;
  const host = createEngineHost({
    root,
    post: (message) => {
      pushes.push(message);
    },
  });

  async function respond<K extends EngineRequestKind>(kind: K, payload: EnginePayload<K>) {
    const request = { id: nextId++, kind, ...payload } as unknown as EngineRequest;
    return host.handle(request);
  }

  return {
    host,
    pushes,
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
});

/**
 * `EXIT_CODES` is declared in the protocol rather than re-exported from core, so that importing
 * the protocol never pulls a line of the engine into the renderer bundle. That duplication is only
 * safe while something checks it, which is this.
 */
describe("the wire's copy of the exit codes", () => {
  it("givenProtocolExitCodes_whenComparedToCore_thenEveryValueMatches", () => {
    expect(EXIT_CODES).toStrictEqual(EXIT);
  });
});
