/**
 * What main has said since the stream was switched on.
 *
 * A store rather than component state for a stronger version of `resources.ts`'s reason. There the
 * subscription and the timer had different lifetimes; here the *switch* does too. The point of
 * watching a log is to turn it on and then go and do the thing that fails — change tab, close the
 * pane, open a request and send it — and every one of those unmounts the section that holds the
 * button. Lines kept in that section would be lines thrown away by the act of producing them. See
 * `docs/decisions/056`.
 *
 * Nothing persists. `watching` starts false on every launch, because a stream is a thing you are
 * currently doing and a preference that survived a restart would have the app forwarding lines to
 * a pane nobody has opened in a week.
 */
import { create } from "zustand";

import type { LogBatch, LogLine } from "@preman/desktop/preload/bridge.js";
import { LOG_HEIGHT_DEFAULT, remember, resizeLog } from "@preman/desktop/renderer/model/log.js";

const NO_LINES: readonly LogLine[] = [];

export interface LogState {
  /**
   * Newest last, capped at `LOG_CAPACITY`. Empty until the first batch after switching on, which
   * is the tail: what the file already held, so the list starts with history and grows live.
   */
  lines: readonly LogLine[];
  /** Whether main is forwarding. The button reads this; nothing derives it from the lines. */
  watching: boolean;
  /**
   * How tall the box is, in pixels.
   *
   * Here and not in the section for the reason the switch is here: a reader drags the box taller
   * *because* they are about to go and do something, and everything worth doing unmounts the
   * section. A height that reset on the way back would reset at exactly the moment it was earned.
   */
  height: number;

  // Function properties rather than method signatures, as everywhere else in `stores/`: they are
  // read off the state object and handed to effects and handlers, and none of them uses `this`.
  /**
   * Fold in a batch. A replacing one is the answer to a switch-on and starts the list over; every
   * other batch appends. The store does not decide which — main says, because main is the only
   * one that knows whether a batch came off the file or off the wire.
   */
  apply: (batch: LogBatch) => void;
  /**
   * Flip the switch, and tell main. One writer, so the boolean the button draws and the boolean
   * the main process holds cannot come apart — which is what a `watchLog` call made anywhere else
   * would risk.
   */
  setWatching: (watching: boolean) => void;
  /** Throw away what is on screen. Not a stop: the stream, if it is running, goes on running. */
  clear: () => void;
  /** Drag the bottom edge to a new height. Clamped by the model, not by the handler. */
  resize: (height: number, ceiling: number) => void;
}

export const useLogStore = create<LogState>((set, get) => ({
  lines: NO_LINES,
  watching: false,
  height: LOG_HEIGHT_DEFAULT,

  apply(batch) {
    set({ lines: remember(batch.replace ? NO_LINES : get().lines, batch.lines) });
  },

  setWatching(watching) {
    if (get().watching === watching) return;
    window.preman.watchLog(watching);
    set({ watching });
  },

  clear() {
    set({ lines: NO_LINES });
  },

  resize(height, ceiling) {
    const next = resizeLog(height, ceiling);
    if (get().height === next) return;
    set({ height: next });
  },
}));

// Hoisted so a subscribing component passes the same identity on every render, which is what keeps
// the selector from being treated as a new one and re-running the comparison.
export const selectLines = (state: LogState): readonly LogLine[] => state.lines;
export const selectWatching = (state: LogState): boolean => state.watching;
export const selectHeight = (state: LogState): number => state.height;
