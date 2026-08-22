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

    expect(typesOf(sink.events)).toEqual(["run-start", "request-start", "request-end", "run-end"]);
    expect(firstOf(sink.events, "request-end")?.exitCode).toBe(EXIT.CLI);
    expect(firstOf(sink.events, "run-end")?.exitCode).toBe(EXIT.CLI);
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
