import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSelection, type RunSelectionArgs } from "@preman/core/api/run.js";
import { CANCELLED_MESSAGE, invokeHttp, NO_RESPONSE_STATUS } from "@preman/core/http/invoke.js";
import { emptyTlsCerts } from "@preman/core/tls/certs.js";
import { FIXTURE_HTTP_WS, HTTP_TOKEN } from "./helpers.js";

/**
 * Cancellation, against a server that never finishes answering.
 *
 * The whole point of decision 051 is a stop that does not depend on the response ending,
 * so every request here is one the old reporting-only Cancel could not have freed: the
 * headers arrive, the body never does, and nothing but an abort or the timeout closes it.
 */

/** Long enough that a test which hits it has failed, not merely been slow. */
const GENEROUS_TIMEOUT_MS = 30_000;
/** Short enough to prove the timeout still fires on its own, with no signal involved. */
const BRIEF_TIMEOUT_MS = 300;
/** Time to let the request reach the server before pulling the plug. */
const SETTLE_MS = 100;
/**
 * The abort has to beat the timeout by a margin no scheduler hiccup can close, so the
 * assertion is about which mechanism fired and not about how fast the machine is.
 */
const ABORT_CEILING_MS = 10_000;
const NO_REQUESTS = 0;
const ONE_REQUEST = 1;
const REDIRECT_AND_HOP = 2;
const ONE_HOP = 1;
const NO_ITEMS = 0;
const SCRIPT_TIMEOUT_MS = 5_000;
const OK = 200;
const FOUND = 302;

interface HangingServer {
  origin: string;
  /** One entry per request that reached the server, in arrival order. */
  paths: string[];
  /** Resolves once at least `count` requests have arrived. */
  awaitRequests: (count: number) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * A server with two routes, both of which hold the socket open forever:
 * `/hang` answers with headers and no body, and `/redirect` bounces to `/hang` first.
 * Held responses are closed on teardown so the suite does not hang with them.
 */
function startHangingServer(): Promise<HangingServer> {
  const paths: string[] = [];
  const held: ServerResponse[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];

  const server: Server = createServer((req, res) => {
    const path = req.url ?? "";
    paths.push(path);
    for (const waiter of [...waiters]) {
      if (paths.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }

    if (path.startsWith("/redirect")) {
      res.writeHead(FOUND, { location: "/hang" });
      res.end();
      return;
    }
    // Headers only. A reader gets a status and then waits forever, which is the shape
    // of a stalled event stream and the case the exchange timer used to be the only
    // answer to.
    res.writeHead(OK, { "content-type": "text/plain" });
    held.push(res);
  });

  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        fail(new Error("hanging test server did not bind a port"));
        return;
      }
      done({
        origin: `http://127.0.0.1:${address.port}`,
        paths,
        awaitRequests: (count) =>
          paths.length >= count ? Promise.resolve() : new Promise((resolve) => waiters.push({ count, resolve })),
        close: () =>
          new Promise((closed) => {
            for (const res of held) res.end();
            server.close(() => closed());
          }),
      });
    });
  });
}

let server: HangingServer;

beforeAll(async () => {
  server = await startHangingServer();
});

afterAll(async () => {
  await server.close();
});

function hangingInvoke(controller: AbortController, path = "/hang", timeoutMs = GENEROUS_TIMEOUT_MS) {
  return invokeHttp({
    url: new URL(`${server.origin}${path}`),
    method: "GET",
    headers: [],
    timeoutMs,
    tlsCerts: emptyTlsCerts(),
    signal: controller.signal,
  });
}

describe("an aborted http exchange", () => {
  it("givenSignalAbortedBeforeSending_whenInvoking_thenNoSocketIsOpened", async () => {
    const before = server.paths.length;
    const controller = new AbortController();
    controller.abort();

    const result = await hangingInvoke(controller);

    expect(result.statusCode).toBe(NO_RESPONSE_STATUS);
    expect(result.message).toBe(CANCELLED_MESSAGE);
    expect(server.paths.length - before).toBe(NO_REQUESTS);
  });

  it("givenResponseThatNeverEnds_whenAborted_thenResolvesWithoutWaitingForTheTimeout", async () => {
    const controller = new AbortController();
    const pending = hangingInvoke(controller);
    await server.awaitRequests(server.paths.length + ONE_REQUEST);

    setTimeout(() => controller.abort(), SETTLE_MS);
    const result = await pending;

    expect(result.statusCode).toBe(NO_RESPONSE_STATUS);
    expect(result.message).toBe(CANCELLED_MESSAGE);
    // The headers did arrive; without the abort this call would have sat here for the
    // full 30 seconds, which is what makes the timing assertion meaningful.
    expect(result.durationMs).toBeLessThan(ABORT_CEILING_MS);
  });

  it("givenNoSignal_whenTheResponseNeverEnds_thenTheTimeoutStillReportsItself", async () => {
    const result = await hangingInvoke(new AbortController(), "/hang", BRIEF_TIMEOUT_MS);

    // Distinguishable messages matter: both paths destroy the same socket, and a
    // cancel that reported itself as a timeout would send the reader hunting a
    // network problem that never existed.
    expect(result.statusCode).toBe(NO_RESPONSE_STATUS);
    expect(result.message).toContain("timed out");
    expect(result.message).not.toBe(CANCELLED_MESSAGE);
  });

  it("givenARedirectChain_whenAbortedOnTheSecondHop_thenTheChainIsReportedAndNotContinued", async () => {
    const controller = new AbortController();
    const pending = hangingInvoke(controller, "/redirect");
    // Two requests: the 302 itself, then the hop that never answers.
    await server.awaitRequests(server.paths.length + REDIRECT_AND_HOP);
    const reached = server.paths.length;

    setTimeout(() => controller.abort(), SETTLE_MS);
    const result = await pending;

    expect(result.message).toBe(CANCELLED_MESSAGE);
    // The hops already taken survive into the cancelled result, so the report still
    // says where the request got to.
    expect(result.redirects).toHaveLength(ONE_HOP);
    expect(result.finalUrl).toContain("/hang");
    expect(server.paths.length).toBe(reached);
  });
});

function selectionArgs(selector: string, signal: AbortSignal): RunSelectionArgs {
  return {
    dir: FIXTURE_HTTP_WS,
    selector,
    env: "QC",
    url: undefined,
    tls: undefined,
    tlsCerts: {},
    certBaseDir: FIXTURE_HTTP_WS,
    timeoutMs: GENEROUS_TIMEOUT_MS,
    runTimeoutMs: 0,
    scriptTimeoutMs: SCRIPT_TIMEOUT_MS,
    iterationCount: undefined,
    iterationData: undefined,
    delayRequestMs: 0,
    vars: { http_url: server.origin, token: HTTP_TOKEN },
    save: false,
    preferDescriptor: false,
    bail: false,
    workingDir: undefined,
    insecureFileRead: false,
    safeEval: false,
    signal,
  };
}

describe("a cancelled group run", () => {
  it("givenSignalAbortedBeforeTheRun_whenRunningAGroup_thenItStopsWithoutEnteringARequest", async () => {
    const before = server.paths.length;
    const controller = new AbortController();
    controller.abort();

    const result = await runSelection(selectionArgs("admin", controller.signal));

    expect(result.group?.bailed).toBe(true);
    expect(result.group?.bailReason).toBe("cancelled");
    // A run that stopped at the gate still reports having entered its first iteration;
    // what it must not have done is open a socket.
    expect(result.group?.items).toHaveLength(NO_ITEMS);
    expect(server.paths.length - before).toBe(NO_REQUESTS);
  });
});
