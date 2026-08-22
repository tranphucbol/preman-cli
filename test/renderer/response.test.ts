/**
 * The response pane's arithmetic, exercised without a browser.
 *
 * The claim these suites defend is the one the whole pane exists for: a 50MB response costs
 * the renderer what a 500KB one costs. That is a property of `model/body.ts` against a real
 * `BodyStore`, so it is provable here - a mounted CodeMirror would only tell us that jsdom
 * does no layout.
 *
 * The engine is the real one throughout. A hand-written `BodyWindow` would happily let a
 * splice test pass while the splice was misaligned by two bytes, which is exactly the bug
 * nobody would ever suspect.
 */
import { describe, expect, it } from "vitest";

import { BodyStore, FORMAT_LIMIT_BYTES } from "@preman/core/api/bodies.js";
import type { RunEvent } from "@preman/core/api/events.js";
import { BODY_WINDOW_BYTES, EXIT_CODES } from "@preman/desktop/engine/protocol.js";
import {
  VIEWER_RETAINED_BYTES,
  extendView,
  formatAvailability,
  isEmpty,
  isHighlightable,
  isWhole,
  languageFor,
  offsetForMatch,
  requestOffset,
  retainedBytes,
  seedView,
  viewEnd,
  viewText,
  viewerLanguage,
  type BodyView,
} from "@preman/desktop/renderer/model/body.js";
import {
  exitLabel,
  exitTone,
  isCleanExit,
  mergeConsole,
  parseSetCookie,
  statusTone,
  testTotals,
} from "@preman/desktop/renderer/model/response.js";
import { useRunsStore } from "@preman/desktop/renderer/stores/runs.js";

const MEGABYTE = 1024 * 1024;
const HUGE_BODY_BYTES = 50 * MEGABYTE;
/** Multi-byte on purpose: a window that split a codepoint would decode to replacement characters. */
const FILL = '{"id":1,"name":"café"},';
const JSON_TYPE = "application/json";
const TEXT_TYPE = "text/plain";
const START = 0;
/**
 * A window can come back up to three bytes short of what was asked for, because both ends are
 * aligned off UTF-8 continuation bytes. That bounds how many windows a body can take.
 */
const MAX_ALIGNMENT_SHORTFALL = 3;
const SMALL_BODY = '{"ok":true}';
const RUN_ID = "run-1";
const PING_ID = "postman/collections/payment/Ping.request.yaml";
const FIRST_ITERATION = 1;
const ASSERTION_COUNT = 30;
const ONE_REQUEST = 1;

/** A body of a given size, filled with repeating multi-byte JSON-ish text. */
function bodyOf(bytes: number, contentType: string) {
  const store = new BodyStore();
  const publication = store.publish(Buffer.alloc(bytes, FILL), contentType);
  return { store, publication };
}

/** A body of exactly these bytes, for the cases where the content itself is the point. */
function bodyFrom(text: string, contentType: string) {
  const store = new BodyStore();
  const publication = store.publish(Buffer.from(text, "utf8"), contentType);
  return { store, publication };
}

/** Walk the whole body the way the pane does: ask for `next`, fold it in, repeat. */
function walk(view: BodyView, store: BodyStore, handle: string) {
  let current = view;
  let windows = 0;
  let peakBytes = 0;
  let peakChars = 0;
  const limit = Math.ceil(current.byteLength / (BODY_WINDOW_BYTES - MAX_ALIGNMENT_SHORTFALL));

  for (;;) {
    const offset = requestOffset(current, "next");
    if (offset === null) break;
    current = extendView(current, store.window(handle, offset, BODY_WINDOW_BYTES));
    windows += 1;
    peakBytes = Math.max(peakBytes, retainedBytes(current));
    peakChars = Math.max(peakChars, viewText(current).length);
    if (windows > limit) throw new Error(`the walk did not terminate after ${String(windows)} windows`);
  }
  return { view: current, windows, peakBytes, peakChars, limit };
}

