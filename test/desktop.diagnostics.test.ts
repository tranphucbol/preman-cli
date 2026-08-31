/**
 * The two bounded things the app writes down: a host's last lines, and the file they end up in.
 *
 * Both are pure enough to drive directly — `createOutputTail` is a string splitter and
 * `createDiagnostics` takes the directory as an argument — so nothing here needs Electron, and the
 * only file system it touches is a temp dir it made itself.
 *
 * The bounds are the point. A tail that grew would be a 4MB line in a banner, and a log that grew
 * would be a file the app never deletes; both are asserted at the edge rather than in the middle.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  createDiagnostics,
  createOutputTail,
  HOST_OUTPUT_LINE_LIMIT,
  HOST_OUTPUT_LINES,
} from "@preman/desktop/main/diagnostics.js";

const ENCODING = "utf8";
const LOG_FILE = "preman.log";
const LOG_ROTATED = "preman.log.1";
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const REPORT_PREFIX = "report-";
const REPORTS_KEPT = 5;
const REPORTS_WRITTEN = 6;
const TWO_FILES = 2;
const NO_LINES = 0;
const ONE_LINE = 1;
const OVERFLOW_LINES = 50;
const A_REPORT = '{"header":{"event":"Allocation failed"}}';
const A_LINE = "the engine said something";
const A_LEVEL = "info" as const;
const BLOCKING_FILE = "nowhere";
const NESTED = join(BLOCKING_FILE, "deeper");

const dirs: string[] = [];

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "preman-diagnostics-"));
  dirs.push(dir);
  return dir;
}

/** One line of the size cap, so the rotation can be reached without writing two megabytes. */
function fillLog(dir: string): void {
  writeFileSync(join(dir, LOG_FILE), "x".repeat(LOG_MAX_BYTES), ENCODING);
}

/**
 * A destination no `mkdir -p` can reach: a plain file where a directory has to be. Shorter than a
 * permission bit, and it behaves the same on every platform CI runs on.
 */
