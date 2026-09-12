import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { LogRecord } from "@preman/desktop/main/diagnostics.js";
import { LOG_BATCH_LIMIT, LOG_FLUSH_MS, createLogStream, type LogStream } from "@preman/desktop/main/logstream.js";
import { LOG_TAIL_LINES, type LogBatch, type LogLine } from "@preman/desktop/preload/bridge.js";
import {
  LOG_CAPACITY,
  LOG_HEIGHT_DEFAULT,
  LOG_HEIGHT_MIN,
  NO_MATCH,
  NO_QUERY,
  formatLogTime,
  levelClass,
  matchingLines,
  remember,
  resizeLog,
  splitMatches,
  stepMatch,
} from "@preman/desktop/renderer/model/log.js";
import { toneClass } from "@preman/desktop/renderer/model/response.js";
import { useLogStore } from "@preman/desktop/renderer/stores/log.js";

/**
 * The streamed log, asserted at the two seams that can be: the tee in main, whose `send` and `tail`
 * are arguments precisely so a test can collect what it was handed and dictate what it read, and
 * the pure model the pane draws.
 *
 * The last third reads three sources as text, in `resources.test.ts`'s manner and for its reason.
 * What matters most here is an absence and a placement — that nothing is forwarded before anybody
 * asks, and that the subscription is at the top of the window rather than in the pane that flips
 * the switch — and neither is something a component test that cannot mount a component would see
 * go missing. `docs/decisions/056` is what these are holding in place.
 */

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../packages/desktop/src");
const MAIN_SOURCE = readFileSync(join(DESKTOP_DIR, "main/main.ts"), "utf8");
const APP_SOURCE = readFileSync(join(DESKTOP_DIR, "renderer/App.tsx"), "utf8");
const PANE_SOURCE = readFileSync(join(DESKTOP_DIR, "renderer/panes/SettingsPane.tsx"), "utf8");
const STORE_SOURCE = readFileSync(join(DESKTOP_DIR, "renderer/stores/log.ts"), "utf8");

/** What the pane would pass as a ceiling on a normal window, a short one, and a drag between them. */
const A_TALL_WINDOW = 600;
const A_TINY_WINDOW = 40;
const A_TALL_BOX = 480;

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/.*$/gm;
const JSX_COMMENT = /\{\/\*[\s\S]*?\*\/\}/g;
const NOTHING = "";

/** `note`, from its `function` line to the first close at column zero. */
const NOTE = /function note\(level: LogLevel, line: string\): void \{[\s\S]*?\n\}\n/;
/** The window's teardown, which stops the three things in main that would outlive it. */
const ON_CLOSED = /window\.on\("closed"[\s\S]*?\n {2}\}\);/;

const A_MINUTE_MS = 60_000;
const NONE = 0;
const FIRST = 0;

function record(text: string, level: LogRecord["level"] = "info"): LogRecord {
  return { at: 0, level, text };
}

interface Teed {
  readonly stream: LogStream;
  /** Every batch `send` was handed, in order. A batch and not a line: that is the contract. */
  readonly sent: () => readonly LogBatch[];
  /** Only the batches that append, which is everything except the tail answering a switch-on. */
  readonly live: () => readonly (readonly LogLine[])[];
  /** The lines of every batch, flattened, for the cases that are about content rather than shape. */
  readonly lines: () => readonly LogLine[];
}

