/**
 * What the client does when the far end goes away.
 *
 * The defect this covers is a hang, not a wrong answer: before the `"close"` listener existed, a
 * request whose engine died had nothing left to settle it, so the window pulsed a skeleton until
 * the user quit. Everything here is therefore about a promise settling at all.
 *
 * No window and no Electron. `createEngineClient` takes an `EnginePort`, which is declared
 * structurally for exactly this reason, so the port below is an object with the five members the
 * type names and a way to fire either event by hand.
 */
import { describe, expect, it } from "vitest";

import { EXIT_CODES } from "@preman/desktop/engine/protocol.js";
import type { EnginePort } from "@preman/desktop/preload/bridge.js";
import {
  createEngineClient,
  EngineRequestError,
  PORT_CLOSED_DETAILS,
  PORT_CLOSED_MESSAGE,
} from "@preman/desktop/renderer/client.js";

const A_ROOT = "/tmp/preman-workspace";
const NO_POSTS = 0;
const ONE_POST = 1;
const ONE_REJECTION = 1;
const NO_CALLS = 0;

interface FakePort extends EnginePort {
  /** Everything `postMessage` was given, so a refused send is observable as an absence. */
  readonly posted: unknown[];
  /** The far end vanished. */
  die(): void;
  readonly started: boolean;
  readonly hungUp: boolean;
}

function fakePort(): FakePort {
  const posted: unknown[] = [];
  const closeListeners: (() => void)[] = [];
  let started = false;
  let hungUp = false;

  return {
    posted,
    postMessage(message) {
      posted.push(message);
    },
    // One implementation for both overloads, narrowed by what it is handed.
    addEventListener(type: "message" | "close", listener: unknown): void {
      if (type === "close") closeListeners.push(listener as () => void);
    },
    start() {
      started = true;
    },
    close() {
      hungUp = true;
    },
    die() {
      for (const listener of [...closeListeners]) listener();
    },
    get started() {
      return started;
    },
    get hungUp() {
      return hungUp;
    },
  };
}

describe("a request whose engine stopped", () => {
  it("givenAPendingRequest_whenThePortCloses_thenItRejects", async () => {
    const port = fakePort();
    const client = createEngineClient(A_ROOT, port);
    const inflight = client.send("catalog", {});

    port.die();

    await expect(inflight).rejects.toThrow(PORT_CLOSED_MESSAGE);
  });

  /**
   * `TRANSPORT`, and an `EngineRequestError`. `toEngineError` reads that class and nothing else,
   * so a bare `Error` here would reach the banner as exit code 1 with no advice attached.
   */
  it("givenAPendingRequest_whenThePortCloses_thenTheRejectionIsATransportError", async () => {
    const port = fakePort();
    const client = createEngineClient(A_ROOT, port);
    const inflight = client.send("catalog", {});

    port.die();

    const cause = await inflight.catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(EngineRequestError);
    expect((cause as EngineRequestError).exitCode).toBe(EXIT_CODES.TRANSPORT);
  });

  it("givenAPendingRequest_whenThePortCloses_thenTheDetailsSayHowToRecover", async () => {
    const port = fakePort();
    const client = createEngineClient(A_ROOT, port);
    const inflight = client.send("catalog", {});

    port.die();

    const cause = await inflight.catch((error: unknown) => error);
    expect((cause as EngineRequestError).details).toStrictEqual([...PORT_CLOSED_DETAILS]);
  });

  /** Every one of them, not just the first: a resume has a catalog and a git status in flight. */
  it("givenSeveralPendingRequests_whenThePortCloses_thenEveryOneRejects", async () => {
    const port = fakePort();
    const client = createEngineClient(A_ROOT, port);
    const inflight = [client.send("catalog", {}), client.send("git-status", {}), client.send("phases", {})];

    port.die();

    const outcomes = await Promise.allSettled(inflight);
    expect(outcomes.map((outcome) => outcome.status)).toStrictEqual(["rejected", "rejected", "rejected"]);
  });

  /** A message posted at a dead port is never answered, so posting one is only a slower hang. */
  it("givenAClosedPort_whenSendIsCalledAgain_thenItRejectsWithoutPosting", async () => {
    const port = fakePort();
    const client = createEngineClient(A_ROOT, port);
    port.die();

    await expect(client.send("catalog", {})).rejects.toThrow(PORT_CLOSED_MESSAGE);
    expect(port.posted).toHaveLength(NO_POSTS);
  });

  it("givenALivePort_whenSendIsCalled_thenTheRequestIsPostedAndTheEnvelopeCarriesAnId", () => {
    const port = fakePort();
    const client = createEngineClient(A_ROOT, port);
    void client.send("catalog", {}).catch(() => undefined);

    expect(port.posted).toHaveLength(ONE_POST);
    expect(port.posted[0]).toMatchObject({ id: expect.any(Number) as number, kind: "catalog" });
    expect(port.started).toBe(true);
  });

  /**
   * The workspace-switch path. `close()` already rejected the request, and the old port's `close`
   * event arrives afterwards; a second rejection loop over a map that still held it would be a
   * second settle attempt, and the `closed` guard is what stops one being written.
   */
  it("givenAClientClosedByANewPort_whenTheOldPortAlsoCloses_thenPendingIsRejectedOnce", async () => {
    const port = fakePort();
    const client = createEngineClient(A_ROOT, port);
    const rejections: unknown[] = [];
    void client.send("catalog", {}).catch((cause: unknown) => rejections.push(cause));

    client.close();
    port.die();
    await Promise.resolve();

    expect(rejections).toHaveLength(ONE_REJECTION);
    expect(port.hungUp).toBe(true);
  });
});

describe("being told the engine went away", () => {
  /** The reap case: nothing in flight, so nothing to reject, and this is the only signal. */
  it("givenNothingInFlight_whenThePortCloses_thenTheCloseListenerIsCalled", () => {
    const port = fakePort();
    const client = createEngineClient(A_ROOT, port);
    let told = NO_CALLS;
    client.onClose(() => {
      told += 1;
    });

    port.die();

    expect(told).toBe(ONE_REJECTION);
  });

  /** A crash is one event however many times the port reports it. */
  it("givenAClosedPort_whenItClosesAgain_thenTheListenerIsNotCalledTwice", () => {
    const port = fakePort();
    const client = createEngineClient(A_ROOT, port);
    let told = NO_CALLS;
    client.onClose(() => {
      told += 1;
    });

    port.die();
    port.die();

    expect(told).toBe(ONE_REJECTION);
  });

  it("givenAnOnCloseListener_whenTheUnsubscribeRuns_thenTheListenerIsNotCalled", () => {
    const port = fakePort();
    const client = createEngineClient(A_ROOT, port);
    let told = NO_CALLS;
    const stop = client.onClose(() => {
      told += 1;
    });

    stop();
    port.die();

    expect(told).toBe(NO_CALLS);
  });

  /**
   * `close()` is this window hanging up on its own client, which is what a workspace switch does.
   * Reporting that as "the engine stopped" would put a banner on every switch.
   */
  it("givenAClientTheWindowClosesItself_whenCloseIsCalled_thenNoCloseListenerRuns", () => {
    const port = fakePort();
    const client = createEngineClient(A_ROOT, port);
    let told = NO_CALLS;
    client.onClose(() => {
      told += 1;
    });

    client.close();

    expect(told).toBe(NO_CALLS);
  });
});
