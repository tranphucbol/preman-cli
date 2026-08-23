import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BodyStore } from "@preman/core/api/bodies.js";
import type { RunEvent, RunEventSink } from "@preman/core/api/events.js";
import { runSelection, type RunSelectionArgs, type RunSelectionResult } from "@preman/core/api/run.js";
import { EXIT } from "@preman/core/errors.js";
import { FIXTURE_HTTP_WS, FIXTURE_WS, HTTP_TOKEN, startHttpServer, type HttpTestServer } from "./helpers.js";

const TIMEOUT_MS = 10_000;
const SCRIPT_TIMEOUT_MS = 5_000;
const RUN_ID = "run-under-test";
/** The events that describe a request's lifecycle, as opposed to what it produced. */
const LIFECYCLE_TYPES = new Set<string>([
  "run-start",
  "request-start",
  "request-sent",
  "response-head",
  "response-body",
  "request-end",
  "run-end",
]);

/** Collects everything a GUI would see, in arrival order. */
function collectingSink(): RunEventSink & { events: RunEvent[] } {
  const events: RunEvent[] = [];
  return {
    runId: RUN_ID,
    events,
    emit(event) {
      events.push(event);
    },
  };
}

let http: HttpTestServer;

beforeAll(async () => {
  http = await startHttpServer();
});

afterAll(async () => {
  await http.close();
});

afterEach(() => {
  http.received.length = 0;
});

/**
 * The fixture's `http_url` is empty on purpose: the port only exists at runtime, so
 * it is injected as a variable rather than as `--url`, which would also rewrite the
 * origin of requests that resolve their own.
 */
function selectionArgs(selector: string, extra: Partial<RunSelectionArgs> = {}): RunSelectionArgs {
  return {
    dir: FIXTURE_HTTP_WS,
    selector,
    env: "QC",
    url: undefined,
    tls: undefined,
    tlsCerts: {},
    certBaseDir: FIXTURE_HTTP_WS,
    timeoutMs: TIMEOUT_MS,
    runTimeoutMs: 0,
    scriptTimeoutMs: SCRIPT_TIMEOUT_MS,
    iterationCount: undefined,
    iterationData: undefined,
    delayRequestMs: 0,
    vars: { http_url: http.origin, token: HTTP_TOKEN },
    save: false,
    preferDescriptor: false,
    bail: false,
    workingDir: undefined,
    insecureFileRead: false,
    safeEval: false,
    ...extra,
  };
}

async function runWithSink(
  selector: string,
  extra: Partial<RunSelectionArgs> = {},
): Promise<{ events: RunEvent[]; result: RunSelectionResult; bodies: BodyStore }> {
  const sink = collectingSink();
  const bodies = new BodyStore();
  const result = await runSelection(selectionArgs(selector, { ...extra, sink, bodies }));
  return { events: sink.events, result, bodies };
}

function typesOf(events: RunEvent[]): string[] {
  return events.map((event) => event.type);
}

/** The lifecycle spine, with the console and test chatter a script emits filtered out. */
function lifecycleOf(events: RunEvent[]): string[] {
  return typesOf(events).filter((type) => LIFECYCLE_TYPES.has(type));
}