function teed(tail: readonly LogRecord[] = []): Teed {
  const sent: LogBatch[] = [];
  const stream = createLogStream({
    send: (batch) => sent.push(batch),
    tail: () => tail,
  });
  return {
    stream,
    sent: () => sent,
    live: () => sent.filter((batch) => !batch.replace).map((batch) => batch.lines),
    lines: () => sent.flatMap((batch) => batch.lines),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createLogStream", () => {
  it("givenNobodyIsWatching_whenTheAppLogs_thenNothingIsForwardedOrKept", () => {
    // The gate, and the reason a tee off `note` costs a branch rather than a buffer: an app whose
    // Settings pane was never opened must not be accumulating its own log in memory.
    vi.useFakeTimers();
    const { stream, sent } = teed();

    stream.push("info", "a line nobody asked for");
    vi.advanceTimersByTime(A_MINUTE_MS);

    expect(sent()).toEqual([]);
    stream.stop();
  });

  it("givenTheFileHasHistory_whenTheStreamIsSwitchedOn_thenTheTailArrivesFirst", () => {
    vi.useFakeTimers();
    const { stream, sent } = teed([record("something that happened before anyone looked")]);

    stream.watch(true);

    // Before the first live line and without waiting for a flush: a log you opened to read starts
    // with what already happened, and it is on screen by the time the button has finished being
    // pressed.
    expect(sent()).toHaveLength(1);
    expect(sent()[FIRST]?.replace).toBe(true);
    expect(sent()[FIRST]?.lines.map((each) => each.text)).toEqual(["something that happened before anyone looked"]);
    stream.stop();
  });

  it("givenTheStreamIsSwitchedOnASecondTime_whenTheTailOverlaps_thenItReplacesRatherThanRepeats", () => {
    vi.useFakeTimers();
    const { stream, sent } = teed([record("a line that is in the file")]);

    stream.watch(true);
    stream.watch(false);
    stream.watch(true);

    // Switching on means one thing every time. Appending the tail would print a block the reader
    // had already read, in the middle of a list that reads as continuous.
    expect(sent()).toHaveLength(2);
    expect(sent().every((batch) => batch.replace)).toBe(true);
    stream.stop();
  });

  it("givenTheTailIsLargerThanTheBatchCap_whenItIsSent_thenItIsNotTrimmedToIt", () => {
    vi.useFakeTimers();
    const tail = Array.from({ length: LOG_TAIL_LINES }, (_unused, index) => record(`line ${String(index)}`));
    const { stream, sent } = teed(tail);

    stream.watch(true);

    // The cap is for a runaway writer, and the tail is the opposite: a deliberate read of several
    // hundred lines at once. A cap applied to it would silently deliver the newest 200.
    expect(LOG_TAIL_LINES).toBeGreaterThan(LOG_BATCH_LIMIT);
    expect(sent()[FIRST]?.lines).toHaveLength(LOG_TAIL_LINES);
    stream.stop();
  });

  it("givenATailAndThenALiveLine_whenBothAreKeyed_thenNoSequenceIsReused", () => {
    vi.useFakeTimers();
    const { stream, lines } = teed([record("off the file")]);
    stream.watch(true);

    stream.push("info", "off the wire");
    vi.advanceTimersByTime(LOG_FLUSH_MS);

    // One counter for both, so a line read off the file and a line arriving live can never collide
    // in a list that keys on it.
    const keys = new Set(lines().map((each) => each.seq));
    expect(lines()).toHaveLength(2);
    expect(keys.size).toBe(2);
    stream.stop();
  });

  it("givenAWatcher_whenSeveralLinesAreWrittenAtOnce_thenTheyArriveAsOneBatch", () => {
    vi.useFakeTimers();
    const { stream, live } = teed();
    stream.watch(true);

    stream.push("info", "first");
    stream.push("warn", "second");
    stream.push("error", "third");
    vi.advanceTimersByTime(LOG_FLUSH_MS);

    // One message and not three. A failing start writes a dozen lines inside a millisecond, and
    // one IPC message each is one renderer render each.
    expect(live()).toHaveLength(1);
    expect(live()[FIRST]?.map((each) => each.text)).toEqual(["first", "second", "third"]);
    stream.stop();
  });

  it("givenAQuietApp_whenNothingIsWritten_thenNoEmptyBatchIsEverSent", () => {
    vi.useFakeTimers();
    const { stream, live } = teed();
    stream.watch(true);

    vi.advanceTimersByTime(A_MINUTE_MS);

    // The timer exists between a line and its delivery and at no other time, so a watched app that
    // is not logging holds nothing and sends nothing.
    expect(live()).toEqual([]);
    stream.stop();
  });

  it("givenTwoIdenticalLines_whenTheyAreForwarded_thenTheyAreTwoEntriesWithDifferentKeys", () => {
    vi.useFakeTimers();
    const { stream, lines } = teed();
    stream.watch(true);

    stream.push("info", "the same thing");
    stream.push("info", "the same thing");
    vi.advanceTimersByTime(LOG_FLUSH_MS);

    // A list keyed on anything derived from the line would reconcile these into one row, and a log
    // that silently swallows a repeat is a log that hides exactly the loop you are looking for.
    const [first, second] = lines();
    expect(lines()).toHaveLength(2);
    expect(first?.seq).not.toBe(second?.seq);
    stream.stop();
  });

  it("givenAFlood_whenOneFlushWindowPasses_thenTheBatchIsCappedAtTheNewestLines", () => {
    vi.useFakeTimers();
    const { stream, live } = teed();
    stream.watch(true);

    const written = LOG_BATCH_LIMIT + 10;
    for (let index = 0; index < written; index += 1) stream.push("info", `line ${String(index)}`);
    vi.advanceTimersByTime(LOG_FLUSH_MS);

    // The oldest go, not the newest: this is a tail, and the file kept all of them anyway.
    expect(live()[FIRST]).toHaveLength(LOG_BATCH_LIMIT);
    expect(live()[FIRST]?.[FIRST]?.text).toBe("line 10");
    stream.stop();
  });

  it("givenWatchingStops_whenTheFlushWouldHaveFired_thenWhatWasPendingIsDropped", () => {
    vi.useFakeTimers();
    const { stream, live } = teed();
    stream.watch(true);
    stream.push("info", "written just before the switch went off");

    stream.watch(false);
    vi.advanceTimersByTime(A_MINUTE_MS);

    // Delivering it to whoever switches on next would put a minutes-old line at the bottom of a
    // live tail, which reads as now.
    expect(live()).toEqual([]);
    stream.stop();
  });

  it("givenWatchingIsAskedForTwice_whenLinesArrive_thenNothingIsDoubled", () => {
    vi.useFakeTimers();
    const { stream, sent, live } = teed([record("the tail")]);

    stream.watch(true);
    stream.watch(true);
    stream.push("info", "once");
    vi.advanceTimersByTime(LOG_FLUSH_MS);

    // Including the tail: a second `true` that read the file again would replace the list with the
    // same lines and throw away what had arrived since.
    expect(sent().filter((batch) => batch.replace)).toHaveLength(1);
    expect(live()).toHaveLength(1);
    expect(live()[FIRST]).toHaveLength(1);
    stream.stop();
  });

  it("givenTheWindowIsGone_whenStopIsCalled_thenNoLaterFlushArrives", () => {
    vi.useFakeTimers();
    const { stream, live } = teed();
    stream.watch(true);
    stream.push("info", "in flight when the window closed");

    stream.stop();
    vi.advanceTimersByTime(A_MINUTE_MS);

    expect(live()).toEqual([]);
  });
});

