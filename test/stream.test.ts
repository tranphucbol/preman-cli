import { writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BodyStore } from "@preman/core/api/bodies.js";
import type { RunEvent, RunEventSink } from "@preman/core/api/events.js";
import { runSelection, type RunSelectionResult } from "@preman/core/api/run.js";
import { EXIT } from "@preman/core/errors.js";
import { invokeHttp, NO_RESPONSE_STATUS, type HttpStreamOpen, type HttpStreamSink } from "@preman/core/http/invoke.js";
import type { SseFrame } from "@preman/core/http/sse.js";
import { emptyTlsCerts } from "@preman/core/tls/certs.js";
import { cloneFixtureHttpWorkspace } from "./helpers.js";

/**
 * Reading a response that has not finished arriving.
 *
 * Every server here holds the socket open on purpose, because a stream that has already
 * ended proves nothing: the buffered path would pass all of these. What is under test is
 * that frames reach the caller before the body does, and that the exchange timeout stops
 * applying to a response nobody promised would end.
 */

const GENEROUS_TIMEOUT_MS = 30_000;
/** Short enough that a stream outliving it is unambiguous. */
const BRIEF_TIMEOUT_MS = 250;
/** Comfortably past {@link BRIEF_TIMEOUT_MS}, so the old deadline would certainly have fired. */
const PAST_THE_DEADLINE_MS = 600;
const POLL_MS = 10;
const POLL_LIMIT_MS = 5_000;
const NO_FRAMES = 0;
const ONE_FRAME = 1;
const TWO_FRAMES = 2;
const ONE_OPEN = 1;
const ONE_READER = 1;
const NO_READERS = 0;
const FIRST = 0;
const SECOND = 1;
const NO_BYTES = 0;
const OK = 200;
const FOUND = 302;
const UTF8: BufferEncoding = "utf8";

interface StreamServer {
  origin: string;
  /** Write one already-formed block to every open stream. */
  emit: (block: string) => void;
  /** Close every open stream the way a well-behaved server ends one. */
  finish: () => void;
  /**
   * How many readers have ever attached.
   *
   * Counted rather than measured off the pool because a test that cancels leaves its
   * reader to be reaped whenever the operating system gets round to it, and the next test
   * asking "is anyone reading yet" would otherwise be answered by the corpse.
   */
  opened: () => number;
  awaitOpened: (count: number) => Promise<void>;
  paths: string[];
  kill: () => void;
  close: () => Promise<void>;
}

/**
 * A server whose `/stream` route answers with an event-stream head and then says nothing
 * until the test tells it to. `/redirect` bounces there first, and `/gzip` answers with a
 * complete but compressed stream, which is the one event-stream preman must not read live.
 */
