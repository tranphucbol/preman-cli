/**
 * The rate limiter between a stream and the window reading it.
 *
 * A model streaming tokens dispatches a frame every few milliseconds. Each one
 * crossing the port on its own is a structured clone, a message, a store write and a
 * React render, and the renderer loses that race long before the network does. So
 * frames are collected here and handed over in batches no more often than a display
 * can show them. See `docs/decisions/052-a-stream-is-a-response-in-parts.md`.
 *
 * This is the whole of the buffering. The engine still holds the raw stream, and the
 * renderer still holds only what it can show; what this module owns is the middle.
 */
import type { RunEvent } from "@preman/desktop/engine/protocol.js";

type ResponseFrames = Extract<RunEvent, { type: "response-frames" }>;

/**
 * How long frames may wait for company. Two frames of a 60Hz display: long enough
 * that a fast stream batches, short enough that a slow one still feels immediate.
 */
export const FRAME_FLUSH_MS = 32;

/**
 * The most frames one batch may carry. A stream fast enough to exceed this in 32ms
 * is producing more rows than anyone can read, and the renderer would discard the
 * oldest of them anyway; dropping them here saves the clone as well as the render.
 * The raw stream is untouched by this and stays readable in full through the body.
 */
export const FRAME_BATCH_MAX = 500;

const NOTHING_DROPPED = 0;
const FIRST = 0;

export interface FrameBatcher {
  /** Take one core-emitted batch. It leaves on the next flush, not now. */
  add(event: ResponseFrames): void;
  /**
   * Hand over whatever is waiting. Call before emitting any other run event, so a
   * `stream-end` cannot overtake the frames it is meant to close.
   */
  flush(): void;
  /** Drop what is waiting and stop the timer. The run is over or nobody is listening. */
  discard(): void;
}

/**
 * Collect frames for `emit`, which is called with a merged event and never with an
 * empty one.
 */
export function createFrameBatcher(emit: (event: ResponseFrames) => void): FrameBatcher {
  let pending: ResponseFrames | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stopTimer = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const flush = (): void => {
    stopTimer();
    const batch = pending;
    pending = undefined;
    if (batch !== undefined) emit(batch);
  };

  return {
    add: (event) => {
      // Two requests never stream at once today, because a group run is sequential.
      // Flushing on a change of node keeps that an observation rather than a premise.
      if (pending !== undefined && pending.nodeId !== event.nodeId) flush();

      if (pending === undefined) pending = { ...event, frames: [...event.frames] };
      else {
        pending.frames.push(...event.frames);
        pending.dropped += event.dropped;
        pending.byteLength = event.byteLength;
      }

      const excess = pending.frames.length - FRAME_BATCH_MAX;
      if (excess > NOTHING_DROPPED) {
        pending.frames.splice(FIRST, excess);
        pending.dropped += excess;
      }

      timer ??= setTimeout(flush, FRAME_FLUSH_MS);
    },
    flush,
    discard: () => {
      stopTimer();
      pending = undefined;
    },
  };
}
