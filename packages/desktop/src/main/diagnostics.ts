/**
 * What the two Node processes leave behind when nobody is watching a terminal.
 *
 * The renderer ships DevTools; the main process and the engine host shipped nothing, and a build
 * launched from Finder writes its stderr to a file descriptor pointing at nothing. This module is
 * the one writer: main owns the file, the engine writes to a pipe main reads, and two processes
 * appending to and rotating one file is a corrupted file on the day it matters.
 *
 * What may go in it is process lifecycle, exits, crash reasons, failed operations, and the two
 * captured streams — each carrying the level the process that produced it meant. What may not is a
 * URL, a header, a body, or a variable name or value. The engine resolves `{{token}}` and holds
 * response bodies, so a file that recorded traffic would be a credential file with a different
 * name. See `docs/decisions/035`, and `036` for the file paths it may name and the levels.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { LOG_LEVELS, type LogLevel } from "@preman/desktop/engine/protocol.js";

/**
 * How much of a host's output is kept for the failure that follows it.
 *
 * A crash explains itself on its last lines, so this is a tail and not a head, and it is capped by
 * line count rather than by bytes because a line cap is the bound that survives one 4MB line.
 */
export const HOST_OUTPUT_LINES = 200;
export const HOST_OUTPUT_LINE_LIMIT = 4 * 1024;

const LOG_FILE = "preman.log";
const LOG_ROTATED = "preman.log.1";
const LOG_MAX_BYTES = 2 * 1024 * 1024;
/**
 * How many Node diagnostic reports survive. Each is thousands of lines of JS frames, native
 * frames, heap and OS state, and the failure that produces one is the failure that repeats.
 */
const DIAGNOSTIC_REPORT_KEEP = 5;
const DIAGNOSTIC_REPORT_PREFIX = "report-";
const DIAGNOSTIC_REPORT_SUFFIX = ".json";
const DIAGNOSTIC_REPORT_SEPARATOR = "-";
/**
 * Enough digits that `report-<epoch ms>-<sequence>.json` is fixed-width for the next few
 * centuries, which is what lets {@link prune} sort the names as text and get chronological order.
 */
const SEQUENCE_DIGITS = 6;
const SEQUENCE_PAD = "0";
const FIRST_SEQUENCE = 0;
const NOTHING_TO_PRUNE = 0;

const ENCODING = "utf8";
const NEWLINE = "\n";
const STAMP_SEPARATOR = " ";
/**
 * The level column is padded to the longest name so the message starts at the same column on
 * every line. A log is read by eye first and by `grep` second, and a ragged left edge costs the
 * first reading nothing but attention.
 */
const LEVEL_WIDTH = Math.max(...LOG_LEVELS.map((level) => level.length));
const LEVEL_PAD = " ";
/** `\r\n` too: a Windows engine's stderr must not arrive with a carriage return on every line. */
const LINE_BREAK = /\r?\n/;
const NOTHING_HELD = "";

/**
 * A stream split into lines, of which only the last {@link HOST_OUTPUT_LINES} are kept.
 *
 * A `data` event is a chunk, not a line: it can end mid-word and the next one continues it, so
 * anything that treated a chunk as a line would report a stack trace cut at an arbitrary column.
 */
export interface OutputTail {
  /** Feed a chunk. Answers with the lines it completed, in order, already truncated. */
  push(chunk: string): readonly string[];
  /**
   * The stream ended. Answers with whatever was held back, because a process that dies mid-write
   * leaves its most interesting line without a newline on the end of it.
   */
  flush(): readonly string[];
  /** The tail, oldest first. */
  lines(): string[];
}

export function createOutputTail(): OutputTail {
  const kept: string[] = [];
  let held = NOTHING_HELD;

  function keep(line: string): string {
    const truncated = line.slice(0, HOST_OUTPUT_LINE_LIMIT);
    kept.push(truncated);
    if (kept.length > HOST_OUTPUT_LINES) kept.splice(0, kept.length - HOST_OUTPUT_LINES);
    return truncated;
  }

  return {
    push(chunk) {
      const parts = (held + chunk).split(LINE_BREAK);
      // Whatever followed the final newline, which for a chunk that ended on one is the empty
      // string. Popped rather than inspected: a complete line is one that had a break after it.
      held = parts.pop() ?? NOTHING_HELD;
      return parts.map(keep);
    },
    flush() {
      if (held === NOTHING_HELD) return [];
      const line = keep(held);
      held = NOTHING_HELD;
      return [line];
    },
    lines() {
      return [...kept];
    },
  };
}

