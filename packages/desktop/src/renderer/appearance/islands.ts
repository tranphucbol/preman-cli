/**
 * The Islands window style: the panes are rounded `canvas` cards on a `frame`. ADR 058.
 *
 * The frame is derived from the theme rather than stored in it. 42 of the 43 themes are generated
 * from upstream palettes that have no colour for this, and a derivation gives every theme — the next
 * one included — a frame on the day it is added. Pure: no DOM, no store, so the tests run it over
 * every bundled theme and `apply.ts` and the appearance store share one answer.
 */
import {
  BLACK,
  CONTRAST_TARGET,
  WHITE,
  contrast,
  mix,
  parseColor,
  toHex,
  type Rgb,
} from "@preman/desktop/renderer/appearance/contrast.js";
import type { Theme, Variant } from "@preman/desktop/renderer/appearance/theme.js";
import { DEFAULT_PREFERENCES, type WindowStyle } from "@preman/desktop/preload/bridge.js";

export const WINDOW_STYLES = ["islands", "classic"] as const satisfies readonly WindowStyle[];

export function isWindowStyle(value: unknown): value is WindowStyle {
  return (WINDOW_STYLES as readonly unknown[]).includes(value);
}

/**
 * What a stored value that is missing or names nothing resolves to. The value comes from a JSON file
 * a user can edit, so an unknown one is not a programmer error — it is the default, as an unknown
 * density is.
 */
export function resolveWindowStyle(value: unknown): WindowStyle {
  return isWindowStyle(value) ? value : DEFAULT_PREFERENCES.windowStyle;
}

/**
 * The contrast JetBrains states for its islands against their frame. Kept as a number; JetBrains'
 * own dark frame measures about 1.18:1 and is not copied (ADR 058).
 */
export const ISLAND_MIN_CONTRAST = 1.2;

export interface FrameColors {
  /** Behind the islands, and under the title bar and the status bar. */
  readonly frame: string;
  /** A hovered or pressed control on the frame. */
  readonly frameRaised: string;
  /**
   * The island's outline: `canvas`, its own colour, when the frame reached `ISLAND_MIN_CONTRAST`,
   * so there is no visible edge; `line` when the readability cap stopped the frame short of it, so a
   * theme that cannot separate the two surfaces by tone separates them by a rule.
   */
  readonly islandEdge: string;
}

/** 1% of the way to white or black per step, so the first step that clears a ratio is the closest. */
const MIX_STEPS = 100;

function colour(theme: Theme, token: "canvas" | "panel" | "hover" | "line" | "ink" | "ink-dim"): Rgb {
  return parseColor(theme.colors[token]);
}

/**
 * The first step from `start` toward `toward` that holds `ratio` against `against`, or the last step
 * the theme's text still reads on, whichever comes first. Each candidate is rounded to hex before
 * it is measured, so what is measured is exactly what is written.
 */
function stepAway(start: Rgb, against: Rgb, toward: Rgb, ratio: number, readable: (surface: Rgb) => boolean): Rgb {
  let reached = start;
  for (let step = 0; step <= MIX_STEPS; step += 1) {
    const candidate = parseColor(toHex(mix(start, toward, step / MIX_STEPS)));
    if (step > 0 && !readable(candidate)) return reached;
    reached = candidate;
    if (contrast(candidate, against) >= ratio) return candidate;
  }
  return reached;
}

/**
 * `panel`, stepped away from `canvas` — lighter on a dark theme, darker on a light one, as the ladder
 * already runs — until it holds `ISLAND_MIN_CONTRAST` against `canvas`. `frameRaised` steps on from
 * there until it sits as far from `frame` as `hover` sits from `panel`, or back toward `canvas` by
 * the same distance when going on would cost the text its floor. Neither steps past where
 * `ink` and `ink-dim` stop meeting the audit's floors: the title bar and the status bar are read on
 * the frame, and a frame nobody can read on is not a frame.
 */
export function frameColors(theme: Theme): FrameColors {
  const toward = theme.variant === "dark" ? WHITE : BLACK;
  const canvas = colour(theme, "canvas");
  const panel = colour(theme, "panel");
  const ink = colour(theme, "ink");
  const inkDim = colour(theme, "ink-dim");
  const readable = (surface: Rgb): boolean =>
    contrast(ink, surface) >= CONTRAST_TARGET.ink && contrast(inkDim, surface) >= CONTRAST_TARGET.inkDim;

  const frame = stepAway(panel, canvas, toward, ISLAND_MIN_CONTRAST, readable);
  const raisedStep = contrast(colour(theme, "hover"), panel);
  const away = stepAway(frame, frame, toward, raisedStep, readable);
  // The audit solves `ink-dim` to sit exactly on its floor against `hover`, and the frame usually
  // lands at about hover's luminance, so in most themes there is no readable step left beyond it.
  // A raised control then steps back toward the island instead: still `raisedStep` from the frame,
  // and in the direction in which text only gets easier to read.
  const frameRaised = contrast(away, frame) >= raisedStep ? away : stepAway(frame, frame, canvas, raisedStep, readable);
  const islandEdge = contrast(frame, canvas) >= ISLAND_MIN_CONTRAST ? theme.colors.canvas : theme.colors.line;
  return { frame: toHex(frame), frameRaised: toHex(frameRaised), islandEdge };
}

/**
 * What the native window paints before and behind the document: the frame under Islands, so a
 * resize that outruns the renderer shows frame rather than a band of another colour; `canvas`
 * otherwise, as it always was.
 */
export function windowBackground(theme: Theme, style: WindowStyle): string {
  return style === "islands" ? frameColors(theme).frame : theme.colors.canvas;
}

/*
 * The floating ladder (ADR 058). A dialog under Islands takes the island radius from the density
 * instead, so it never steps above the island; these are the three fixed rungs.
 */

/** A dialog under Classic: what `rounded-lg` drew before the ladder existed. */
export const CLASSIC_DIALOG_RADIUS_PX = 8;
/** A menu, a select popup or a completion list under Islands: a 4px row in a 4px inset nests in 8. */
export const ISLANDS_POPOVER_RADIUS_PX = 8;
/** The same under Classic: what `rounded-md` drew before the ladder existed. */
export const CLASSIC_POPOVER_RADIUS_PX = 6;
/** A tooltip, in both styles: `rounded-sm`. */
export const TOOLTIP_RADIUS_PX = 4;

/** The drop shadows of what floats over the window, by how far it floats. */
export interface ElevationShadows {
  /** Menus, select popups, completion lists, tooltips. */
  readonly popover: string;
  /** Dialogs and the palette. */
  readonly dialog: string;
}

/**
 * Keyed by the theme's variant and not by the window style: the reason for them is a dark canvas, on
 * which Tailwind's black-tinted `shadow-lg` barely shows, not the islands. A soft ambient shadow
 * paired with a tight contact one, so the edge still reads where a surface meets a darker island.
 */
export const ELEVATION: Readonly<Record<Variant, ElevationShadows>> = {
  light: {
    popover: "0 4px 16px -2px rgb(0 0 0 / 0.16), 0 1px 4px rgb(0 0 0 / 0.08)",
    dialog: "0 24px 48px -12px rgb(0 0 0 / 0.3), 0 2px 8px rgb(0 0 0 / 0.08)",
  },
  dark: {
    popover: "0 6px 20px -2px rgb(0 0 0 / 0.5), 0 1px 4px rgb(0 0 0 / 0.4)",
    dialog: "0 24px 64px -12px rgb(0 0 0 / 0.7), 0 2px 8px rgb(0 0 0 / 0.4)",
  },
};