function line(seq: number, text = "a line"): LogLine {
  return { seq, at: 0, level: "info", text };
}

describe("the window's copy of the log", () => {
  it("givenAnEmptyBatch_whenItIsFolded_thenTheSameArrayComesBack", () => {
    const kept = [line(1)];

    // Identity, not equality: a flush that raced a clear would otherwise make every subscriber
    // re-render to be handed what it already had.
    expect(remember(kept, [])).toBe(kept);
  });

  it("givenMoreLinesThanTheCap_whenTheyAreFolded_thenTheNewestAreKept", () => {
    const written = Array.from({ length: LOG_CAPACITY + 5 }, (_unused, index) => line(index));

    const kept = remember([], written);

    // Bounded, because an app left streaming for a week must not grow an array for a week.
    expect(kept).toHaveLength(LOG_CAPACITY);
    expect(kept[0]?.seq).toBe(5);
    expect(kept.at(-1)?.seq).toBe(LOG_CAPACITY + 4);
  });

  it("givenTheTailMainSends_whenItIsKept_thenTheBufferIsExactlyBigEnoughForIt", () => {
    // Derived and not agreed. A buffer smaller than the tail would throw away part of the answer
    // to the question the switch asked, on the frame it arrived.
    expect(LOG_CAPACITY).toBe(LOG_TAIL_LINES);
  });

  it("givenABatchArrives_whenItIsFolded_thenTheNewestAreLast", () => {
    const kept = remember([line(1, "older")], [line(2, "newer")]);

    // Newest at the bottom, which is where a tail puts them and where the view is pinned.
    expect(kept.map((each) => each.text)).toEqual(["older", "newer"]);
  });

  it("givenALineWasWritten_whenItIsDrawn_thenItCarriesTheTimeAndNotTheDate", () => {
    const noon = new Date(2026, 0, 2, 9, 5, 3).getTime();

    // The date is the same on every visible line, so it would cost a column and say nothing.
    expect(formatLogTime(noon)).toBe("09:05:03");
  });

  it("givenTheFourLevels_whenTheyAreDrawn_thenOnlyTheLoudTwoAreColoured", () => {
    // A log is mostly `info`, and a wall of green would claim that everything succeeded rather
    // than that things happened. `error` and `fatal` share the loudest tone; the word is in the
    // level column and there is no colour louder than the loudest.
    expect(levelClass("info")).toBe(toneClass("neutral"));
    expect(levelClass("warn")).toBe(toneClass("warn"));
    expect(levelClass("error")).toBe(toneClass("danger"));
    expect(levelClass("fatal")).toBe(toneClass("danger"));
  });
});