export interface DiagnosticsOptions {
  /** `app.getPath("logs")`. Passed in so `main.ts` keeps owning every path decision. */
  readonly directory: string;
}

export interface Diagnostics {
  /**
   * One line. Timestamped and levelled here so every line in the file is in the same format —
   * the caller supplies severity and prose, never punctuation.
   */
  write(level: LogLevel, line: string): void;
  /**
   * Persist a Node diagnostic report; returns the file it went to, or `null` if it could not be
   * written. Never the report itself: `details[]` gets a path, because the alternative is a
   * multi-megabyte string in a banner.
   */
  writeReport(report: string): string | null;
  readonly logFile: string;
  readonly directory: string;
}

/**
 * Drop all but the newest {@link DIAGNOSTIC_REPORT_KEEP} reports.
 *
 * Sorted as text, which is chronological because the names are fixed-width and start with the
 * clock. Anything in the directory that is not a report — the log and its one rotation — never
 * matches the prefix and is never considered.
 */
function prune(directory: string): void {
  const reports = readdirSync(directory)
    .filter((name) => name.startsWith(DIAGNOSTIC_REPORT_PREFIX) && name.endsWith(DIAGNOSTIC_REPORT_SUFFIX))
    .sort();
  // Clamped, because `slice(0, -n)` counts from the end: under the cap it would drop the newest
  // reports rather than none of them.
  const excess = Math.max(NOTHING_TO_PRUNE, reports.length - DIAGNOSTIC_REPORT_KEEP);
  for (const name of reports.slice(NOTHING_TO_PRUNE, excess)) {
    rmSync(join(directory, name), { force: true });
  }
}

export function createDiagnostics(options: DiagnosticsOptions): Diagnostics {
  const logFile = join(options.directory, LOG_FILE);
  const rotatedFile = join(options.directory, LOG_ROTATED);
  let sequence = FIRST_SEQUENCE;

  /**
   * One size cap and one rename. That is a bound, not a retention policy: the previous `.1` is
   * dropped, and nobody is promised yesterday's log.
   */
  function rotate(): void {
    if (!existsSync(logFile)) return;
    if (statSync(logFile).size < LOG_MAX_BYTES) return;
    rmSync(rotatedFile, { force: true });
    renameSync(logFile, rotatedFile);
  }

  return {
    logFile,
    directory: options.directory,

    write(level, line) {
      const column = level.toUpperCase().padEnd(LEVEL_WIDTH, LEVEL_PAD);
      const stamped = `${new Date().toISOString()}${STAMP_SEPARATOR}${column}${STAMP_SEPARATOR}${line}${NEWLINE}`;
      // The terminal first, and unconditionally: `bun run desktop` showed this output before the
      // engine's stdio became a pipe, and a debug change that removes a debug affordance has failed.
      process.stderr.write(stamped);
      try {
        mkdirSync(options.directory, { recursive: true });
        rotate();
        appendFileSync(logFile, stamped, ENCODING);
      } catch {
        // A log that can take the app down is worse than no log. The line reached stderr above,
        // which is the half a developer with a terminal was going to read anyway.
      }
    },

    writeReport(report) {
      try {
        mkdirSync(options.directory, { recursive: true });
        const stamp = String(Date.now());
        const ordinal = String(sequence++).padStart(SEQUENCE_DIGITS, SEQUENCE_PAD);
        const file = join(
          options.directory,
          `${DIAGNOSTIC_REPORT_PREFIX}${stamp}${DIAGNOSTIC_REPORT_SEPARATOR}${ordinal}${DIAGNOSTIC_REPORT_SUFFIX}`,
        );
        writeFileSync(file, report, ENCODING);
        prune(options.directory);
        return file;
      } catch {
        // Same reason as `write`. A crash that could not be recorded is still a crash the exit
        // code, the captured tail and `child-process-gone`'s reason all describe.
        return null;
      }
    },
  };
}
