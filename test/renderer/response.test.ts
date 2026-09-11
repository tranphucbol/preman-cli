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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  CONSOLE_BODY_CHARS,
  CONSOLE_BODY_LINES,
  callStatus,
  clampBody,
  elapsedMs,
  exitLabel,
  exitTone,
  failureCopy,
  isCleanExit,
  mergeConsole,
  settledMs,
  showAllLabel,
  parseSetCookie,
  statusTone,
  testTotals,
  waitedMs,
  type ConsoleRow,
} from "@preman/desktop/renderer/model/response.js";
import { itemKeyFor, useRunsStore } from "@preman/desktop/renderer/stores/runs.js";

const MEGABYTE = 1024 * 1024;
const HUGE_BODY_BYTES = 50 * MEGABYTE;
/** Multi-byte on purpose: a window that split a codepoint would decode to replacement characters. */
const ITEM = '{"id":1,"name":"café"}';
const FILL = `${ITEM},`;
/**
 * Enough items to land between the engine's 256KB preview and its 2MB format limit: large
 * enough that the body arrives truncated, small enough that preman still pretty-prints it.
 * `bodyOf` cannot serve this case - a buffer packed with `FILL` is not parseable JSON.
 */
const TRUNCATED_JSON_ITEMS = 20_000;
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

/** A fixed epoch so a click can be asserted exactly rather than within a window. */
const CLICKED_AT = 1_700_000_000_000;
/** The reader's wait: the exchange plus the save, the trip to the engine and the scripts. */
const WAITED_MS = 420;
/** The engine's own measurement of the exchange alone, and therefore the smaller number. */
const EXCHANGE_MS = 55;
const NO_TIME = 0;