describe("the log store's two kinds of batch", () => {
  afterEach(() => {
    useLogStore.getState().clear();
  });

  it("givenLinesAreOnScreen_whenAnAppendingBatchArrives_thenItGoesUnderneath", () => {
    const { apply } = useLogStore.getState();

    apply({ replace: true, lines: [line(1, "the tail")] });
    apply({ replace: false, lines: [line(2, "what happened next")] });

    expect(useLogStore.getState().lines.map((each) => each.text)).toEqual(["the tail", "what happened next"]);
  });

  it("givenAPreviousSession_whenAReplacingBatchArrives_thenWhatWasThereIsGone", () => {
    const { apply } = useLogStore.getState();
    apply({ replace: false, lines: [line(1, "from the last time the switch was on")] });

    apply({ replace: true, lines: [line(2, "the tail, which already contains it")] });

    // The overlap is the whole reason `replace` exists: these lines are in the tail, and appending
    // would show them twice.
    expect(useLogStore.getState().lines.map((each) => each.text)).toEqual(["the tail, which already contains it"]);
  });

  it("givenAnEmptyFile_whenTheReplacingBatchIsEmptyToo_thenTheListIsEmptied", () => {
    const { apply } = useLogStore.getState();
    apply({ replace: false, lines: [line(1, "left over")] });

    apply({ replace: true, lines: [] });

    // A replace with nothing in it still replaces. Otherwise a session that starts against a
    // freshly rotated file opens showing lines from the session before it.
    expect(useLogStore.getState().lines).toEqual([]);
  });
});

