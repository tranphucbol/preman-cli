/**
 * What the window makes of a stream, exercised without a browser.
 *
 * Two claims are defended here. The first is that the store stays bounded: a stream that runs
 * for an hour costs what a short one costs, and the count it reports is still the true one,
 * because the number the pane prints comes off `stream-end` and not off the list length.
 *
 * The second is the ordering claim, which is the whole of `engine/frames.ts`: batching is
 * allowed to change when a frame arrives and never which frames arrive, or in what order, and
 * a `stream-end` must never overtake the frames it closes. That is provable with a fake clock
 * and it is not provable by looking at a running app, where the two are 32ms apart.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { RunEvent } from "@preman/core/api/events.js";
import { FRAME_BATCH_MAX, FRAME_FLUSH_MS, createFrameBatcher } from "@preman/desktop/engine/frames.js";
import { EXIT_CODES } from "@preman/desktop/engine/protocol.js";
import {
  frameCountLabel,
  frameDetailLines,
  framePretty,
  frameSummary,
  frameTally,
  frameTime,
  hiddenFrames,
  streamContentType,
} from "@preman/desktop/renderer/model/stream.js";
import {
  EDITOR_CONTENT_PADDING_PX,
  EDITOR_LINE_HEIGHT,
  THEME_SPEC,
  editorBoxHeight,
} from "@preman/desktop/renderer/ui/editorTheme.js";
import { STREAM_MAX_FRAMES, itemKeyFor, useRunsStore } from "@preman/desktop/renderer/stores/runs.js";

type ResponseFrames = Extract<RunEvent, { type: "response-frames" }>;

const RUN_ID = "run-1";
const NODE_ID = "postman/collections/payment/Ping.request.yaml";
const FIRST_ITERATION = 1;
const HEADERS_MS = 42;
const DURATION_MS = 3850;
const NOTHING_DROPPED = 0;
const NO_FRAMES = 0;
const ONE_FRAME = 1;
const SOME_BYTES = 64;

/** A wall clock with a known reading, so `frameTime` is asserted against a value and not itself. */
const AT = Date.UTC(2024, 0, 1, 10, 2, 47, 149);

function frame(seq: number, data: string, event = "", id = ""): ResponseFrames["frames"][number] {
  return { seq, at: AT, event, data, id };
}

function frames(list: ResponseFrames["frames"], byteLength = SOME_BYTES, dropped = NOTHING_DROPPED): ResponseFrames {
  return { type: "response-frames", runId: RUN_ID, nodeId: NODE_ID, frames: list, dropped, byteLength };
}

/** Drives the real store to the point a stream has opened, which is a head and nothing else. */
function openStream(): void {
  const store = useRunsStore.getState();
  store.clear();
  store.apply({ type: "run-start", runId: RUN_ID, total: 1 });
  store.apply({ type: "request-start", runId: RUN_ID, nodeId: NODE_ID, name: "Ping", iteration: FIRST_ITERATION });
  store.apply({
    type: "response-head",
    runId: RUN_ID,
    nodeId: NODE_ID,
    status: 200,
    headers: [["content-type", "text/event-stream"]],
    timings: { headersMs: HEADERS_MS },
    streaming: true,
  });
}

function currentStream() {
  const item = useRunsStore.getState().requests.get(itemKeyFor(RUN_ID, NODE_ID, FIRST_ITERATION));
  if (item === undefined) throw new Error("the request is not in the store");
  return item;
}