const RENDERER_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../packages/desktop/src/renderer");
const CLOCK_COMPONENT = "function Elapsed(";
const NEXT_COMPONENT = "\nfunction Headers(";
const TICKER = "setInterval(";
const ONE_TICKER = 1;

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

  it("givenTruncatedJsonBody_whenSeeded_thenItIsFormattedOnArrivalWithoutWaitingForBytes", () => {
    // The viewer formats on arrival off this same predicate, so it has to answer before a
    // window lands: a seeded view of a truncated body holds no text at all, and sniffing an
    // empty sample would say "text" and cost the reader a raw first paint for nothing. The
    // content type is what carries the answer that early.
    const json = `[${Array.from({ length: TRUNCATED_JSON_ITEMS }, () => ITEM).join(",")}]`;
    const { store, publication } = bodyFrom(json, JSON_TYPE);
    const view = seedView(publication);

    expect(publication.truncated).toBe(true);
    expect(publication.byteLength).toBeLessThan(FORMAT_LIMIT_BYTES);
    expect(isEmpty(view)).toBe(true);
    expect(viewText(view)).toBe("");
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

    const rows = merged();

    // A `pm.sendRequest` has to appear between the log before it and the log after it. Two
    // separate lists would put it at the end, where it explains nothing.
    expect(rows.map(labelOf)).toEqual(["before", "https://auth.example/token", "after"]);
    expect(rows.map((row) => row.seq)).toEqual([...rows].sort((left, right) => left.seq - right.seq).map((r) => r.seq));
    store.clear();
  });

  it("givenLogsAndCallsAndSideRequests_whenMerged_thenRowsAreInSeqOrder", () => {
    const store = useRunsStore.getState();
    store.clear();
    store.apply({ type: "run-start", runId: RUN_ID, total: ONE_REQUEST });
    store.apply({ type: "request-start", runId: RUN_ID, nodeId: PING_ID, name: "Ping", iteration: FIRST_ITERATION });

    store.apply(logged("pre-request"));
    store.apply(requestSent());
    store.apply(sideRequest());
    store.apply(logged("post-response"));

    // The call takes its place at `request-sent`, so the pre-request log sorts above it and
    // everything it caused sorts below it. That is the causal order, and the only reason a
    // five-request run reads as five things rather than one flat stream.
    expect(merged().map(labelOf)).toEqual([
      "pre-request",
      itemKeyFor(RUN_ID, PING_ID, FIRST_ITERATION),
      "https://auth.example/token",
      "post-response",
    ]);
    store.clear();
  });

  it("givenOnlyCalls_whenMerged_thenEveryCallIsARow", () => {
    const store = useRunsStore.getState();
    store.clear();
    store.apply({ type: "run-start", runId: RUN_ID, total: ONE_REQUEST });
    store.apply({ type: "request-start", runId: RUN_ID, nodeId: PING_ID, name: "Ping", iteration: FIRST_ITERATION });
    store.apply(requestSent());

    const rows = merged();

    expect(rows).toHaveLength(ONE_REQUEST);
    expect(rows[0]?.kind).toBe("call");
    store.clear();
  });

  it("givenTwoStreamsEmpty_whenMerged_thenTheThirdIsReturnedWhole", () => {
    const lines = [
      { runId: RUN_ID, nodeId: PING_ID, seq: 0, line: logLine("one") },
      { runId: RUN_ID, nodeId: PING_ID, seq: 1, line: logLine("two") },
    ];

    // The merge exhausts two of its three fingers immediately, which is the case a naive
    // three-way comparison drops rows in.
    expect(mergeConsole(lines, [], []).map(labelOf)).toEqual(["one", "two"]);
    expect(mergeConsole([], [], [])).toEqual([]);
  });

  it("givenShortBody_whenClamped_thenNothingIsTrimmed", () => {
    const clamped = clampBody(SMALL_BODY);

    expect(clamped.text).toBe(SMALL_BODY);
    expect(clamped.clamped).toBe(false);
    expect(clamped.totalLines).toBe(ONE_REQUEST);
    // An empty body renders no section at all, so it reports no lines rather than one.
    expect(clampBody("")).toMatchObject({ totalLines: 0, clamped: false });
  });

  it("givenManyLines_whenClamped_thenTheLineCapApplies", () => {
    const total = CONSOLE_BODY_LINES * 4;
    const clamped = clampBody(Array.from({ length: total }, (_, index) => `line ${String(index)}`).join("\n"));

    expect(clamped.shownLines).toBe(CONSOLE_BODY_LINES);
    expect(clamped.totalLines).toBe(total);
    expect(clamped.clamped).toBe(true);
  });

  it("givenOneLongLine_whenClamped_thenTheCharacterCapApplies", () => {
    // A minified JSON response is one line of a quarter of a megabyte, so a line cap alone
    // would let the whole thing into a 28px row.
    const clamped = clampBody("x".repeat(CONSOLE_BODY_CHARS * 4));

    expect(clamped.text).toHaveLength(CONSOLE_BODY_CHARS);
    expect(clamped.totalLines).toBe(ONE_REQUEST);
    expect(clamped.shownLines).toBe(ONE_REQUEST);
    expect(clamped.clamped).toBe(true);
  });

  /**
   * A seventeen-line gRPC message clamped to twelve used to offer `12 of 17 lines`, which is a
   * fact rather than an offer, and led to a pane that opens on the response.
   */
  it("givenAClampedBody_whenLabelled_thenTheControlNamesWhatItShows", () => {
    const total = CONSOLE_BODY_LINES + 5;
    const many = clampBody(Array.from({ length: total }, (_, index) => `line ${String(index)}`).join("\n"));
    expect(showAllLabel(many)).toBe(`Show all ${String(total)} lines`);

    // Nothing but characters were cut, so a line count would be a lie in both directions.
    expect(showAllLabel(clampBody("x".repeat(CONSOLE_BODY_CHARS * 4)))).toBe("Show the whole body");
  });

  it("givenNoResponse_whenCallStatus_thenNullIsReturned", () => {
    // `0` in the status column would read as a status rather than as the absence of one.
    expect(callStatus(null)).toBeNull();
    expect(callStatus({ status: 200, headers: [], timings: { durationMs: 1 } })).toBe("200");
    expect(callStatus({ status: "OK", headers: [], timings: { durationMs: 1 } })).toBe("OK");
  });

  it("givenResponseFailureEvent_whenApplied_thenTheItemHoldsIt", () => {
    const store = useRunsStore.getState();
    store.clear();
    store.apply({ type: "run-start", runId: RUN_ID, total: ONE_REQUEST });
    store.apply({ type: "request-start", runId: RUN_ID, nodeId: PING_ID, name: "Ping", iteration: FIRST_ITERATION });
    store.apply({
      type: "response-head",
      runId: RUN_ID,
      nodeId: PING_ID,
      status: "NOT_FOUND",
      headers: [],
      timings: { durationMs: 55 },
      streaming: false,
    });
    store.apply({
      type: "response-failure",
      runId: RUN_ID,
      nodeId: PING_ID,
      stage: "transport",
      message: "Not found app_id=100331.",
      details: [],
      trailers: [["x-handled-by", "test-server"]],
    });

    // The body stays null: the pane branches on `failure` first, so "no body" is never
    // the last word on a call that the server refused.
    expect(onlyRequest().body).toBeNull();
    expect(onlyRequest().failure).toEqual({
      stage: "transport",
      message: "Not found app_id=100331.",
      details: [],
      trailers: [["x-handled-by", "test-server"]],
    });
    store.clear();
  });

  it("givenBuildFailureEvent_whenApplied_thenTheItemHoldsTheStageAndDetails", () => {
    const store = useRunsStore.getState();
    store.clear();
    store.apply({ type: "run-start", runId: RUN_ID, total: ONE_REQUEST });
    store.apply({ type: "request-start", runId: RUN_ID, nodeId: PING_ID, name: "Ping", iteration: FIRST_ITERATION });
    // No `response-head`: nothing was sent, so there is no status to carry one.
    store.apply({
      type: "response-failure",
      runId: RUN_ID,
      nodeId: PING_ID,
      stage: "build",
      message: "no usable schema for acquiring_core.upay.v1.UserPayment.CreateOrder",
      details: ["schema.location resolved to /Users/Shared/postman-protos/acquiring-core/user_payment.proto"],
      trailers: [],
    });

    expect(onlyRequest().head).toBeNull();
    expect(onlyRequest().failure?.stage).toBe("build");
    expect(onlyRequest().failure?.details).toHaveLength(1);
    store.clear();
  });

  it("givenKnownGrpcStatus_whenFailureCopy_thenTitleAndHintAreReturned", () => {
    // The status name is for the reader who already knew; the copy is for the one who did not.
    expect(failureCopy("transport", "NOT_FOUND")).toEqual({
      title: "Could not find the entity",
      hint: "The server looked and found nothing. Check the identifiers in the message you sent.",
    });
  });

  it("givenUnknownStatusName_whenFailureCopy_thenTheGenericFailureIsReturned", () => {
    expect(failureCopy("transport", "SOMETHING_NEW").title).toBe("The call failed");
    // A numeric status never reaches here, and under-explaining beats throwing in a pane.
    expect(failureCopy("transport", 500).title).toBe("The call failed");
  });

  it("givenNoStatus_whenFailureCopy_thenTheNoResponseCopyIsReturned", () => {
    expect(failureCopy("transport", undefined).title).toBe("No response arrived");
  });

  it("givenBuildStage_whenFailureCopy_thenItDoesNotClaimAResponseWasAwaited", () => {
    // "No response arrived" would be a lie of omission: no request was placed to answer.
    expect(failureCopy("build", undefined).title).toBe("The request could not be built");
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

  it("givenTheSameFailureOverEitherTransport_whenToned_thenBothReadTheSame", () => {
    // `google/rpc/code.proto` maps NOT_FOUND to 404 and UNAVAILABLE to 503, so a reader
    // should not see a gRPC call painted worse than the identical HTTP one.
    expect(statusTone("NOT_FOUND")).toBe(statusTone(404));
    expect(statusTone("UNAUTHENTICATED")).toBe(statusTone(401));
    expect(statusTone("UNAVAILABLE")).toBe(statusTone(503));
    expect(statusTone("INTERNAL")).toBe(statusTone(500));
  });

  it("givenAStatusNameThisBuildDoesNotKnow_whenToned_thenItIsNotExcused", () => {
    // Falling back to warn would tell the reader the call is theirs to fix, which is a
    // claim we cannot make about a name we do not recognise.
    expect(statusTone("SOMETHING_NEW")).toBe("danger");
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

/**
 * The clock the header counts up while a request is in flight.
 *
 * Two clocks are in play and the suite is mostly about keeping them apart. `startedAt` is the
 * renderer's, running from the click; `head.timings.durationMs` is the engine's, covering the
 * exchange alone. The header shows the first while it waits and the second once it knows it.
 */
describe("the clock in the response header", () => {
  it("givenAClickBeforeTheRunExists_whenTheRequestStarts_thenTheClockRunsFromTheClick", () => {
    const store = useRunsStore.getState();
    store.clear();
    // The click is the whole point: between it and `request-start` sit a flush, a save, the trip
    // to the engine and every pre-request script, and the reader is waiting through all of them.
    store.markSend(PING_ID, CLICKED_AT);
    store.apply({ type: "run-start", runId: RUN_ID, total: ONE_REQUEST });
    store.apply({ type: "request-start", runId: RUN_ID, nodeId: PING_ID, name: "Ping", iteration: FIRST_ITERATION });

    expect(onlyRequest().startedAt).toBe(CLICKED_AT);
    expect(onlyRequest().finishedAt).toBeNull();
    // Spent, so a second run through the same node cannot claim it again.
    expect(useRunsStore.getState().pendingSends.has(PING_ID)).toBe(false);
    store.clear();
  });

  it("givenNoClickToAdopt_whenTheRequestStarts_thenTheClockStartsWhereTheEventDid", () => {
    const store = useRunsStore.getState();
    store.clear();
    const before = Date.now();
    store.apply({ type: "run-start", runId: RUN_ID, total: ONE_REQUEST });
    store.apply({ type: "request-start", runId: RUN_ID, nodeId: PING_ID, name: "Ping", iteration: FIRST_ITERATION });
    const after = Date.now();

    // A request reached from the collection runner or a rerun was never clicked. It still gets a
    // clock, it just starts later than the reader's own wait did.
    expect(onlyRequest().startedAt).toBeGreaterThanOrEqual(before);
    expect(onlyRequest().startedAt).toBeLessThanOrEqual(after);
    store.clear();
  });

  it("givenAStaleClick_whenACollectionRunStarts_thenItIsNotLentToTheRun", () => {
    const store = useRunsStore.getState();
    store.clear();
    store.markSend(PING_ID, CLICKED_AT);
    // A Send whose run never opened leaves its stamp behind. Without this the next collection
    // run to reach that node would report the wait as however long the app had been open.
    store.dropAllSends();
    store.apply({ type: "run-start", runId: RUN_ID, total: ONE_REQUEST });
    store.apply({ type: "request-start", runId: RUN_ID, nodeId: PING_ID, name: "Ping", iteration: FIRST_ITERATION });

    expect(onlyRequest().startedAt).toBeGreaterThan(CLICKED_AT);
    store.clear();
  });

  it("givenAFailedSend_whenTheClickIsDropped_thenNothingIsLeftToAdopt", () => {
    const store = useRunsStore.getState();
    store.clear();
    store.markSend(PING_ID, CLICKED_AT);
    store.dropSend(PING_ID);

    expect(useRunsStore.getState().pendingSends.has(PING_ID)).toBe(false);
    store.clear();
  });

  it("givenARequestThatEnded_whenTheWaitIsRead_thenItSpansTheClickToTheEnd", () => {
    const store = useRunsStore.getState();
    store.clear();
    const clickedAt = Date.now() - WAITED_MS;
    store.markSend(PING_ID, clickedAt);
    store.apply({ type: "run-start", runId: RUN_ID, total: ONE_REQUEST });
    store.apply({ type: "request-start", runId: RUN_ID, nodeId: PING_ID, name: "Ping", iteration: FIRST_ITERATION });
    store.apply({
      type: "response-head",
      runId: RUN_ID,
      nodeId: PING_ID,
      status: 200,
      headers: [],
      timings: { durationMs: EXCHANGE_MS },
      streaming: false,
    });
    store.apply({ type: "request-end", runId: RUN_ID, nodeId: PING_ID, exitCode: EXIT_CODES.OK });

    const item = onlyRequest();
    expect(item.status).toBe("done");
    // The wait covers the exchange and everything either side of it, so it can only be longer.
    const waited = waitedMs(item.startedAt, item.finishedAt);
    expect(waited).not.toBeNull();
    expect(waited).toBeGreaterThanOrEqual(WAITED_MS);
    expect(waited).toBeGreaterThan(EXCHANGE_MS);
    store.clear();
  });

  it("givenARunCancelledInFlight_whenFinished_thenEveryClockStops", () => {
    const store = useRunsStore.getState();
    store.clear();
    store.apply({ type: "run-start", runId: RUN_ID, total: ONE_REQUEST });
    store.apply({ type: "request-start", runId: RUN_ID, nodeId: PING_ID, name: "Ping", iteration: FIRST_ITERATION });
    expect(onlyRequest().finishedAt).toBeNull();

    store.finish(RUN_ID, { warnings: [], cancelled: true });

    // A request that never reported an end still stops counting, or a cancelled run leaves a
    // clock running in the header for as long as the tab stays open.
    expect(onlyRequest().finishedAt).not.toBeNull();
    expect(onlyRequest().status).toBe("done");
    store.clear();
  });

  it("givenATransportDuration_whenSettled_thenTheHeaderShowsItRatherThanTheWait", () => {
    const head = { status: 200, headers: [], timings: { durationMs: EXCHANGE_MS } };

    // The one number the Timeline, the console, the CLI and `--report` all print. The header
    // disagreeing with every one of them would be worse than the visible snap back.
    expect(settledMs(head, WAITED_MS)).toBe(EXCHANGE_MS);
    expect(settledMs(head, null)).toBe(EXCHANGE_MS);
  });

  it("givenNoHeadAtAll_whenSettled_thenTheWaitIsShownRatherThanNothing", () => {
    // Four seconds failing to resolve DNS produces no head. Showing nothing would say the
    // request was instant.
    expect(settledMs(null, WAITED_MS)).toBe(WAITED_MS);
    expect(settledMs(null, null)).toBeNull();
  });

  it("givenAClockThatWentBackwards_whenMeasured_thenNoReadingIsNegative", () => {
    // Both readings are the renderer's `Date.now()` and can straddle a clock adjustment.
    expect(waitedMs(CLICKED_AT, CLICKED_AT - WAITED_MS)).toBe(NO_TIME);
    expect(elapsedMs(CLICKED_AT, CLICKED_AT - WAITED_MS)).toBe(NO_TIME);
    expect(waitedMs(CLICKED_AT, null)).toBeNull();
    expect(elapsedMs(CLICKED_AT, CLICKED_AT + WAITED_MS)).toBe(WAITED_MS);
  });

  it("givenTheResponsePane_whenScanned_thenOnlyTheClockItselfTicks", () => {
    const pane = readFileSync(join(RENDERER_DIR, "panes/ResponsePane.tsx"), "utf8");
    const clock = pane.slice(pane.indexOf(CLOCK_COMPONENT));

    // The claim the component exists for. An interval anywhere above it re-renders the body
    // viewer ten times a second for as long as a request runs, which is the one thing this
    // pane must not do while it is waiting for a 50MB response.
    expect(pane.split(TICKER).length - 1).toBe(ONE_TICKER);
    expect(clock).toContain(TICKER);
    expect(clock.indexOf(TICKER)).toBeLessThan(clock.indexOf(NEXT_COMPONENT));
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

/** The three streams as the drawer reads them: whatever is in the store, merged. */
function merged(): ConsoleRow[] {
  const state = useRunsStore.getState();
  return mergeConsole(state.console, state.sideRequests, state.calls);
}

/** One string per row, whichever kind it is, so a merge assertion reads as an order. */
function labelOf(row: ConsoleRow): string {
  if (row.kind === "line") return row.line.text;
  if (row.kind === "side-request") return row.summary.url;
  return row.itemKey;
}

function logLine(text: string) {
  return { level: "log", text, origin: { level: "request", label: "request" } } as const;
}

function logged(text: string): RunEvent {
  return { type: "console", runId: RUN_ID, nodeId: PING_ID, line: logLine(text) };
}

function requestSent(): RunEvent {
  return {
    type: "request-sent",
    runId: RUN_ID,
    nodeId: PING_ID,
    target: "grpcs://localhost:443/test.echo.EchoService.Echo",
    sent: {
      protocol: "grpc",
      methodPath: "test.echo.EchoService.Echo",
      metadata: [["x-request-id", "abc"]],
      message: { text: "hi" },
    },
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