describe("how tall the log box is", () => {
  afterEach(() => {
    useLogStore.setState({ height: LOG_HEIGHT_DEFAULT });
  });

  it("givenADragBelowTheFloor_whenItLands_thenTheBoxStopsAtTheFloor", () => {
    expect(resizeLog(LOG_HEIGHT_MIN - 200, A_TALL_WINDOW)).toBe(LOG_HEIGHT_MIN);
  });

  it("givenADragPastTheWindow_whenItLands_thenTheBoxStopsAtWhatIsLeftOfIt", () => {
    expect(resizeLog(A_TALL_WINDOW + 400, A_TALL_WINDOW)).toBe(A_TALL_WINDOW);
  });

  it("givenAWindowShorterThanTheFloor_whenTheBoxIsResized_thenTheFloorWins", () => {
    // The contradiction: the ceiling is below the floor. A box that collapsed here would collapse
    // on a window nobody deliberately made that short, and overflowing is the better failure.
    expect(resizeLog(LOG_HEIGHT_MIN, A_TINY_WINDOW)).toBe(LOG_HEIGHT_MIN);
  });

  it("givenAFractionalPointer_whenItLands_thenTheHeightIsAWholePixel", () => {
    expect(resizeLog(317.6, A_TALL_WINDOW)).toBe(318);
  });

  it("givenTheBoxWasDraggedTaller_whenTheSectionUnmounts_thenTheStoreStillHoldsIt", () => {
    useLogStore.getState().resize(A_TALL_BOX, A_TALL_WINDOW);

    // The height lives beside the switch and for the switch's reason: a reader drags the box taller
    // because they are about to go and do something, and doing it unmounts the section.
    expect(useLogStore.getState().height).toBe(A_TALL_BOX);
  });
});

describe("searching the log", () => {
  it("givenNoQuery_whenAColumnIsSplit_thenItIsOneUntouchedSegment", () => {
    const segments = splitMatches("engine host started", NO_QUERY);

    // The common case, and it has to cost nothing: with the search shut every one of five hundred
    // rows goes through this three times.
    expect(segments).toEqual([{ text: "engine host started", hit: false }]);
  });

  it("givenAQuery_whenAColumnHoldsItTwice_thenBothRunsAreMarked", () => {
    const segments = splitMatches("host started for the host", "host");

    expect(segments).toEqual([
      { text: "host", hit: true },
      { text: " started for the ", hit: false },
      { text: "host", hit: true },
    ]);
  });

  it("givenADifferentCase_whenItIsSearched_thenItStillMatches", () => {
    // Nobody types a log line's capitalisation back at it, and the level column is drawn lower
    // case while the file stamps it upper.
    expect(splitMatches("Engine", "engine")).toEqual([{ text: "Engine", hit: true }]);
  });

  it("givenAHalfTypedRegex_whenItIsSearched_thenItIsTakenLiterally", () => {
    // Substring and deliberately not a regex: a lone `(` would be a parse error or, worse, a
    // silent zero matches, in a field being typed into one character at a time.
    expect(matchingLines([line(1, "a (paren) in the text")], "(")).toEqual([0]);
  });

  it("givenTheThreeColumns_whenAQueryHitsAnyOfThem_thenTheLineMatches", () => {
    const lines: readonly LogLine[] = [
      { seq: 1, at: new Date(2026, 0, 2, 9, 5, 3).getTime(), level: "warn", text: "nothing to see" },
    ];

    // You can search what you can see, which is why the formatted time is searchable and the epoch
    // milliseconds behind it are not.
    expect(matchingLines(lines, "09:05")).toEqual([0]);
    expect(matchingLines(lines, "warn")).toEqual([0]);
    expect(matchingLines(lines, "see")).toEqual([0]);
    expect(matchingLines(lines, String(lines[0]?.at))).toEqual([]);
  });

  it("givenMatches_whenNextRunsPastTheEnd_thenItWrapsToTheFirst", () => {
    const count = 3;

    expect(stepMatch(count, 0, 1)).toBe(1);
    expect(stepMatch(count, 2, 1)).toBe(0);
    // Wrapping rather than stopping: scrollback is a ring with no beginning worth defending, and a
    // Next that went dead would send the reader back to scrolling by hand.
    expect(stepMatch(count, 0, -1)).toBe(2);
  });

  it("givenNoMatches_whenEitherDirectionIsPressed_thenThereIsNowhereToGo", () => {
    expect(stepMatch(NONE, NO_MATCH, 1)).toBe(NO_MATCH);
    expect(stepMatch(NONE, NO_MATCH, -1)).toBe(NO_MATCH);
  });

  it("givenNobodyHasStepped_whenPreviousIsPressed_thenItStartsFromTheEnd", () => {
    const count = 4;

    // The newest lines are at the bottom, so the match nearest what is on screen is the last one.
    expect(stepMatch(count, NO_MATCH, -1)).toBe(3);
    expect(stepMatch(count, NO_MATCH, 1)).toBe(0);
  });
});