describe("what the window keeps of a stream", () => {
  it("givenFrames_whenApplied_thenTheyLandNewestLastWithATotal", () => {
    openStream();
    useRunsStore.getState().apply(frames([frame(1, "one"), frame(2, "two")]));

    const { stream } = currentStream();
    expect(stream?.frames.map((each) => each.data)).toEqual(["one", "two"]);
    expect(stream?.total).toBe(2);
    expect(stream?.byteLength).toBe(SOME_BYTES);
    expect(stream?.open).toBe(true);
    useRunsStore.getState().clear();
  });

  it("givenAHeadAlone_whenNoFrameHasArrived_thenTheStreamIsKnownAndEmpty", () => {
    openStream();

    // The wait for a first token is the thing the pane exists to narrate, so the stream has
    // to exist before there is anything in it. Otherwise the reader sees the ordinary
    // "still sending" hint for a response that has in fact already connected.
    const { stream } = currentStream();
    expect(stream).not.toBeNull();
    expect(stream?.frames).toHaveLength(NO_FRAMES);
    expect(stream?.open).toBe(true);
    useRunsStore.getState().clear();
  });

  it("givenAHeadThatDoesNotStream_whenTheTypeSaysOtherwise_thenNoStreamIsOpened", () => {
    const store = useRunsStore.getState();
    store.clear();
    store.apply({ type: "run-start", runId: RUN_ID, total: 1 });
    store.apply({ type: "request-start", runId: RUN_ID, nodeId: NODE_ID, name: "Ping", iteration: FIRST_ITERATION });
    // Core declines to read a compressed event-stream live. The window follows what core did,
    // not what the content type claims, or it would show a frame list that never fills.
    store.apply({
      type: "response-head",
      runId: RUN_ID,
      nodeId: NODE_ID,
      status: 200,
      headers: [
        ["content-type", "text/event-stream"],
        ["content-encoding", "gzip"],
      ],
      timings: { durationMs: DURATION_MS },
      streaming: false,
    });

    expect(currentStream().stream).toBeNull();
    useRunsStore.getState().clear();
  });

  it("givenMoreFramesThanTheWindow_whenApplied_thenTheOldestAreDroppedAndTheTotalIsNot", () => {
    openStream();
    const overflow = STREAM_MAX_FRAMES + 250;
    const many = Array.from({ length: overflow }, (_, index) => frame(index + 1, `frame ${String(index + 1)}`));
    useRunsStore.getState().apply(frames(many));

    const { stream } = currentStream();
    expect(stream?.frames).toHaveLength(STREAM_MAX_FRAMES);
    expect(stream?.total).toBe(overflow);
    // The end of the stream is what a reader is watching, so that is the end that is kept.
    expect(stream?.frames.at(-1)?.data).toBe(`frame ${String(overflow)}`);
    useRunsStore.getState().clear();
  });

  it("givenTheEngineDroppedFrames_whenApplied_thenTheTotalCountsThemAnyway", () => {
    openStream();
    useRunsStore.getState().apply(frames([frame(9, "ninth")], SOME_BYTES, 8));

    const { stream } = currentStream();
    expect(stream?.frames).toHaveLength(ONE_FRAME);
    expect(stream?.total).toBe(9);
    useRunsStore.getState().clear();
  });

  it("givenAStreamEnd_whenApplied_thenTheHeadGainsItsDurationAndKeepsItsHeadersMs", () => {
    openStream();
    useRunsStore.getState().apply(frames([frame(1, "one")]));
    useRunsStore.getState().apply({
      type: "stream-end",
      runId: RUN_ID,
      nodeId: NODE_ID,
      total: 400,
      durationMs: DURATION_MS,
      // No cutShort: the ordinary close.
    });

    const item = currentStream();
    expect(item.stream?.open).toBe(false);
    expect(item.stream?.total).toBe(400);
    expect(item.stream?.cutShort).toBeNull();
    // The head went out before the exchange had a duration. Both numbers now sit on it.
    expect(item.head?.timings).toEqual({ headersMs: HEADERS_MS, durationMs: DURATION_MS });
    useRunsStore.getState().clear();
  });

  it("givenAStreamCutShort_whenItEnds_thenTheReasonIsKept", () => {
    openStream();
    useRunsStore.getState().apply({
      type: "stream-end",
      runId: RUN_ID,
      nodeId: NODE_ID,
      total: NO_FRAMES,
      durationMs: DURATION_MS,
      cutShort: "the request was cancelled",
    });

    expect(currentStream().stream?.cutShort).toBe("the request was cancelled");
    useRunsStore.getState().clear();
  });

  it("givenACancelledRun_whenItFinishes_thenAnOpenStreamIsClosedAnyway", () => {
    openStream();
    useRunsStore.getState().apply(frames([frame(1, "one")]));
    // Cancelling is exactly what stops `stream-end` being delivered, so `finish` has to close it.
    useRunsStore.getState().finish(RUN_ID, { warnings: [], cancelled: true });

    const item = currentStream();
    expect(item.stream?.open).toBe(false);
    expect(item.status).toBe("done");
    useRunsStore.getState().clear();
  });

  it("givenANonStreamedResponse_whenItCompletes_thenThereIsNoStream", () => {
    const store = useRunsStore.getState();
    store.clear();
    store.apply({ type: "run-start", runId: RUN_ID, total: 1 });
    store.apply({ type: "request-start", runId: RUN_ID, nodeId: NODE_ID, name: "Ping", iteration: FIRST_ITERATION });
    store.apply({
      type: "response-head",
      runId: RUN_ID,
      nodeId: NODE_ID,
      status: 200,
      headers: [["content-type", "application/json"]],
      timings: { durationMs: DURATION_MS },
      streaming: false,
    });
    store.apply({ type: "request-end", runId: RUN_ID, nodeId: NODE_ID, exitCode: EXIT_CODES.OK });

    expect(currentStream().stream).toBeNull();
    useRunsStore.getState().clear();
  });
});

