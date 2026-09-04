/**
 * The panes that sit *beside* the request rather than over it.
 *
 * Deliberately not in `overlay.ts`, and the difference is the whole reason this file exists. An
 * overlay replaces the editor: you go to it, use it and come back. An aside is open while you
 * work, and the thing it is about stays editable underneath your hands. The command aside is only
 * worth having on that second footing — a `curl` you can read while you change the URL that
 * produced it is a feedback loop, and the same `curl` behind a modal is a receipt.
 *
 * A store rather than props because the three things that open it are at three different depths:
 * the icon in the request toolbar is below the pane that draws it, the command palette and the
 * File menu are above. Threading a callback up and a flag down through both would put this
 * boolean in four component signatures to hold it in one place.
 *
 * Only the intent lives here. How wide the aside is belongs to the splitter, the same way the
 * console's height does.
 */
import { create } from "zustand";

export interface AsideState {
  /** Whether the command aside is open. It follows the active tab; it is not pinned to a node. */
  command: boolean;

  // Function properties rather than method signatures, matching `overlay.ts`: these are read off
  // the state object and handed to event handlers, and none of them uses `this`.
  toggleCommand: () => void;
  showCommand: () => void;
  /** Not named `close`: the renderer fence reserves that word for `window.close`. */
  dismissCommand: () => void;
}

export const useAsideStore = create<AsideState>((set) => ({
  command: false,

  toggleCommand() {
    set((state) => ({ command: !state.command }));
  },

  showCommand() {
    set({ command: true });
  },

  dismissCommand() {
    set({ command: false });
  },
}));