function code(source: string): string {
  return source.replace(JSX_COMMENT, NOTHING).replace(BLOCK_COMMENT, NOTHING).replace(LINE_COMMENT, NOTHING);
}

describe("where the stream is wired", () => {
  it("givenALineIsWrittenAnywhere_whenItIsLogged_thenTheTeeSeesItAfterTheFile", () => {
    const body = NOTE.exec(code(MAIN_SOURCE))?.[0] ?? NOTHING;

    // Every line in the app comes through `note` — the host registry and the updater are handed it
    // as their `write` — which is the whole reason a tee here is honest. The file first: if the
    // disk is what is failing, the line saying so belongs in the file before it belongs in a window.
    expect(body).toContain("diagnostics.write(level, line)");
    expect(body).toContain("logStream?.push(level, line)");
    expect(body.indexOf("diagnostics.write")).toBeLessThan(body.indexOf("logStream?.push"));
  });

  it("givenTheTailIsRead_whenMainAnswersASwitchOn_thenTheFileOwnerIsWhatAnswers", () => {
    // The thing that wrote the file reads it back. `logstream.ts` knows neither where it is nor
    // what a stamped line looks like, which is what keeps the format in one module.
    expect(code(MAIN_SOURCE)).toContain("tail: () => requireDiagnostics().readTail(LOG_TAIL_LINES)");
  });

  it("givenTheWindowCloses_whenNobodyIsLeftToRead_thenTheTeeIsStoppedToo", () => {
    const body = ON_CLOSED.exec(code(MAIN_SOURCE))?.[0] ?? NOTHING;

    // On macOS the app outlives its window, so a flush timer left running would go on batching
    // lines for a reader that no longer exists.
    expect(body).toContain("logStream?.stop()");
  });

  it("givenTheLogIsStreamed_whenTheWindowSubscribes_thenItDoesSoAtTheTopAndNotInThePane", () => {
    // The point of switching the stream on is to go somewhere else and make something happen. A
    // listener that came and went with the Settings pane would miss the lines it was turned on for.
    expect(code(APP_SOURCE)).toContain("window.preman.onLogLines(useLogStore.getState().apply)");
    expect(code(PANE_SOURCE)).not.toContain("onLogLines");
  });

  it("givenTheSwitchIsFlipped_whenMainIsTold_thenTheStoreIsTheOnlyCaller", () => {
    // One writer, so the boolean the button draws and the boolean main holds cannot come apart.
    expect(code(STORE_SOURCE)).toContain("window.preman.watchLog(watching)");
    expect(code(PANE_SOURCE)).not.toContain("watchLog");
  });

  it("givenThePaneUnmounts_whenTheTabOrTheWholePaneCloses_thenTheStreamIsNotTornDown", () => {
    // The opposite of `ResourcesSection`, deliberately: 040's sampler stops on unmount because a
    // reading nobody watched is worthless, and 056 is the case where it is the only useful kind.
    // If a cleanup here ever switches the stream off, this is the line that should have said no.
    expect(code(PANE_SOURCE)).not.toContain("watchLog(false)");
    expect(code(PANE_SOURCE)).toContain("setWatching(!watching)");
  });

  it("givenTheStreamHasNeverBeenOn_whenTheDiagnosticsTabIsOpened_thenNoEmptyBoxIsDrawn", () => {
    // An empty box under a button nobody has pressed reads as a box that failed to fill.
    expect(code(PANE_SOURCE)).toContain(`if (!watching && lines.length === NO_LINES) return null;`);
  });

  it("givenTheReaderHasScrolledUp_whenANewLineArrives_thenTheViewIsNotYanked", () => {
    const source = code(PANE_SOURCE);

    // A tail that dragged the reader back to the bottom on every line would be unusable for the
    // one thing it is for: reading the lines around the moment something went wrong. It is also
    // what lets the search leave the stream running: stepping to a match scrolls, which unpins.
    expect(source).toContain("if (node === null || !pinned.current) return;");
    expect(source).toContain("node.scrollTop = node.scrollHeight;");
  });

  it("givenTheStreamIsStopped_whenItIsSwitchedOff_thenWhatWasCollectedStays", () => {
    // Stopping is not clearing. They are two buttons because they are two intentions.
    expect(code(STORE_SOURCE)).toContain("clear()");
    expect(STORE_SOURCE).toContain("Not a stop");
  });

  it("givenTheAppRestarts_whenItStarts_thenTheStreamIsOff", () => {
    // Nothing persists: a stream is a thing you are currently doing, and a preference that
    // survived a restart would have the app forwarding lines into a pane nobody has opened.
    expect(code(STORE_SOURCE)).toContain("watching: false");
    expect(code(STORE_SOURCE)).not.toContain("preferences");
  });

  it("givenALineWorthQuoting_whenTheReaderDragsAcrossIt_thenItCanBeSelected", () => {
    // A deliberate local exception to the app-wide `select-none` in `app.css`, the same one the
    // response panes take: this is the text of a bug report, and a log you cannot copy a line out
    // of sends the reader to the file for something they are already looking at.
    expect(code(PANE_SOURCE)).toContain("select-text focus-visible:outline-1 focus-visible:outline-accent");
  });

  it("givenTheBoxIsTooShort_whenTheEdgeIsDragged_thenTheCeilingComesFromTheWindow", () => {
    const source = code(PANE_SOURCE);

    // The ceiling is measured, not written down: the window is resizable, so a constant would be
    // wrong on every screen but the author's. It is the window and not the space left below the
    // box — this pane scrolls, and measuring the leftover made the ceiling a function of how much
    // text happened to sit above the box, which on a full tab allowed a five-pixel drag. The
    // capture is what keeps a fast pull from dropping the drag the moment the pointer leaves the
    // strip.
    expect(source).toContain("globalThis.innerHeight - LOG_CEILING_MARGIN_PX");
    expect(source).not.toContain("innerHeight - node.getBoundingClientRect().top");
    expect(source).toContain("strip.setPointerCapture(pressed.pointerId)");
  });

  it("givenNoPointer_whenTheEdgeIsFocused_thenArrowsStillResizeIt", () => {
    const source = code(PANE_SOURCE);

    // A drag handle that only answers a pointer is a size a keyboard cannot choose, and this one
    // decides how much of the thing being read is visible. `preventDefault` because the same arrow
    // would otherwise scroll the pane behind the handle being held.
    expect(source).toContain(`role="separator"`);
    expect(source).toContain("resize(height + delta * LOG_RESIZE_STEP_PX, ceiling())");
    expect(source).toContain("pressed.preventDefault();");
  });

  it("givenTheTail_whenTheWindowIsHandedIt_thenItStillLearnsNothingAboutTheFile", () => {
    // The window is handed lines, never a path. If the pane ever reads `logFile` to fill itself it
    // has grown paging, the rotated file, and a decision about rotating mid-read — all of which
    // main answers once, synchronously, and hands over.
    expect(code(STORE_SOURCE)).not.toContain("logFile");
    expect(NONE).toBe(remember([], []).length);
  });
});