describe("batching frames on their way to the window", () => {
  it("givenFramesWithinOneTick_whenTheTimerFires_thenTheyCrossAsOneEvent", () => {
    vi.useFakeTimers();
    const sent: ResponseFrames[] = [];
    const batcher = createFrameBatcher((event) => sent.push(event));

    batcher.add(frames([frame(1, "one")]));
    batcher.add(frames([frame(2, "two")]));
    expect(sent).toHaveLength(NO_FRAMES);

    vi.advanceTimersByTime(FRAME_FLUSH_MS);
    expect(sent).toHaveLength(ONE_FRAME);
    expect(sent[0]?.frames.map((each) => each.data)).toEqual(["one", "two"]);
    vi.useRealTimers();
  });

  it("givenABatchOverTheCeiling_whenItFlushes_thenTheOldestAreDroppedAndCounted", () => {
    vi.useFakeTimers();
    const sent: ResponseFrames[] = [];
    const batcher = createFrameBatcher((event) => sent.push(event));

    const excess = 20;
    const many = Array.from({ length: FRAME_BATCH_MAX + excess }, (_, index) => frame(index + 1, `f${String(index)}`));
    for (const one of many) batcher.add(frames([one]));
    vi.advanceTimersByTime(FRAME_FLUSH_MS);

    expect(sent[0]?.frames).toHaveLength(FRAME_BATCH_MAX);
    expect(sent[0]?.dropped).toBe(excess);
    // Dropping is from the front, so the newest frame is always the one that survives.
    expect(sent[0]?.frames.at(-1)?.seq).toBe(FRAME_BATCH_MAX + excess);
    vi.useRealTimers();
  });

  it("givenAPendingBatch_whenFlushedByHand_thenItGoesImmediately", () => {
    vi.useFakeTimers();
    const sent: ResponseFrames[] = [];
    const batcher = createFrameBatcher((event) => sent.push(event));

    batcher.add(frames([frame(1, "one")]));
    batcher.flush();

    // This is the guarantee the host relies on: no other run event can overtake these frames.
    expect(sent).toHaveLength(ONE_FRAME);
    vi.advanceTimersByTime(FRAME_FLUSH_MS);
    expect(sent).toHaveLength(ONE_FRAME);
    vi.useRealTimers();
  });

  it("givenNoFrames_whenFlushed_thenNothingIsEmitted", () => {
    vi.useFakeTimers();
    const sent: ResponseFrames[] = [];
    createFrameBatcher((event) => sent.push(event)).flush();

    expect(sent).toHaveLength(NO_FRAMES);
    vi.useRealTimers();
  });

  it("givenAPendingBatch_whenDiscarded_thenItNeverArrives", () => {
    vi.useFakeTimers();
    const sent: ResponseFrames[] = [];
    const batcher = createFrameBatcher((event) => sent.push(event));

    batcher.add(frames([frame(1, "one")]));
    batcher.discard();
    vi.advanceTimersByTime(FRAME_FLUSH_MS);

    // Cancelling has to take the timer with it, or one last batch lands after `run-done`.
    expect(sent).toHaveLength(NO_FRAMES);
    vi.useRealTimers();
  });

  it("givenFramesFromASecondRequest_whenAdded_thenTheFirstBatchGoesFirst", () => {
    vi.useFakeTimers();
    const sent: ResponseFrames[] = [];
    const batcher = createFrameBatcher((event) => sent.push(event));

    batcher.add(frames([frame(1, "one")]));
    batcher.add({ ...frames([frame(1, "other")]), nodeId: "postman/collections/payment/Other.request.yaml" });

    expect(sent).toHaveLength(ONE_FRAME);
    expect(sent[0]?.nodeId).toBe(NODE_ID);
    vi.useRealTimers();
  });
});