describe("the windowed body viewer", () => {
  it("givenFiftyMegabyteBody_whenViewed_thenRendererMemoryStaysFlat", () => {
    const { store, publication } = bodyOf(HUGE_BODY_BYTES, JSON_TYPE);
    expect(publication.truncated).toBe(true);

    // A truncated preview is thrown away: its byte length is unknowable in the renderer, and a
    // view that cannot state its own `nextOffset` cannot be appended to exactly.
    const seed = seedView(publication);
    expect(isEmpty(seed)).toBe(true);
    expect(isWhole(seed)).toBe(false);

    const walked = walk(seed, store, publication.handle);

    // The whole body was read, one window at a time...
    expect(viewEnd(walked.view)).toBe(HUGE_BODY_BYTES);
    expect(walked.windows).toBeGreaterThan(HUGE_BODY_BYTES / BODY_WINDOW_BYTES - ONE_REQUEST);
    expect(walked.windows).toBeLessThanOrEqual(walked.limit);

    // ...and at no point did the renderer hold more than its cap, in bytes or in characters.
    // This is the assertion the pane exists for: the peak is a constant, not a fraction of 50MB.
    expect(walked.peakBytes).toBeLessThanOrEqual(VIEWER_RETAINED_BYTES);
    expect(walked.peakChars).toBeLessThanOrEqual(VIEWER_RETAINED_BYTES);
    expect(retainedBytes(walked.view)).toBeLessThanOrEqual(VIEWER_RETAINED_BYTES);
  });

  it("givenUntruncatedPreview_whenSeeded_thenTheViewIsTheWholeBodyWithoutAskingTheEngine", () => {
    const { publication } = bodyFrom(SMALL_BODY, JSON_TYPE);

    const view = seedView(publication);

    expect(publication.truncated).toBe(false);
    expect(isWhole(view)).toBe(true);
    // Nothing left to fetch, in either direction, so the small case costs zero engine calls.
    expect(requestOffset(view, "next")).toBeNull();
    expect(requestOffset(view, "previous")).toBeNull();
  });

  it("givenWindowThatDoesNotContinueTheView_whenFolded_thenItReplacesRatherThanSplices", () => {
    const { store, publication } = bodyOf(HUGE_BODY_BYTES, JSON_TYPE);
    const handle = publication.handle;

    const first = extendView(seedView(publication), store.window(handle, START, BODY_WINDOW_BYTES));
    const appended = extendView(first, store.window(handle, viewEnd(first), BODY_WINDOW_BYTES));
    expect(appended.chunks).toHaveLength(2);

    // A jump - which is what a search hit or the range strip produces - lands nowhere near the
    // current span. Splicing it in would produce a document with a silent hole in the middle.
    const jumped = extendView(appended, store.window(handle, HUGE_BODY_BYTES / 2, BODY_WINDOW_BYTES));
    expect(jumped.chunks).toHaveLength(1);
    expect(jumped.chunks[0]?.offset).toBeGreaterThanOrEqual(HUGE_BODY_BYTES / 2);

    // And the chunks that do survive are always contiguous, which is what makes the joined
    // text the actual bytes of that byte range.
    for (let index = 1; index < appended.chunks.length; index += 1) {
      expect(appended.chunks[index]?.offset).toBe(appended.chunks[index - 1]?.nextOffset);
    }
  });

  it("givenOffsetPastTheEnd_whenFolded_thenTheEmptyWindowChangesNothing", () => {
    const { store, publication } = bodyFrom(SMALL_BODY, JSON_TYPE);
    const view = seedView(publication);

    const again = extendView(view, store.window(publication.handle, publication.byteLength, BODY_WINDOW_BYTES));

    // A reader parked at the bottom keeps firing scroll events. If an empty window appended a
    // chunk, every one of them would replace the document with nothing.
    expect(again).toBe(view);
  });

  it("givenSearchHit_whenJumpingToIt_thenTheWindowStartsBeforeTheMatch", () => {
    const { store, publication } = bodyOf(HUGE_BODY_BYTES, JSON_TYPE);
    const matches = store.search(publication.handle, "café", ONE_REQUEST);
    const match = matches[0];
    expect(match).toBeDefined();
    if (match === undefined) return;

    const offset = offsetForMatch(match);
    const window = store.window(publication.handle, offset, BODY_WINDOW_BYTES);

    expect(offset).toBeLessThanOrEqual(match.offset);
    expect(window.offset).toBeLessThanOrEqual(match.offset);
    expect(window.nextOffset).toBeGreaterThan(match.offset);
  });
});