function unwritable(): string {
  const dir = directory();
  writeFileSync(join(dir, BLOCKING_FILE), "", ENCODING);
  return join(dir, NESTED);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("what a host said before it stopped", () => {
  it("givenMoreLinesThanTheRing_whenTheTailIsRead_thenOnlyTheLastAreKept", () => {
    const tail = createOutputTail();
    const written = HOST_OUTPUT_LINES + OVERFLOW_LINES;
    for (let index = 0; index < written; index++) tail.push(`line ${String(index)}\n`);

    const lines = tail.lines();
    expect(lines).toHaveLength(HOST_OUTPUT_LINES);
    // The tail, not the head: a crash explains itself on its last lines.
    expect(lines.at(0)).toBe(`line ${String(OVERFLOW_LINES)}`);
    expect(lines.at(-1)).toBe(`line ${String(written - ONE_LINE)}`);
  });

  /** A line cap is the bound that survives one runaway line; a byte cap over the ring is not. */
  it("givenALineLongerThanTheLimit_whenItIsCaptured_thenItIsTruncated", () => {
    const tail = createOutputTail();
    const [captured] = tail.push(`${"y".repeat(HOST_OUTPUT_LINE_LIMIT * TWO_FILES)}\n`);

    expect(captured).toHaveLength(HOST_OUTPUT_LINE_LIMIT);
    expect(tail.lines().at(0)).toHaveLength(HOST_OUTPUT_LINE_LIMIT);
  });

  /** A `data` event is a chunk, not a line. Splitting on arrival would cut stacks at a column. */
  it("givenAChunkWithNoNewline_whenMoreArrives_thenTheLineIsJoinedNotSplit", () => {
    const tail = createOutputTail();

    expect(tail.push("Error: half a ")).toHaveLength(NO_LINES);
    expect(tail.push("sentence\n")).toStrictEqual(["Error: half a sentence"]);
  });

  /** A process that died mid-write left its most interesting line without a newline on it. */
  it("givenAHeldPartialLine_whenTheStreamEnds_thenTheFlushEmitsIt", () => {
    const tail = createOutputTail();
    tail.push("the last thing it said");

    expect(tail.flush()).toStrictEqual(["the last thing it said"]);
    // Once. A second flush has nothing left, and a duplicated last line reads as a repeat.
    expect(tail.flush()).toHaveLength(NO_LINES);
  });

  it("givenAWindowsStyleLineBreak_whenItIsCaptured_thenNoCarriageReturnSurvives", () => {
    expect(createOutputTail().push("first\r\nsecond\r\n")).toStrictEqual(["first", "second"]);
  });

  it("givenAHostThatSaidNothing_whenTheTailIsRead_thenItIsEmpty", () => {
    expect(createOutputTail().lines()).toHaveLength(NO_LINES);
  });
});

describe("keeping a Node diagnostic report", () => {
  it("givenADiagnosticReport_whenItIsWritten_thenThePathIsReturned", () => {
    const dir = directory();
    const file = createDiagnostics({ directory: dir }).writeReport(A_REPORT);

    expect(file).not.toBeNull();
    expect(file?.startsWith(dir)).toBe(true);
    expect(readFileSync(file ?? "", ENCODING)).toBe(A_REPORT);
  });

  /** Unbounded multi-megabyte files produced by exactly the failure mode that repeats. */
  it("givenSixReportsWritten_whenTheDirectoryIsRead_thenFiveRemain", () => {
    const dir = directory();
    const diagnostics = createDiagnostics({ directory: dir });
    const written: (string | null)[] = [];
    for (let index = 0; index < REPORTS_WRITTEN; index++) written.push(diagnostics.writeReport(A_REPORT));

    const kept = readdirSync(dir).filter((name) => name.startsWith(REPORT_PREFIX));
    expect(kept).toHaveLength(REPORTS_KEPT);
    // The oldest is the one that went, and the newest is the one a `details[]` just named.
    expect(kept).not.toContain(written.at(0)?.slice(dir.length + ONE_LINE));
    expect(kept).toContain(written.at(-1)?.slice(dir.length + ONE_LINE));
  });

  /** A crash that could not be recorded is still a crash the exit code describes. */
  it("givenAnUnwritableDirectory_whenAReportIsWritten_thenItAnswersNullWithoutThrowing", () => {
    expect(createDiagnostics({ directory: unwritable() }).writeReport(A_REPORT)).toBeNull();
  });
});

describe("the log file", () => {
  it("givenAFreshDirectory_whenTheFirstLineIsWritten_thenTheDirectoryIsCreated", () => {
    const dir = join(directory(), NESTED);
    const diagnostics = createDiagnostics({ directory: dir });
    silenceStderr();

    diagnostics.write(A_LEVEL, A_LINE);

    expect(readFileSync(join(dir, LOG_FILE), ENCODING)).toContain(A_LINE);
  });

  /** Every line is timestamped here, so the file has one format and the callers have none. */
  it("givenALine_whenItIsWritten_thenItIsTimestampedAndTerminated", () => {
    const dir = directory();
    silenceStderr();
    createDiagnostics({ directory: dir }).write(A_LEVEL, A_LINE);

    const contents = readFileSync(join(dir, LOG_FILE), ENCODING);
    expect(contents.endsWith(`${A_LINE}\n`)).toBe(true);
    expect(contents.split(" ")[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  /**
   * The level is the caller's word, uppercased and put in a fixed column. A ragged left edge costs
   * a reader scanning for the one `FATAL` in four hundred lines exactly the attention it needs.
   */
  it("givenALevel_whenALineIsWritten_thenItIsUppercasedIntoItsOwnColumn", () => {
    const dir = directory();
    silenceStderr();
    const diagnostics = createDiagnostics({ directory: dir });

    diagnostics.write("warn", A_LINE);
    diagnostics.write("fatal", A_LINE);

    const [warned, fatal] = readFileSync(join(dir, LOG_FILE), ENCODING).split("\n");
    expect(warned).toContain(`WARN  ${A_LINE}`);
    expect(fatal).toContain(`FATAL ${A_LINE}`);
    // Same column on both, which is the only thing the padding is for.
    expect(warned?.indexOf(A_LINE)).toBe(fatal?.indexOf(A_LINE));
  });

  /**
   * Decision 7: `stdio: "pipe"` silently takes away the output `bun run desktop` shows today, and
   * a debug change that removes a debug affordance has failed. The file is the addition, not the
   * replacement.
   */
  it("givenALine_whenItIsWritten_thenItAlsoReachesStderr", () => {
    const seen: string[] = [];
    const stderr = silenceStderr(seen);

    createDiagnostics({ directory: directory() }).write(A_LEVEL, A_LINE);

    expect(stderr).toHaveBeenCalled();
    expect(seen.join("")).toContain(A_LINE);
  });

  it("givenALogAtTheSizeCap_whenAnotherLineIsWritten_thenTheFileIsRotatedOnce", () => {
    const dir = directory();
    fillLog(dir);
    silenceStderr();

    createDiagnostics({ directory: dir }).write(A_LEVEL, A_LINE);

    expect(statSync(join(dir, LOG_ROTATED)).size).toBe(LOG_MAX_BYTES);
    expect(readFileSync(join(dir, LOG_FILE), ENCODING)).toContain(A_LINE);
  });

  /** A bound, not a retention policy. The previous `.1` is dropped and nobody is promised it. */
  it("givenARotatedLogAndASecondRotation_whenTheDirectoryIsRead_thenTwoFilesRemain", () => {
    const dir = directory();
    const diagnostics = createDiagnostics({ directory: dir });
    silenceStderr();

    fillLog(dir);
    diagnostics.write(A_LEVEL, A_LINE);
    fillLog(dir);
    diagnostics.write(A_LEVEL, A_LINE);

    expect(readdirSync(dir).sort()).toStrictEqual([LOG_FILE, LOG_ROTATED]);
  });

  /** Not defensive padding: a log that can take the app down is worse than no log. */
  it("givenAnUnwritableDirectory_whenALineIsWritten_thenTheAppDoesNotThrow", () => {
    const diagnostics = createDiagnostics({ directory: unwritable() });
    const seen: string[] = [];
    silenceStderr(seen);

    expect(() => {
      diagnostics.write(A_LEVEL, A_LINE);
    }).not.toThrow();
    // And the line still reached the half a developer with a terminal was going to read.
    expect(seen.join("")).toContain(A_LINE);
  });
});

/** Keep the suite's own output clean, and optionally collect what would have been printed. */
function silenceStderr(into?: string[]): MockInstance<typeof process.stderr.write> {
  return vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    into?.push(String(chunk));
    return true;
  });
}