describe("reading a frame in the response pane", () => {
  it("givenAStreamHead_whenReadForItsType_thenTheTypeIsFoundCaseInsensitively", () => {
    expect(streamContentType([["Content-Type", "text/event-stream; charset=utf-8"]])).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(streamContentType([["accept", "*/*"]])).toBeNull();
  });

  it("givenAFrameTime_whenFormatted_thenItIsAFixedWidthClock", () => {
    const shown = frameTime(AT);
    // Fixed fields, because two rows are read against each other to see how far apart they were.
    expect(shown).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/u);
    expect(shown.endsWith(":47.149")).toBe(true);
  });

  it("givenMultilineData_whenSummarised_thenItIsOneLine", () => {
    expect(frameSummary('{\n  "a": 1,\n  "b": 2\n}')).toBe('{ "a": 1, "b": 2 }');
  });

  it("givenJsonData_whenExpanded_thenItIsIndented", () => {
    expect(framePretty('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it("givenDataThatIsNotJson_whenExpanded_thenNothingIsOffered", () => {
    // `[DONE]` is the sentinel every completion stream ends on, and it is not JSON.
    expect(framePretty("[DONE]")).toBeNull();
    expect(framePretty("hello")).toBeNull();
    expect(framePretty("42")).toBeNull();
  });

  it("givenAPartialFrame_whenExpanded_thenItIsLeftAsText", () => {
    expect(framePretty('{"a":')).toBeNull();
  });

  it("givenACount_whenTallied_thenTheNounAgrees", () => {
    expect(frameTally(0)).toBe("0 events");
    expect(frameTally(1)).toBe("1 event");
    expect(frameTally(412)).toBe("412 events");
  });

  it("givenAWindowSmallerThanTheStream_whenLabelled_thenTheGapIsStated", () => {
    expect(hiddenFrames(1000, 1240)).toBe(240);
    expect(frameCountLabel(1000, 1240)).toBe("1240 events · first 240 not kept");
    expect(frameCountLabel(12, 12)).toBe("12 events");
  });
});

/**
 * The expanded frame is the app's editor, which fills a sized parent and has no height of its
 * own. Inside a virtualized row nothing sizes that parent, so the height is arithmetic - and
 * arithmetic that disagrees with the theme is a box that scrolls when it should not, or a row
 * measured before it settles. These are the two halves of that sum, checked against each other.
 */
describe("sizing the editor an expanded frame opens into", () => {
  it("givenAShortFrame_whenSized_thenTheBoxDoesNotCollapseToIt", () => {
    // `[DONE]` is one line. A one-line editor is a sliver; the floor is what stops that.
    expect(frameDetailLines("[DONE]")).toBe(3);
    expect(frameDetailLines("a\nb")).toBe(3);
  });

  it("givenAFrameWithinBounds_whenSized_thenTheBoxIsItsLineCount", () => {
    expect(frameDetailLines("a\nb\nc\nd")).toBe(4);
    expect(frameDetailLines(JSON.stringify({ a: 1, b: 2, c: 3 }, null, 2))).toBe(5);
  });

  it("givenALongFrame_whenSized_thenTheBoxStopsAndScrollsInstead", () => {
    const long = Array.from({ length: 400 }, (_, index) => String(index)).join("\n");
    expect(frameDetailLines(long)).toBe(18);
  });

  it("givenALineCount_whenTurnedIntoAHeight_thenItFollowsTheReadersFontSize", () => {
    const height = editorBoxHeight(4);
    // A calc over the variable, not a pixel count: the box has to retune when the setting does.
    expect(height).toContain("var(--editor-font-size)");
    expect(height).toBe(`calc(var(--editor-font-size) * 1.55 * 4 + 12px)`);
  });

  it("givenTheThemeAndTheHeight_whenCompared_thenTheyReadTheSameTwoNumbers", () => {
    // The failure this prevents: retuning the theme's line height and leaving every expanded
    // frame measuring itself against the old one.
    expect(THEME_SPEC[".cm-scroller"].lineHeight).toBe(String(EDITOR_LINE_HEIGHT));
    expect(THEME_SPEC[".cm-content"].padding).toBe(`${String(EDITOR_CONTENT_PADDING_PX)}px 0`);
    expect(editorBoxHeight(1)).toContain(`* ${String(EDITOR_LINE_HEIGHT)} *`);
  });

  it("givenTheFrameRow_whenRead_thenTheArrowLeadsAndTheCaretTrails", () => {
    // The one list in the app whose left edge is not a disclosure. Only a window can show that,
    // so the order of the two glyphs is asserted here instead.
    const source = readFileSync(join(RENDERER_DIR, "panes", "StreamViewer.tsx"), "utf8");
    const row = source.slice(source.indexOf("function FrameRow("), source.indexOf("function FrameDetail("));
    expect(row.indexOf("<InboundIcon")).toBeGreaterThan(-1);
    expect(row.indexOf("<InboundIcon")).toBeLessThan(row.indexOf("{frameTime(frame.at)}"));
    expect(row.indexOf("{frameTime(frame.at)}")).toBeLessThan(row.indexOf("<CaretRightIcon"));
  });

  it("givenTheFrameDetail_whenRead_thenItIsTheAppsEditorAndReadOnly", () => {
    const source = readFileSync(join(RENDERER_DIR, "panes", "StreamViewer.tsx"), "utf8");
    // From the signature, so the doc comment above it is not part of what is being read.
    const detail = source.slice(source.indexOf("function FrameDetail("));
    expect(detail).toContain("<CodeEditor value={text}");
    expect(detail).toContain("readOnly />");
    // Nothing to commit: a frame is a record of something that already happened.
    expect(detail).not.toContain("onCommit");
  });
});

const RENDERER_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../packages/desktop/src/renderer");