describe("the pretty-print toggle", () => {
  it("givenBodyAboveFormatLimit_whenPrettyPrintRequested_thenToggleIsDisabledWithReason", () => {
    const { store, publication } = bodyOf(HUGE_BODY_BYTES, JSON_TYPE);
    const view = seedView(publication);

    const availability = formatAvailability(view, SMALL_BODY);

    expect(availability.allowed).toBe(false);
    expect(availability.reason).toContain("Too large");
    expect(availability.reason).toContain("MB");
    // The renderer refuses exactly what the engine would, which is the point of the disabled
    // control: a click that turns into an error banner teaches nothing.
    expect(() => store.format(publication.handle)).toThrow();
    expect(view.byteLength).toBeGreaterThan(FORMAT_LIMIT_BYTES);
    // And a body that large drops to plain text: a syntax tree over 50MB is what freezes a
    // renderer, not the bytes.
    expect(isHighlightable(view)).toBe(false);
    expect(viewerLanguage(view, SMALL_BODY)).toBe("text");
  });

  it("givenSmallJsonBody_whenAsked_thenTheToggleIsOfferedAndTheEngineAgrees", () => {
    const { store, publication } = bodyFrom(SMALL_BODY, JSON_TYPE);
    const view = seedView(publication);

    expect(formatAvailability(view, viewText(view)).allowed).toBe(true);
    expect(store.format(publication.handle)).toContain("\n");
  });

  it("givenNonJsonBody_whenAsked_thenTheToggleSaysWhyItIsNotOffered", () => {
    const { publication } = bodyFrom(SMALL_BODY, TEXT_TYPE);

    const availability = formatAvailability(seedView(publication), "plain words");

    // `BodyStore.format` hands anything but JSON back unchanged, so offering the toggle here
    // would be offering a button that does nothing.
    expect(availability.allowed).toBe(false);
    expect(availability.reason).toContain("JSON");
  });

  it("givenNoContentType_whenChoosingALanguage_thenTheBodyIsSniffed", () => {
    // An API that forgot its `Content-Type` is still the API you have to read.
    expect(languageFor(null, '  {"ok":true}')).toBe("json");
    expect(languageFor(null, "<html></html>")).toBe("xml");
    expect(languageFor(null, "just words")).toBe("text");
    expect(languageFor("application/vnd.acme+json; charset=utf-8", "")).toBe("json");
  });
});