function startStreamServer(): Promise<StreamServer> {
  const held: ServerResponse[] = [];
  const paths: string[] = [];
  let opened = NO_READERS;

  const server: Server = createServer((req, res) => {
    const path = req.url ?? "";
    paths.push(path);
    if (path.startsWith("/redirect")) {
      res.writeHead(FOUND, { location: "/stream" });
      res.end();
      return;
    }
    if (path.startsWith("/gzip")) {
      const body = gzipSync(Buffer.from("data: compressed\n\n", UTF8));
      res.writeHead(OK, {
        "content-type": "text/event-stream",
        "content-encoding": "gzip",
        "content-length": String(body.length),
      });
      res.end(body);
      return;
    }
    res.writeHead(OK, { "content-type": "text/event-stream; charset=utf-8" });
    // Node buffers a small first write until something forces it out.
    res.flushHeaders();
    held.push(res);
    opened += ONE_READER;
    res.on("close", () => {
      const index = held.indexOf(res);
      if (index >= FIRST) held.splice(index, ONE_READER);
    });
  });

  return new Promise<StreamServer>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${String(port)}`,
        paths,
        emit: (block) => {
          for (const res of held) res.write(block);
        },
        finish: () => {
          for (const res of held.splice(FIRST)) res.end();
        },
        // A peer that goes away mid-body rather than finishing, which is the one
        // ending the reader did not ask for and did not cause.
        kill: () => {
          for (const res of held.splice(FIRST)) res.destroy();
        },
        opened: () => opened,
        awaitOpened: (count) => until(() => opened >= count),
        close: () =>
          new Promise<void>((done) => {
            for (const res of held.splice(FIRST)) res.end();
            server.close(() => done());
          }),
      });
    });
  });
}

async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + POLL_LIMIT_MS;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("the condition never became true");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Recorder extends HttpStreamSink {
  opens: HttpStreamOpen[];
  frames: (frames: readonly SseFrame[], byteLength: number) => void;
  seen: SseFrame[];
  bytes: number;
}

function recorder(): Recorder {
  const record: Recorder = {
    opens: [],
    seen: [],
    bytes: NO_BYTES,
    open: (open) => {
      record.opens.push(open);
    },
    frames: (frames, byteLength) => {
      record.seen.push(...frames);
      record.bytes = byteLength;
    },
  };
  return record;
}

let stream: StreamServer;

beforeAll(async () => {
  stream = await startStreamServer();
});

afterAll(async () => {
  await stream.close();
});

describe("invoking a text/event-stream with a sink", () => {
  it("givenFramesArriveBeforeTheBody_whenStreaming_thenTheSinkSeesThemFirst", async () => {
    const sink = recorder();
    const before = stream.opened();
    const pending = invokeHttp({
      url: new URL(`${stream.origin}/stream`),
      method: "GET",
      headers: [],
      timeoutMs: GENEROUS_TIMEOUT_MS,
      tlsCerts: emptyTlsCerts(),
      stream: sink,
    });

    await stream.awaitOpened(before + ONE_READER);
    stream.emit("data: first\n\n");
    await until(() => sink.seen.length >= ONE_FRAME);

    // The assertion that matters: a frame is in hand while the promise is still pending.
    expect(sink.opens).toHaveLength(ONE_OPEN);
    expect(sink.opens[FIRST]?.statusCode).toBe(OK);
    expect(sink.seen[FIRST]?.data).toBe("first");

    stream.emit("data: second\n\n");
    await until(() => sink.seen.length >= TWO_FRAMES);
    stream.finish();

    const result = await pending;
    expect(sink.seen[SECOND]?.data).toBe("second");
    expect(result.statusCode).toBe(OK);
    // The raw stream is still the body, so the engine can store it and scripts can read it.
    expect(result.body).toBe("data: first\n\ndata: second\n\n");
    expect(sink.bytes).toBe(Buffer.byteLength(result.body, UTF8));
    expect(result.warnings).toEqual([]);
  });

  it("givenTheExchangeBudgetPasses_whenStreaming_thenTheStreamIsNotKilled", async () => {
    const sink = recorder();
    const before = stream.opened();
    const pending = invokeHttp({
      url: new URL(`${stream.origin}/stream`),
      method: "GET",
      headers: [],
      timeoutMs: BRIEF_TIMEOUT_MS,
      tlsCerts: emptyTlsCerts(),
      stream: sink,
    });

    await stream.awaitOpened(before + ONE_READER);
    await sleep(PAST_THE_DEADLINE_MS);
    stream.emit("data: late\n\n");
    await until(() => sink.seen.length >= ONE_FRAME);
    stream.finish();

    const result = await pending;
    expect(result.statusCode).toBe(OK);
    expect(sink.seen[FIRST]?.data).toBe("late");
  });

  it("givenCancelMidStream_whenAborted_thenWhatArrivedIsKeptAndTheCutIsWarned", async () => {
    const controller = new AbortController();
    const sink = recorder();
    const before = stream.opened();
    const pending = invokeHttp({
      url: new URL(`${stream.origin}/stream`),
      method: "GET",
      headers: [],
      timeoutMs: GENEROUS_TIMEOUT_MS,
      tlsCerts: emptyTlsCerts(),
      signal: controller.signal,
      stream: sink,
    });

    await stream.awaitOpened(before + ONE_READER);
    stream.emit("data: kept\n\n");
    await until(() => sink.seen.length >= ONE_FRAME);
    controller.abort();

    const result = await pending;
    // A stopped stream is not a failed request: the status stands and the frames stand.
    expect(result.statusCode).toBe(OK);
    expect(result.body).toBe("data: kept\n\n");
    expect(result.warnings.some((warning) => warning.startsWith("the stream ended early"))).toBe(true);
    expect(sink.seen).toHaveLength(ONE_FRAME);
  });

  it("givenTheServerHangsUpMidStream_whenStreaming_thenTheReasonNamesTheServer", async () => {
    const sink = recorder();
    const before = stream.opened();
    const pending = invokeHttp({
      url: new URL(`${stream.origin}/stream`),
      method: "GET",
      headers: [],
      timeoutMs: GENEROUS_TIMEOUT_MS,
      tlsCerts: emptyTlsCerts(),
      stream: sink,
    });

    await stream.awaitOpened(before + ONE_READER);
    stream.emit("data: kept\n\n");
    await until(() => sink.seen.length >= ONE_FRAME);
    stream.kill();

    const result = await pending;
    // Node's word for this is the bare "aborted", which is also what a reader who pressed
    // Cancel would expect to read - so unchanged it blames them for the server hanging up.
    expect(result.cutShort).toBe("the server closed the connection");
    expect(result.warnings).toContain("the stream ended early: the server closed the connection");
    expect(result.statusCode).toBe(OK);
    expect(sink.seen).toHaveLength(ONE_FRAME);
  });

  it("givenRedirectToAStream_whenStreaming_thenOnlyTheFinalHopOpens", async () => {
    const sink = recorder();
    const before = stream.opened();
    const pending = invokeHttp({
      url: new URL(`${stream.origin}/redirect`),
      method: "GET",
      headers: [],
      timeoutMs: GENEROUS_TIMEOUT_MS,
      tlsCerts: emptyTlsCerts(),
      stream: sink,
    });

    await stream.awaitOpened(before + ONE_READER);
    stream.emit("data: hop\n\n");
    await until(() => sink.seen.length >= ONE_FRAME);
    stream.finish();

    const result = await pending;
    expect(sink.opens).toHaveLength(ONE_OPEN);
    expect(result.redirects).toHaveLength(ONE_FRAME);
    expect(result.finalUrl).toContain("/stream");
  });

  it("givenCompressedEventStream_whenStreaming_thenItIsReadTheOldWay", async () => {
    const sink = recorder();
    const result = await invokeHttp({
      url: new URL(`${stream.origin}/gzip`),
      method: "GET",
      headers: [],
      timeoutMs: GENEROUS_TIMEOUT_MS,
      tlsCerts: emptyTlsCerts(),
      stream: sink,
    });

    expect(sink.opens).toHaveLength(NO_FRAMES);
    expect(sink.seen).toHaveLength(NO_FRAMES);
    expect(result.body).toBe("data: compressed\n\n");
  });
});

describe("invoking a text/event-stream without a sink", () => {
  it("givenNoSink_whenTheStreamNeverEnds_thenTheTimeoutStillStopsIt", async () => {
    const result = await invokeHttp({
      url: new URL(`${stream.origin}/stream`),
      method: "GET",
      headers: [],
      timeoutMs: BRIEF_TIMEOUT_MS,
      tlsCerts: emptyTlsCerts(),
    });

    // This is the CLI's contract: --timeout is a ceiling, whatever the content type is.
    expect(result.statusCode).toBe(NO_RESPONSE_STATUS);
    expect(result.message).toContain("timed out");
  });
});

/**
 * The event contract, over the real runner.
 *
 * The transport suites above prove frames arrive early. This one proves the shape a window
 * is promised: that the head goes out before the stream ends and says so, that the duration
 * arrives late rather than never, and that `response-body` still happens - the raw stream is
 * a response like any other once it has finished being one.
 */
describe("running a request that streams", () => {
  const STREAM_REQUEST = "Stream";
  const RUN_ID = "run-under-test";
  const RUN_TIMEOUT_MS = 0;
  const SCRIPT_TIMEOUT_MS = 5_000;
  const NO_DELAY_MS = 0;

  /**
   * The streaming request is written into the clone rather than committed to the fixture,
   * because the suites that read that workspace assert on what is in it.
   */
  function workspaceStreaming(root: string): void {
    writeFileSync(
      join(root, "postman/collections/admin", `${STREAM_REQUEST}.request.yaml`),
      [
        "$kind: http-request",
        `name: ${STREAM_REQUEST}`,
        'url: "{{stream_url}}/stream"',
        "method: GET",
        "order: 90",
      ].join("\n"),
    );
  }

  async function runStreaming(emit: () => void): Promise<{ events: RunEvent[]; result: RunSelectionResult }> {
    const clone = cloneFixtureHttpWorkspace();
    workspaceStreaming(clone.root);
    const events: RunEvent[] = [];
    const sink: RunEventSink = {
      runId: RUN_ID,
      emit: (event) => {
        events.push(event);
        // Feeding the server from the sink is what makes this a stream test and not a
        // replay: nothing is written until the run has actually opened the socket.
        if (event.type === "response-head") emit();
      },
    };

    try {
      const result = await runSelection({
        dir: clone.root,
        selector: STREAM_REQUEST,
        env: "QC",
        url: undefined,
        tls: undefined,
        tlsCerts: {},
        certBaseDir: clone.root,
        timeoutMs: GENEROUS_TIMEOUT_MS,
        runTimeoutMs: RUN_TIMEOUT_MS,
        scriptTimeoutMs: SCRIPT_TIMEOUT_MS,
        iterationCount: undefined,
        iterationData: undefined,
        delayRequestMs: NO_DELAY_MS,
        vars: { stream_url: stream.origin },
        save: false,
        preferDescriptor: false,
        bail: false,
        workingDir: undefined,
        insecureFileRead: false,
        safeEval: false,
        sink,
        bodies: new BodyStore(),
      });
      return { events, result };
    } finally {
      clone.cleanup();
    }
  }

  it("givenAStream_whenItRuns_thenTheHeadArrivesFirstAndTheDurationArrivesLast", async () => {
    const { events, result } = await runStreaming(() => {
      stream.emit("data: one\n\n");
      stream.emit("event: done\ndata: [DONE]\n\n");
      stream.finish();
    });

    const types = events.map((event) => event.type);
    expect(types.indexOf("response-head")).toBeLessThan(types.indexOf("response-frames"));
    expect(types.indexOf("response-frames")).toBeLessThan(types.indexOf("stream-end"));
    // The body still happens. Reports, scripts and the CLI see the response they always saw.
    expect(types.indexOf("stream-end")).toBeLessThan(types.indexOf("response-body"));

    const head = events.find((event) => event.type === "response-head");
    expect(head?.streaming).toBe(true);
    expect(head?.timings).toHaveProperty("headersMs");
    // No duration on the head: the exchange had not finished, and a number would be a lie.
    expect(head?.timings).not.toHaveProperty("durationMs");

    const end = events.find((event) => event.type === "stream-end");
    expect(end?.total).toBe(TWO_FRAMES);
    expect(end?.durationMs).toBeGreaterThan(NO_BYTES);
    expect(end?.cutShort).toBeUndefined();

    const dispatched = events
      .filter((event) => event.type === "response-frames")
      .flatMap((event) => event.frames.map((one) => one.data));
    expect(dispatched).toEqual(["one", "[DONE]"]);
    // A stream that the server closed is an ordinary success, warnings and all.
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.warnings).toHaveLength(NO_FRAMES);
  });

  it("givenAStream_whenItRuns_thenTheBodyIsStillTheWholeRawStream", async () => {
    const { events } = await runStreaming(() => {
      stream.emit("data: one\n\n");
      stream.finish();
    });

    const body = events.find((event) => event.type === "response-body");
    expect(body?.preview).toBe("data: one\n\n");
    expect(body?.contentType).toContain("text/event-stream");
  });
});
