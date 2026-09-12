/**
 * The log, while somebody is watching it.
 *
 * A tee off `note()` rather than a tail of `preman.log`, and the difference is the whole design.
 * The writer already holds the level and the text; a tail would have to watch a file, cope with a
 * partial last line, and notice the rotation at 2MB — three ways to show something that is not what
 * was written, in exchange for nothing the writer could not hand over directly.
 *
 * The file is still read, exactly once per switch-on, for the lines written before anyone was
 * watching. That read is the only thing here that touches the disk, it is synchronous, and it
 * happens in the same turn as the switch: see {@link LogStream.watch} for why those two facts are
 * the same fact.
 *
 * Nothing is buffered while nobody is watching, which is the same gate `main/resources.ts` has and
 * for a weaker version of the same reason: this holds no timer at rest, so an app with the pane
 * shut costs one branch per logged line. See `docs/decisions/056`.
 *
 * Structurally typed with an injected `send` and an injected `tail`, like the sampler, so the
 * batching can be tested without loading `electron` or writing a file.
 */
import type { LogLevel } from "@preman/desktop/engine/protocol.js";
import type { LogBatch, LogLine } from "@preman/desktop/preload/bridge.js";

import type { LogRecord } from "./diagnostics.js";

/**
 * How long a line waits for the ones behind it.
 *
 * Logging is bursty in exactly the places it matters — a failing start writes a dozen lines inside
 * a millisecond — and one IPC message per line is one renderer render per line. A tenth of a second
 * is below the threshold at which a reader would call the pane laggy and far above the width of a
 * burst, so a burst arrives as one array and repaints once.
 */
export const LOG_FLUSH_MS = 100;

/**
 * The most lines one *live* message may carry.
 *
 * A cap and not a queue: a process stuck in a loop that logs can write faster than a window can
 * paint, and an array that grew for as long as that lasted would be a memory leak in the one
 * process that must not have one. Over the cap the *oldest* pending lines are dropped, because the
 * renderer keeps a window of the newest anyway — and the file, unlike this, kept all of them.
 *
 * The tail is exempt, and has to be: it is a deliberate read of several hundred lines at once, and
 * a cap meant for a runaway writer would silently deliver the newest 200 of them.
 */
export const LOG_BATCH_LIMIT = 200;

const NO_LINES = 0;

/** A batch that continues the list, which is every batch except the one answering a switch-on. */
const APPEND = false;
/** A batch that starts the list. Only the tail carries it. */
const REPLACE = true;

export interface LogStreamOptions {
  /** Where a batch goes. Main owns the window handle, so it owns the guard on a dead one. */
  readonly send: (batch: LogBatch) => void;
  /**
   * The lines written before anyone asked to watch. Injected rather than read here, so this module
   * knows nothing about where the file is or what format it is in — `main/diagnostics.ts` owns
   * both, being the thing that wrote it.
   */
  readonly tail: () => readonly LogRecord[];
  /** Overridden only by the tests. The app takes {@link LOG_FLUSH_MS}. */
  readonly flushMs?: number;
  /** Overridden only by the tests. The app takes {@link LOG_BATCH_LIMIT}. */
  readonly batchLimit?: number;
}

export interface LogStream {
  /**
   * Start or stop forwarding. Idempotent in both directions, like the sampler's: a window that
   * re-subscribes must not double anything, and a `false` that arrives twice is not an error.
   *
   * Switching on sends the tail first, as a batch that replaces rather than appends, and sends it
   * before this call returns. Nothing may come between the read and the switch: a line written in
   * that gap would be too late for the read and too early for the forwarding, and would be the one
   * line missing from an otherwise continuous list.
   *
   * Turning it off drops whatever is pending. Those lines are in the file; delivering them to the
   * next watcher would put minutes-old text at the bottom of a live tail, which reads as now.
   */
  watch(watching: boolean): void;
  /** Every line this process writes down, watched or not. `note()` is the only caller. */
  push(level: LogLevel, text: string): void;
  /** For the window going away, which is a stop nobody sent. */
  stop(): void;
}

export function createLogStream(options: LogStreamOptions): LogStream {
  const flushMs = options.flushMs ?? LOG_FLUSH_MS;
  const batchLimit = options.batchLimit ?? LOG_BATCH_LIMIT;

  let watching = false;
  let pending: LogLine[] = [];
  let timer: NodeJS.Timeout | null = null;
  /**
   * A key the renderer can use without comparing text.
   *
   * Two identical lines a second apart are two entries, and a list keyed by anything derived from
   * the line itself would reconcile them as one. Monotonic across a session and never reset —
   * clearing the pane throws away lines, not the count of what has been said. The tail's lines are
   * numbered from it too, so a line read off the file and the same line arriving live could never
   * collide in the list.
   */
  let seq = NO_LINES;

  function number(record: LogRecord): LogLine {
    seq += 1;
    return { seq, at: record.at, level: record.level, text: record.text };
  }

  function flush(): void {
    timer = null;
    if (pending.length === NO_LINES) return;
    const lines = pending;
    pending = [];
    options.send({ replace: APPEND, lines });
  }

  return {
    watch(next) {
      if (next === watching) return;
      if (!next) {
        watching = false;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        pending = [];
        return;
      }
      // Read, then open the gate, in one turn with nothing awaited between them. That is what
      // makes the seam exact: main is single-threaded and `note()` calls `push` from this same
      // thread, so there is no instant at which a line could be written and be neither in what the
      // read returned nor in what the forwarding picks up. An asynchronous read would have one.
      const lines = options.tail().map(number);
      watching = true;
      options.send({ replace: REPLACE, lines });
    },

    push(level, text) {
      if (!watching) return;
      pending.push(number({ at: Date.now(), level, text }));
      // Trimmed here rather than at the flush, so the array itself never exceeds the cap.
      if (pending.length > batchLimit) pending = pending.slice(pending.length - batchLimit);
      // `setTimeout` and not an interval: the timer exists only between a line and its delivery,
      // so a quiet app holds none at all even with the pane open.
      timer ??= setTimeout(flush, flushMs);
    },

    stop() {
      watching = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = [];
    },
  };
}