describe("what the response pane reads off a run", () => {
  it("givenTestEventsForOneRequest_whenApplied_thenTheTestsListGrowsOnePerEvent", () => {
    const store = useRunsStore.getState();
    store.clear();
    store.apply({ type: "run-start", runId: RUN_ID, total: ONE_REQUEST });
    store.apply({ type: "request-start", runId: RUN_ID, nodeId: PING_ID, name: "Ping", iteration: FIRST_ITERATION });

    // The Tests tab fills in while a thirty-assertion script is still running, which is only
    // true if each event lands on its own rather than being batched at `request-end`.
    for (let index = 0; index < ASSERTION_COUNT; index += 1) {
      store.apply(assertion(index));
      expect(onlyRequest().tests).toHaveLength(index + 1);
    }

    const totals = testTotals(onlyRequest().tests);
    expect(totals.total).toBe(ASSERTION_COUNT);
    expect(totals.failed).toBe(1);
    expect(onlyRequest().status).toBe("running");
    store.clear();
  });

  it("givenConsoleAndSideRequests_whenMerged_thenArrivalOrderIsRecovered", () => {
    const store = useRunsStore.getState();
    store.clear();
    store.apply({ type: "run-start", runId: RUN_ID, total: ONE_REQUEST });
    store.apply({ type: "request-start", runId: RUN_ID, nodeId: PING_ID, name: "Ping", iteration: FIRST_ITERATION });

    store.apply(logged("before"));
    store.apply(sideRequest());
    store.apply(logged("after"));

    const state = useRunsStore.getState();
    const rows = mergeConsole(state.console, state.sideRequests);

    // A `pm.sendRequest` has to appear between the log before it and the log after it. Two
    // separate lists would put it at the end, where it explains nothing.
    expect(rows.map((row) => (row.kind === "line" ? row.line.text : row.summary.url))).toEqual([
      "before",
      "https://auth.example/token",
      "after",
    ]);
    expect(rows.map((row) => row.seq)).toEqual([...rows].sort((left, right) => left.seq - right.seq).map((r) => r.seq));
    store.clear();
  });

  it("givenSetCookieHeaders_whenParsed_thenAttributesAreSplitOut", () => {
    const cookies = parseSetCookie([
      ["Set-Cookie", "session=abc123; Path=/; HttpOnly; SameSite=Lax; Domain=example.com"],
      ["Content-Type", JSON_TYPE],
      ["set-cookie", "flag=1; Max-Age=600; Secure"],
      ["Set-Cookie", "malformed"],
    ]);

    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatchObject({
      name: "session",
      value: "abc123",
      path: "/",
      domain: "example.com",
      sameSite: "Lax",
      httpOnly: true,
      secure: false,
    });
    // `Max-Age` stands in for `Expires` when that is all the server sent.
    expect(cookies[1]).toMatchObject({ name: "flag", expires: "600", secure: true, httpOnly: false });
  });

  it("givenEitherProtocolsStatus_whenToned_thenSuccessAndFailureAreDistinguished", () => {
    // A gRPC status is a code name and an HTTP one is a number, and the pane needs no idea
    // which it is looking at.
    expect(statusTone("OK")).toBe("ok");
    expect(statusTone("DEADLINE_EXCEEDED")).toBe("danger");
    expect(statusTone(200)).toBe("ok");
    expect(statusTone(404)).toBe("warn");
    expect(statusTone(503)).toBe("danger");
  });

  it("givenCleanExit_whenSummarised_thenTheOutcomeIsLeftOutAndEveryFailureIsNamed", () => {
    // The summary already carries the status and the test count, so repeating "ok" a third
    // time is noise. Every other code is the only place its reason is written down.
    expect(isCleanExit(EXIT_CODES.OK)).toBe(true);
    for (const exitCode of [EXIT_CODES.CLI, EXIT_CODES.TRANSPORT, EXIT_CODES.BUSINESS, EXIT_CODES.TEST]) {
      expect(isCleanExit(exitCode)).toBe(false);
      expect(exitLabel(exitCode)).not.toBe(exitLabel(EXIT_CODES.OK));
    }
    expect(exitTone(EXIT_CODES.BUSINESS)).toBe("warn");
    expect(exitTone(EXIT_CODES.TRANSPORT)).toBe("danger");
  });
});

function onlyRequest() {
  const requests = [...useRunsStore.getState().requests.values()];
  const first = requests[0];
  if (requests.length !== ONE_REQUEST || first === undefined) {
    throw new Error(`expected one request in the store, found ${String(requests.length)}`);
  }
  return first;
}

/** The last assertion fails, so the totals have something to count. */
function assertion(index: number): RunEvent {
  return {
    type: "test",
    runId: RUN_ID,
    nodeId: PING_ID,
    result: {
      name: `assertion ${String(index)}`,
      status: index === ASSERTION_COUNT - 1 ? "failed" : "passed",
      error: index === ASSERTION_COUNT - 1 ? "expected 1 to equal 2" : undefined,
      origin: { level: "request", label: "request" },
    },
  };
}

function logged(text: string): RunEvent {
  return {
    type: "console",
    runId: RUN_ID,
    nodeId: PING_ID,
    line: { level: "log", text, origin: { level: "request", label: "request" } },
  };
}

function sideRequest(): RunEvent {
  return {
    type: "side-request",
    runId: RUN_ID,
    nodeId: PING_ID,
    summary: {
      method: "POST",
      url: "https://auth.example/token",
      statusCode: 200,
      statusMessage: "OK",
      message: "",
      ok: true,
      durationMs: 12,
    },
  };
}
