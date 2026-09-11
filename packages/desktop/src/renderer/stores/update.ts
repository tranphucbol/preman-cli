/**
 * Where the updater is, as the window last heard it.
 *
 * One store and one subscription, which is the file-per-subscription rule in `AGENTS.md`, and the
 * reason it is a store rather than component state is the same one `resources.ts` gives: the thing
 * pushing and the things reading have different lifetimes. Main pushes on its own clock — ten
 * seconds after the window loads, then once a day — while the Settings pane and the banner mount
 * and unmount around it. A phase kept in either of them would be a phase lost when it closed.
 *
 * Nothing here decides anything. The phase is a value main owns; the window renders it and calls
 * the four verbs back. Deriving "there is an update" from anything but `phase` is how a window
 * ends up disagreeing with the process that would have to perform the update.
 */
import { create } from "zustand";

import { IDLE_UPDATE, type UpdateStatus } from "@preman/desktop/preload/bridge.js";

export interface UpdateState {
  status: UpdateStatus;
  /** Function property rather than a method, as everywhere else in `stores/`: it is handed to an
   * effect and does not use `this`. */
  apply: (status: UpdateStatus) => void;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  status: IDLE_UPDATE,
  apply(status) {
    set({ status });
  },
}));

/** Hoisted so a subscribing component passes the same identity on every render. */
export const selectStatus = (state: UpdateState): UpdateStatus => state.status;
