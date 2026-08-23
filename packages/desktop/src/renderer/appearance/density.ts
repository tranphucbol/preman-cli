/**
 * How tightly the interface packs, as three presets.
 *
 * A slider would be the obvious shape and the wrong one. Every number below is in proportion to
 * the others — a row is its control plus breathing room, a bar is its control plus a little more,
 * and the type has to still be centred in what is left. Multiplying all of them by 1.17 produces
 * fractional pixels on a HiDPI display and a half-pixel baseline on a 1x one, and there is no
 * multiplier that keeps 26 and 30 apart by an even number of pixels. Three sets of numbers that
 * someone looked at is worth more than a continuous range nobody has seen most of.
 *
 * TypeScript owns these rather than `app.css`, reversing the arrangement `--spacing-row` was
 * written under: six virtualizers need the row height as a number, and a token that CSS owns and
 * TypeScript copies is a token that gets copied wrong. See `docs/decisions/021`.
 */
import type { Density } from "@preman/desktop/preload/bridge.js";

/**
 * All eight values, in pixels. Nothing here is derived at rest — the derivations are stated as
 * comments and asserted in the tests, because a table you can read down is worth more than five
 * arithmetic expressions you have to evaluate.
 */
export interface DensityTokens {
  /** The sidebar's row, and the unit six virtualizers measure in. */
  row: number;
  control: number;
  controlLarge: number;
  /** A row of `control`-sized controls: `control + 6`. */
  tab: number;
  /** A row of `controlLarge`-sized ones, and the title bar: `controlLarge + 10`. */
  bar: number;
  text2xs: number;
  textXs: number;
  textSm: number;
}

/**
 * `default` is `app.css` as it shipped, to the pixel. That is not a coincidence to be tidied up
 * later: it is what makes turning this feature on a no-op for everyone who does not go looking.
 */
export const DENSITY: Readonly<Record<Density, DensityTokens>> = {
  compact: { row: 24, control: 24, controlLarge: 26, tab: 30, bar: 36, text2xs: 10.5, textXs: 11, textSm: 12.5 },
  default: { row: 28, control: 26, controlLarge: 30, tab: 32, bar: 40, text2xs: 11, textXs: 12, textSm: 13.5 },
  comfortable: { row: 32, control: 30, controlLarge: 34, tab: 36, bar: 44, text2xs: 12, textXs: 13, textSm: 14.5 },
};

export const DENSITIES = ["compact", "default", "comfortable"] as const;

/** What a hand-edited state file that names something else gets. */
export const DEFAULT_DENSITY: Density = "default";

export function densityTokens(density: Density): DensityTokens {
  return DENSITY[density] ?? DENSITY[DEFAULT_DENSITY];
}

/**
 * The palette's row, which is taller than the sidebar's because it carries two lines: a label and
 * the path under it. Derived rather than tabulated so it cannot be tuned for one preset only.
 */
const PALETTE_EXTRA_PX = 6;
export function paletteRowHeight(density: Density): number {
  return densityTokens(density).row + PALETTE_EXTRA_PX;
}

/** A search result: a label, its path, and the matching line under both. */
const SEARCH_EXTRA_PX = 16;
export function searchRowHeight(density: Density): number {
  return densityTokens(density).row + SEARCH_EXTRA_PX;
}
