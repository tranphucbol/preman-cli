/**
 * The panes that are not a file.
 *
 * The variable manager, the proto manager, the collection runner and the settings pane are
 * workspace-wide or app-wide tools, not documents, so they are an overlay over the editor area
 * rather than entries in the tab strip. A tab is a file with unsaved bytes, a title, a dirty dot
 * and a draft in app data; teaching `tabsStore` that some of its tabs have none of those would put
 * a `kind` check in every one of those paths to buy nothing.
 *
 * One at a time, deliberately. All of them are full-width and all of them are things you open, use
 * and close; two of them side by side would mean laying out a pane arrangement nobody asked for.
 *
 * Settings is here and not in a modal dialog for the same reason it has no OK button: a theme you
 * are choosing has to be visible on the app you are choosing it for, and a dialog would cover the
 * sidebar and the tab strip, which is most of what a density preset changes.
 */
import { create } from "zustand";

/** The runner is opened on a node, the variable manager on the session's own environment. */
export type Overlay =
  | { readonly kind: "variables" }
  | { readonly kind: "protos" }
  | { readonly kind: "runner"; readonly nodeId: string }
  | { readonly kind: "settings" };

const NO_OVERLAY = null;

export interface OverlayState {
  overlay: Overlay | null;

  // Function properties rather than method signatures: these are read off the state object and
  // handed to event handlers, and none of them uses `this`.
  showVariables: () => void;
  showProtos: () => void;
  showRunner: (nodeId: string) => void;
  showSettings: () => void;
  /** Not named `close`: the renderer fence reserves that word for `window.close`. */
  dismiss: () => void;
}

export const useOverlayStore = create<OverlayState>((set) => ({
  overlay: NO_OVERLAY,

  showVariables() {
    set({ overlay: { kind: "variables" } });
  },

  showProtos() {
    set({ overlay: { kind: "protos" } });
  },

  showRunner(nodeId) {
    set({ overlay: { kind: "runner", nodeId } });
  },

  showSettings() {
    set({ overlay: { kind: "settings" } });
  },

  dismiss() {
    set({ overlay: NO_OVERLAY });
  },
}));
