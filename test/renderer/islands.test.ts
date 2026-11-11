/**
 * The islands frame, derived for every bundled theme (ADR 058).
 *
 * Run over all 43 rather than a sample, because the derivation exists precisely so that a theme
 * nobody looked at still gets a frame that separates the islands and still reads.
 */
import { describe, expect, it } from "vitest";

import { CONTRAST_TARGET, contrast, luminance, parseColor } from "@preman/desktop/renderer/appearance/contrast.js";
import {
  ISLAND_MIN_CONTRAST,
  WINDOW_STYLES,
  frameColors,
  isWindowStyle,
  resolveWindowStyle,
  windowBackground,
} from "@preman/desktop/renderer/appearance/islands.js";
import type { Theme } from "@preman/desktop/renderer/appearance/theme.js";
import { THEMES } from "@preman/desktop/renderer/appearance/themes/index.js";
import { DEFAULT_BACKGROUND, DEFAULT_PREFERENCES } from "@preman/desktop/preload/bridge.js";

const BUNDLED_THEME_COUNT = 43;
const DEFAULT_THEME_ID = "preman-dark";

function ratio(a: string, b: string): number {
  return contrast(parseColor(a), parseColor(b));
}

function themeNamed(id: string): Theme {
  const found = THEMES.find((theme) => theme.id === id);
  if (found === undefined) throw new Error(`no bundled theme ${id}`);
  return found;
}

describe("the derived frame", () => {
  it("givenTheBundledThemes_whenCounted_thenAllFortyThreeAreCovered", () => {
    expect(THEMES).toHaveLength(BUNDLED_THEME_COUNT);
  });

  it.each(THEMES.map((theme) => [theme.id, theme] as const))(
    "givenTheme_%s_whenFrameDerived_thenItSeparatesFromCanvasOrTheEdgeIsLine",
    (_id, theme) => {
      const { frame, islandEdge } = frameColors(theme);
      if (ratio(frame, theme.colors.canvas) >= ISLAND_MIN_CONTRAST) expect(islandEdge).toBe(theme.colors.canvas);
      else expect(islandEdge).toBe(theme.colors.line);
    },
  );

  it.each(THEMES.map((theme) => [theme.id, theme] as const))(
    "givenTheme_%s_whenFrameDerived_thenInkAndInkDimStayReadableOnFrameAndFrameRaised",
    (_id, theme) => {
      const { frame, frameRaised } = frameColors(theme);
      for (const surface of [frame, frameRaised]) {
        expect(ratio(theme.colors.ink, surface)).toBeGreaterThanOrEqual(CONTRAST_TARGET.ink);
        expect(ratio(theme.colors["ink-dim"], surface)).toBeGreaterThanOrEqual(CONTRAST_TARGET.inkDim);
      }
    },
  );

  it.each(THEMES.map((theme) => [theme.id, theme] as const))(
    "givenTheme_%s_whenFrameDerived_thenADarkFrameIsLighterAndALightFrameDarkerThanCanvas",
    (_id, theme) => {
      const frame = luminance(parseColor(frameColors(theme).frame));
      const canvas = luminance(parseColor(theme.colors.canvas));
      if (theme.variant === "dark") expect(frame).toBeGreaterThan(canvas);
      else expect(frame).toBeLessThan(canvas);
    },
  );

  it.each(THEMES.map((theme) => [theme.id, theme] as const))(
    "givenTheme_%s_whenFrameDerived_thenFrameRaisedIsAsFarFromFrameAsHoverFromPanel",
    (_id, theme) => {
      const { frame, frameRaised } = frameColors(theme);
      expect(frameRaised).not.toBe(frame);
      expect(ratio(frameRaised, frame)).toBeGreaterThanOrEqual(ratio(theme.colors.hover, theme.colors.panel));
    },
  );

  it("givenAPanelAlreadyFarEnoughFromCanvas_whenFrameDerived_thenThePanelIsKept", () => {
    const base = themeNamed(DEFAULT_THEME_ID);
    const panel = "#2a2d31";
    expect(ratio(panel, base.colors.canvas)).toBeGreaterThanOrEqual(ISLAND_MIN_CONTRAST);
    const theme: Theme = { ...base, colors: { ...base.colors, panel } };

    const { frame, islandEdge } = frameColors(theme);
    expect(frame).toBe(panel);
    expect(islandEdge).toBe(base.colors.canvas);
  });

  it("givenADerivationThatCannotReachTheRatio_whenFrameDerived_thenTheEdgeIsLine", () => {
    const base = themeNamed(DEFAULT_THEME_ID);
    // An ink already under its floor on the panel leaves the frame no readable step to take.
    const theme: Theme = { ...base, colors: { ...base.colors, ink: "#a9acb1" } };

    const { frame, islandEdge } = frameColors(theme);
    expect(ratio(frame, base.colors.canvas)).toBeLessThan(ISLAND_MIN_CONTRAST);
    expect(islandEdge).toBe(base.colors.line);
  });
});

describe("the native window's colour", () => {
  it("givenTheDefaultPreferences_whenTheWindowOpens_thenTheStoredBackgroundIsTheDefaultThemesFrame", () => {
    const theme = themeNamed(DEFAULT_PREFERENCES.themeId);
    expect(DEFAULT_BACKGROUND).toBe(frameColors(theme).frame);
    expect(DEFAULT_PREFERENCES.background).toBe(windowBackground(theme, DEFAULT_PREFERENCES.windowStyle));
  });

  it("givenClassic_whenTheWindowBackgroundIsAsked_thenItIsTheCanvas", () => {
    for (const theme of THEMES) expect(windowBackground(theme, "classic")).toBe(theme.colors.canvas);
  });

  it("givenIslands_whenTheWindowBackgroundIsAsked_thenItIsTheFrame", () => {
    for (const theme of THEMES) expect(windowBackground(theme, "islands")).toBe(frameColors(theme).frame);
  });
});

describe("the window style setting", () => {
  it("givenNoStoredChoice_whenTheDefaultsAreRead_thenIslandsIsOn", () => {
    expect(DEFAULT_PREFERENCES.windowStyle).toBe("islands");
  });

  it.each(WINDOW_STYLES.map((style) => [style] as const))(
    "givenTheKnownStyle_%s_whenResolved_thenItIsKept",
    (style) => {
      expect(isWindowStyle(style)).toBe(true);
      expect(resolveWindowStyle(style)).toBe(style);
    },
  );

  it.each([[undefined], [null], ["floating"], [""], [1]] as const)(
    "givenAMissingOrUnknownValue_%s_whenResolved_thenItFallsBackToIslands",
    (value) => {
      expect(isWindowStyle(value)).toBe(false);
      expect(resolveWindowStyle(value)).toBe(DEFAULT_PREFERENCES.windowStyle);
    },
  );
});
