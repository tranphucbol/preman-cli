/**
 * The current preferences, and the side effects of changing one.
 *
 * Three things happen on every change and they happen in that order: the custom properties are
 * written, so the next frame is already right; the native window is told, because no stylesheet
 * reaches the traffic lights or the colour behind an overscroll; and only then is the record
 * persisted, because a disk write is the one part the user is not waiting on.
 *
 * The store holds the resolved `Theme` as well as the id. A component that wants a swatch wants
 * the colours, and resolving the id at forty call sites would be forty chances to disagree about
 * what an unknown id means.
 */
import { useEffect } from "react";
import { create } from "zustand";

import { applyPreferences } from "@preman/desktop/renderer/appearance/apply.js";
import { densityTokens, type DensityTokens } from "@preman/desktop/renderer/appearance/density.js";
import type { Theme } from "@preman/desktop/renderer/appearance/theme.js";
import { THEMES } from "@preman/desktop/renderer/appearance/themes/index.js";
import {
  DEFAULT_PREFERENCES,
  type Density,
  type Preferences,
  type WindowChrome,
} from "@preman/desktop/preload/bridge.js";

const FIRST = 0;

/**
 * An id nobody bundles resolves to the default rather than throwing. The id comes from a JSON file
 * a user can edit and from a build that may have dropped a palette; neither is a reason to show a
 * blank window.
 */
export function themeById(id: string): Theme {
  const found = THEMES.find((theme) => theme.id === id) ?? THEMES[FIRST];
  if (found === undefined) throw new Error("no themes are bundled");
  return found;
}

/**
 * The two values the main process caches. Recomputed on every save rather than trusted, so a
 * stored copy that went stale — a theme whose canvas changed under a rebuild — is corrected the
 * first time the user touches anything.
 */
function chromeFor(theme: Theme, density: Density): WindowChrome {
  return { canvas: theme.colors.canvas, barHeightPx: densityTokens(density).bar };
}

export interface AppearanceState {
  preferences: Preferences;
  theme: Theme;

  /** Apply, tell the window, persist. The only way any of the three happens. */
  setPreferences: (next: Preferences) => void;
  setTheme: (themeId: string) => void;
  setDensity: (density: Density) => void;
  setEditorFontSize: (px: number) => void;
  setFontMono: (family: string | null) => void;
  setFontSans: (family: string | null) => void;
}

/**
 * Read from the bridge, not from a default: the preload already fetched it synchronously, which is
 * the entire reason it is a value there and not a promise.
 */
function initialPreferences(): Preferences {
  return { ...DEFAULT_PREFERENCES, ...window.preman.preferences };
}

export const useAppearanceStore = create<AppearanceState>((set, get) => {
  const preferences = initialPreferences();

  function commit(next: Preferences): void {
    const theme = themeById(next.themeId);
    const chrome = chromeFor(theme, next.density);
    const corrected: Preferences = { ...next, ...chrome };
    applyPreferences(theme, corrected);
    window.preman.setWindowChrome(chrome);
    set({ preferences: corrected, theme });
    void window.preman.savePreferences(corrected);
  }

  return {
    preferences,
    theme: themeById(preferences.themeId),

    setPreferences: commit,
    setTheme(themeId) {
      commit({ ...get().preferences, themeId });
    },
    setDensity(density) {
      commit({ ...get().preferences, density });
    },
    setEditorFontSize(px) {
      commit({ ...get().preferences, editorFontSize: px });
    },
    setFontMono(family) {
      commit({ ...get().preferences, fontMono: family });
    },
    setFontSans(family) {
      commit({ ...get().preferences, fontSans: family });
    },
  };
});

/**
 * The density itself, for the two panes whose row is derived from it rather than equal to it.
 * A component that only reads this does not re-render when the theme changes.
 */
export function useDensity(): Density {
  return useAppearanceStore((state) => state.preferences.density);
}

/** All eight numbers. The returned record is the shared frozen preset, so the selector is stable. */
export function useDensityTokens(): DensityTokens {
  return useAppearanceStore((state) => densityTokens(state.preferences.density));
}

/**
 * Only the part of a virtualizer this needs, so no pane has to name a generic to call it.
 */
interface Remeasurable {
  measure: () => void;
}

/**
 * Throw away a virtualizer's cached row heights when the density changes.
 *
 * `estimateSize` is consulted once per index and the answer is kept; changing the closure is not
 * enough, because the measurement cache still holds the old numbers and the rows would keep their
 * old offsets while their contents shrank. This is the whole cost of density being a number rather
 * than a class, and it is one line per pane.
 */
export function useRemeasure(virtualizer: Remeasurable, rowHeight: number): void {
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);
}

/**
 * The first application, before React exists. Called from `main.tsx` ahead of `render()` so the
 * document's first paint is already the chosen theme rather than the stylesheet's literals
 * corrected a frame later.
 */
export function applyStoredPreferences(): void {
  const preferences = initialPreferences();
  applyPreferences(themeById(preferences.themeId), preferences);
}
