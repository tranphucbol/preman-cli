/**
 * The two panes that are not a file.
 *
 * The variable manager and the collection runner are workspace-wide tools, not documents, so they
 * are an overlay over the editor area rather than entries in the tab strip. A tab is a file with
 * unsaved bytes, a title, a dirty dot and a draft in app data; teaching `tabsStore` that some of
 * its tabs have none of those would put a `kind` check in every one of those paths to buy nothing.
 *
 * One at a time, deliberately. Both are full-width and both are things you open, use and close;
 * two of them side by side would mean laying out a pane arrangement nobody asked for.
 */
import { create } from "zustand";

/** The runner is opened on a node, the variable manager on the session's own environment. */
export type Overlay = { readonly kind: "variables" } | { readonly kind: "runner"; readonly nodeId: string };

const NO_OVERLAY = null;

export interface OverlayState {
  overlay: Overlay | null;

  // Function properties rather than method signatures: these are read off the state object and
  // handed to event handlers, and none of them uses `this`.
  showVariables: () => void;
  showRunner: (nodeId: string) => void;
  /** Not named `close`: the renderer fence reserves that word for `window.close`. */
  dismiss: () => void;
}

export const useOverlayStore = create<OverlayState>((set) => ({
  overlay: NO_OVERLAY,

  showVariables() {
    set({ overlay: { kind: "variables" } });
  },

  showRunner(nodeId) {
    set({ overlay: { kind: "runner", nodeId } });
  },

  dismiss() {
    set({ overlay: NO_OVERLAY });
  },
}));