function firstOf<T extends RunEvent["type"]>(events: RunEvent[], type: T): Extract<RunEvent, { type: T }> | undefined {
  return events.find((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

describe("run events, single request", () => {
  it("givenSink_whenRequestRuns_thenEventsArriveInLifecycleOrder", async () => {
    const { events } = await runWithSink("admin/Profile");

    expect(lifecycleOf(events)).toEqual([
      "run-start",
      "request-start",
      "request-sent",
      "response-head",
      "response-body",
      "request-end",
      "run-end",
    ]);
  });

  it("givenSink_whenRequestRuns_thenEveryEventCarriesTheRunId", async () => {
    const { events } = await runWithSink("admin/Profile");

    expect(events.every((event) => event.runId === RUN_ID)).toBe(true);
  });

  it("givenSink_whenRequestRuns_thenNodeIdIsThePosixPathFromTheWorkspaceRoot", async () => {
    const { events } = await runWithSink("admin/Profile");

    expect(firstOf(events, "request-start")?.nodeId).toBe("postman/collections/admin/Profile.request.yaml");
  });

  it("givenSink_whenRequestSent_thenTargetAndSentBodyDescribeTheWire", async () => {
    const { events } = await runWithSink("admin/Login");
    const sent = firstOf(events, "request-sent");

    expect(sent?.target).toBe(`POST ${http.origin}/login`);
    expect(sent?.sent).toMatchObject({ method: "POST", url: `${http.origin}/login` });
  });

  it("givenSink_whenResponseArrives_thenHeadCarriesStatusHeadersAndDuration", async () => {
    const { events } = await runWithSink("admin/Profile");
    const head = firstOf(events, "response-head");

    expect(head?.status).toBe(200);
    expect(head?.headers.some(([key]) => key === "content-type")).toBe(true);
    expect(head?.timings.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("givenSink_whenResponseArrives_thenBodyEventNamesAHandleTheStoreHolds", async () => {
    const { events, bodies } = await runWithSink("admin/Profile");
    const body = firstOf(events, "response-body");

    expect(body).toBeDefined();
    expect(body?.truncated).toBe(false);
    expect(body?.contentType).toContain("application/json");
    expect(bodies.head(body!.handle).byteLength).toBe(body?.byteLength);
    // The preview is the whole small body, so the store agrees with the event.
    expect(bodies.window(body!.handle, 0, body!.byteLength).text).toBe(body?.preview);
  });

  it("givenFailedRequest_whenRunning_thenRequestEndCarriesTheTransportExitCode", async () => {
    const { events } = await runWithSink("admin/Denied");

    expect(firstOf(events, "request-end")?.exitCode).toBe(EXIT.BUSINESS);
    expect(firstOf(events, "run-end")?.exitCode).toBe(EXIT.BUSINESS);
  });

  /**
   * `Legacy Http` is a websocket request the engine refuses to send, so it throws out
   * of `parseRequest` — before a target, a socket or a response exists.
   */
  it("givenRequestThatCannotBeSent_whenRunning_thenTheRowIsStillOpenedAndClosed", async () => {
    const sink = collectingSink();
    const args = selectionArgs("payment/Legacy Http", { dir: FIXTURE_WS, env: "LOCAL", sink });

    await expect(runSelection(args)).rejects.toThrow(/does not support/);

    // The failure sits between the two, so the row is never closed with an exit code
    // and no reason.
    expect(typesOf(sink.events)).toEqual(["run-start", "request-start", "response-failure", "request-end", "run-end"]);
    expect(firstOf(sink.events, "request-end")?.exitCode).toBe(EXIT.CLI);
    expect(firstOf(sink.events, "run-end")?.exitCode).toBe(EXIT.CLI);
  });
});

/**
 * `sent` is a discriminated union rather than `unknown`, because the two protocols share nothing
 * but the fact that something left the process. These cases pin the discriminator and the fields
 * a consumer would otherwise have to duck-type its way to.
 */
describe("run events, what left the process", () => {
  /** No server is listening on the fixture's LOCAL target, so the call fails after it is sent. */
  const DEAD_GRPC = { dir: FIXTURE_WS, env: "LOCAL", timeoutMs: 1_000 } as const;

  it("givenHttpRequest_whenRun_thenRequestSentCarriesTheHttpProtocolTag", async () => {
    const { events } = await runWithSink("admin/Login");

    expect(firstOf(events, "request-sent")?.sent.protocol).toBe("http");
  });

  it("givenHttpRequest_whenRun_thenRequestSentCarriesTheHeadersActuallySent", async () => {
    const { events } = await runWithSink("admin/Login");
    const sent = firstOf(events, "request-sent")?.sent;

    // `content-type` is nowhere in the request file: the body type put it there. So these are
    // the finalised headers rather than the declared ones.
    expect(sent?.protocol === "http" && sent.headers.some(([key]) => key.toLowerCase() === "content-type")).toBe(true);
  });

  it("givenGrpcRequest_whenRun_thenRequestSentCarriesTheGrpcProtocolTag", async () => {
    const sink = collectingSink();
    await runSelection(selectionArgs("payment/Echo", { ...DEAD_GRPC, sink }));
    const sent = firstOf(sink.events, "request-sent")?.sent;

    expect(sent?.protocol).toBe("grpc");
    expect(sent?.protocol === "grpc" && sent.methodPath).toBe("test.echo.EchoService.Echo");
  });

  it("givenGrpcRequestWithMetadata_whenRun_thenRequestSentCarriesTheMetadata", async () => {
    const sink = collectingSink();
    await runSelection(selectionArgs("payment/Echo", { ...DEAD_GRPC, sink }));
    const sent = firstOf(sink.events, "request-sent")?.sent;
    const metadata = sent?.protocol === "grpc" ? Object.fromEntries(sent.metadata) : {};

    // One declared on the request, one added by its `beforeInvoke` script.
    expect(metadata["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(metadata["x-scripted"]).toBe("beforeInvoke");
  });

  it("givenGrpcRequestWithDisabledMetadata_whenRun_thenTheDisabledEntryIsAbsent", async () => {
    const sink = collectingSink();
    await runSelection(selectionArgs("payment/Ping", { ...DEAD_GRPC, sink }));
    const sent = firstOf(sink.events, "request-sent")?.sent;
    const keys = sent?.protocol === "grpc" ? sent.metadata.map(([key]) => key) : [];

    expect(keys).not.toContain("x-disabled");
  });

  it("givenRequestSent_whenStructuredCloned_thenTheSentPayloadSurvives", async () => {
    const sink = collectingSink();
    await runSelection(selectionArgs("payment/Echo", { ...DEAD_GRPC, sink }));
    const sent = firstOf(sink.events, "request-sent");

    // The desktop hands events across a MessagePort, so every member has to be cloneable.
    expect(structuredClone(sent)).toEqual(sent);
  });
});

describe("run events, failures", () => {
  /** No server is listening on the fixture's LOCAL target, so every gRPC call is UNAVAILABLE. */
  const DEAD_GRPC = { dir: FIXTURE_WS, env: "LOCAL", timeoutMs: 1_000 } as const;

  it("givenGrpcCallRejected_whenRun_thenResponseFailureCarriesServerMessage", async () => {
    const sink = collectingSink();
    await runSelection(selectionArgs("payment/Echo", { ...DEAD_GRPC, sink }));

    const failure = firstOf(sink.events, "response-failure");
    expect(failure).toBeDefined();
    expect(failure?.message).not.toBe("");
    // The status stays on the head, which is what the pane pairs the message with.
    expect(firstOf(sink.events, "response-head")?.status).toBe("UNAVAILABLE");
  });

  it("givenGrpcCallRejected_whenRun_thenNoResponseBodyIsEmitted", async () => {
    const sink = collectingSink();
    const bodies = new BodyStore();
    await runSelection(selectionArgs("payment/Echo", { ...DEAD_GRPC, sink, bodies }));

    expect(typesOf(sink.events)).toContain("response-failure");
    expect(typesOf(sink.events)).not.toContain("response-body");
  });

  it("givenNoResponseArrives_whenRun_thenResponseFailureCarriesTheSocketMessage", async () => {
    const sink = collectingSink();
    // Port 1 is reserved and nothing binds it, so the connection is refused outright.
    await runSelection(selectionArgs("admin/Profile", { sink, vars: { http_url: "http://127.0.0.1:1", token: "x" } }));

    const failure = firstOf(sink.events, "response-failure");
    expect(failure?.message).not.toBe("");
    expect(failure?.trailers).toEqual([]);
    // Nothing arrived, so there is no status to pair the message with.
    expect(typesOf(sink.events)).not.toContain("response-head");
  });

  /**
   * A 4xx has a body, and that body is the server's own account of the error. Replacing
   * it with a headline would be this app talking over the server.
   */
  it("givenHttpClientError_whenRun_thenNoResponseFailureIsEmittedAndTheBodyStands", async () => {
    const sink = collectingSink();
    const bodies = new BodyStore();
    await runSelection(selectionArgs("admin/Denied", { sink, bodies }));

    expect(typesOf(sink.events)).not.toContain("response-failure");
    expect(firstOf(sink.events, "response-head")?.status).toBe(401);
    expect(firstOf(sink.events, "response-body")?.byteLength).toBeGreaterThan(0);
  });

  /**
   * The CLI prints a thrown `PremanError` on its way out. A window has no such exit
   * path, so without this event it shows an exit code and no reason - the same dead
   * end the transport case had.
   */
  it("givenRequestCannotBeBuilt_whenRun_thenResponseFailureCarriesThePremanError", async () => {
    const sink = collectingSink();
    // `Legacy Http` is a websocket request, refused out of `parseRequest` before a
    // target, a socket or a response exists.
    const args = selectionArgs("payment/Legacy Http", { dir: FIXTURE_WS, env: "LOCAL", sink });
    await expect(runSelection(args)).rejects.toThrow(/does not support/);

    const failure = firstOf(sink.events, "response-failure");
    expect(failure?.stage).toBe("build");
    expect(failure?.message).toMatch(/does not support/);
    // Nothing was sent, so there is neither a status nor trailers to pair it with.
    expect(typesOf(sink.events)).not.toContain("response-head");
    expect(failure?.trailers).toEqual([]);
  });
});

describe("run events, scripts", () => {
  it("givenScriptWithManyTests_whenRunning_thenTestsAppearIncrementally", async () => {
    const { events, result } = await runWithSink("admin/Profile");
    const tests = events.filter((event) => event.type === "test");

    expect(tests.length).toBeGreaterThan(0);
    expect(tests.length).toBe(result.outcome?.tests.length);
    // Every streamed result must be the same object the batch outcome reports.
    expect(tests.map((event) => event.result)).toEqual(result.outcome?.tests);
  });

  it("givenScriptThatLogs_whenRunning_thenConsoleEventsMatchTheBatchLines", async () => {
    const { events, result } = await runWithSink("admin/Login");
    const lines = events.filter((event) => event.type === "console").map((event) => event.line);

    expect(lines).toEqual(result.outcome?.consoleLines);
  });

  it("givenScriptCallingSendRequest_whenRunning_thenSideRequestEventsMatchTheBatchRecords", async () => {
    const { events, result } = await runWithSink("admin/Side Login");
    const summaries = events.filter((event) => event.type === "side-request").map((event) => event.summary);

    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries).toEqual(result.outcome?.sideRequests);
  });

  it("givenTestEvents_whenRunning_thenTheyPrecedeRequestEnd", async () => {
    const { events } = await runWithSink("admin/Profile");
    const lastTest = typesOf(events).lastIndexOf("test");

    expect(lastTest).toBeGreaterThan(-1);
    expect(lastTest).toBeLessThan(typesOf(events).indexOf("request-end"));
  });
});

describe("run events, group run", () => {
  it("givenSink_whenGroupRun_thenEventsArriveBeforeRunEnd", async () => {
    const { events } = await runWithSink("admin");
    const types = typesOf(events);

    expect(types.at(0)).toBe("run-start");
    expect(types.at(-1)).toBe("run-end");
    expect(types.filter((type) => type === "run-start")).toHaveLength(1);
    expect(types.filter((type) => type === "run-end")).toHaveLength(1);
  });

  it("givenFolderRun_whenRunning_thenPerRequestStatusStreams", async () => {
    const { events, result } = await runWithSink("admin");
    const starts = events.filter((event) => event.type === "request-start");
    const ends = events.filter((event) => event.type === "request-end");

    expect(firstOf(events, "run-start")?.total).toBe(result.group?.items.length);
    expect(starts).toHaveLength(result.group?.items.length ?? 0);
    expect(ends).toHaveLength(starts.length);
    // Every request opens before it closes, and no two rows interleave.
    for (const [index, start] of starts.entries()) {
      expect(ends[index]?.nodeId).toBe(start.nodeId);
      expect(events.indexOf(start)).toBeLessThan(events.indexOf(ends[index]!));
    }
  });

  /**
   * A skipped request never reaches `runRequest`, so its row has to be opened and
   * closed by the group loop or the live list would silently be short one entry that
   * the batch report does contain. No server here: every gRPC call fails to connect,
   * which is a per-item transport failure rather than a throw.
   */
  it("givenUnsupportedKindInGroup_whenRunning_thenItStillGetsAStartAndAnEnd", async () => {
    const sink = collectingSink();
    const result = await runSelection(
      selectionArgs("payment", { dir: FIXTURE_WS, env: "LOCAL", sink, timeoutMs: 1_000 }),
    );

    const skipped = result.group?.items.filter((item) => item.status === "skipped") ?? [];
    expect(skipped).toHaveLength(1);

    const starts = sink.events.filter((event) => event.type === "request-start");
    expect(starts).toHaveLength(result.group?.items.length ?? 0);
    expect(starts.map((event) => event.name)).toContain("Legacy Http");
  });

  it("givenGroupRun_whenRunning_thenEveryStartCarriesItsIteration", async () => {
    const { events } = await runWithSink("admin");

    expect(events.filter((event) => event.type === "request-start").every((event) => event.iteration === 0)).toBe(true);
  });
});

describe("the CLI path stays untouched", () => {
  it("givenCliRun_whenNoSinkPassed_thenOutcomeIsByteIdenticalToBefore", async () => {
    const plain = await runSelection(selectionArgs("admin/Profile"));
    const { result: observed } = await runWithSink("admin/Profile");

    // Durations and timings differ between runs, so compare the deterministic parts.
    expect(plain.exitCode).toBe(observed.exitCode);
    expect(plain.warnings).toEqual(observed.warnings);
    expect(plain.outcome?.tests).toEqual(observed.outcome?.tests);
    expect(plain.outcome?.consoleLines).toEqual(observed.outcome?.consoleLines);
    expect(plain.outcome?.protocol).toBe("http");
    expect(plain.outcome?.protocol === "http" && plain.outcome.invoke.body).toBe(
      observed.outcome?.protocol === "http" && observed.outcome.invoke.body,
    );
  });

  it("givenNoBodyStore_whenRunning_thenNoResponseBodyEventIsEmitted", async () => {
    const sink = collectingSink();
    await runSelection(selectionArgs("admin/Profile", { sink }));

    expect(typesOf(sink.events)).not.toContain("response-body");
    expect(typesOf(sink.events)).toContain("response-head");
  });
});
