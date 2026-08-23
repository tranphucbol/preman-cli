/**
 * Workspace search: the query, the answer, and whether the pane is showing.
 *
 * A store rather than component state because three things reach it. `Cmd+Shift+F` opens it from
 * the window's key handler, the sidebar header toggles it, and the results outlive the click that
 * opened a tab - which is the whole point of putting the pane in the sidebar instead of over the
 * editor. Component state in the sidebar could do the first and the third but not the second
 * without threading a callback through the layout.
 */
import { create } from "zustand";

import type { GrepMatch } from "@preman/desktop/engine/protocol.js";

const NO_QUERY = "";
const NO_MATCHES: readonly GrepMatch[] = [];
const NO_WARNINGS: readonly string[] = [];

export interface SearchState {
  /** Whether the sidebar is showing results instead of the tree. */
  showing: boolean;
  query: string;
  running: boolean;
  matches: readonly GrepMatch[];
  /** The engine stopped at `GREP_MATCH_LIMIT`. Said out loud rather than implied by a round count. */
  truncated: boolean;
  warnings: readonly string[];
  error: string | null;
  /** True once a search has actually answered, so an empty list can be told from an empty box. */
  answered: boolean;

  // Function properties rather than method signatures: these are read off the state object and
  // handed to event handlers, and none of them uses `this`.
  show: () => void;
  /** Not named `close` or `hide`: the renderer fence reserves the first, and this pairs with `show`. */
  dismiss: () => void;
  toggle: () => void;
  setQuery: (query: string) => void;
  started: () => void;
  settled: (result: {
    readonly matches: readonly GrepMatch[];
    readonly truncated: boolean;
    readonly warnings: readonly string[];
  }) => void;
  failed: (message: string) => void;
  clear: () => void;
}

const EMPTY = {
  showing: false,
  query: NO_QUERY,
  running: false,
  matches: NO_MATCHES,
  truncated: false,
  warnings: NO_WARNINGS,
  error: null,
  answered: false,
} satisfies Omit<SearchState, "show" | "dismiss" | "toggle" | "setQuery" | "started" | "settled" | "failed" | "clear">;

export const useSearchStore = create<SearchState>((set) => ({
  ...EMPTY,

  show() {
    set({ showing: true });
  },
  dismiss() {
    set({ showing: false });
  },
  toggle() {
    set((state) => ({ showing: !state.showing }));
  },
  setQuery(query) {
    set({ query });
  },
  started() {
    set({ running: true, error: null });
  },
  settled(result) {
    set({
      running: false,
      answered: true,
      matches: result.matches,
      truncated: result.truncated,
      warnings: result.warnings,
      error: null,
    });
  },
  failed(message) {
    set({ running: false, answered: true, matches: NO_MATCHES, truncated: false, error: message });
  },
  clear() {
    // The query goes with it. Node ids are workspace-relative paths, so results from the workspace
    // being closed would point at files the incoming one does not have.
    set(EMPTY);
  },
}));
