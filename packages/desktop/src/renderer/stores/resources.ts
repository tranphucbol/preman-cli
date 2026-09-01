/**
 * What the app currently costs, and the last minute of it.
 *
 * A store rather than component state, for one reason worth stating: the subscription and the
 * sampler are two different lifetimes. The renderer's listener is attached and detached whenever a
 * callback changes identity; main's interval is started once when the pane opens and stopped once
 * when it closes, because restarting it would re-prime and throw away the first second of every
 * re-render. Keeping the samples out here is what lets those two be independent.
 *
 * Nothing persists. The history is per-open and dies with the pane, which is the cost
 * `docs/decisions/040` accepted in exchange for an idle app that does no periodic work at all: a
 * spike you were not watching is gone, and the alternative was a ring buffer that never stops
 * filling.
 */
import { create } from "zustand";

import type { ResourceSample } from "@preman/desktop/preload/bridge.js";
import { remember } from "@preman/desktop/renderer/model/resources.js";

const NO_SAMPLE = null;
const NO_HISTORY: ReadonlyMap<number, readonly number[]> = new Map();

export interface ResourcesState {
  /** The newest reading, or `null` before the first one arrives one second after opening. */
  sample: ResourceSample | null;
  /** CPU per pid, oldest first. Keyed by pid because a label is not unique across workspaces. */
  history: ReadonlyMap<number, readonly number[]>;

  // Function properties rather than method signatures, as everywhere else in `stores/`: these are
  // read off the state object and handed to effects, and neither uses `this`.
  apply: (sample: ResourceSample) => void;
  /** On unmount. Not named `reset`: what this does is forget, and the pane is what decides to. */
  forget: () => void;
}

export const useResourcesStore = create<ResourcesState>((set, get) => ({
  sample: NO_SAMPLE,
  history: NO_HISTORY,

  apply(sample) {
    set({ sample, history: remember(get().history, sample) });
  },

  forget() {
    set({ sample: NO_SAMPLE, history: NO_HISTORY });
  },
}));

// Hoisted so a subscribing component passes the same function identity on every render, which is
// what keeps the selector from being treated as a new one and re-running the comparison.
export const selectSample = (state: ResourcesState): ResourceSample | null => state.sample;
export const selectHistory = (state: ResourcesState): ReadonlyMap<number, readonly number[]> => state.history;
