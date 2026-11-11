/**
 * WCAG contrast, and the floors every theme is held to.
 *
 * Moved here from `scripts/audit.ts` when the renderer started needing it at run time: the islands
 * frame (`islands.ts`) is derived by stepping a colour until it clears these numbers, so the same
 * arithmetic that audits a theme at build time now decides a colour at launch. The renderer may not
 * reach into `scripts/`, and the audit may import a pure module, so the maths lives on this side of
 * the fence and `audit.ts` re-exports it — one copy, read by both.
 *
 * Imports nothing, and must keep importing nothing: `generate-themes.ts` runs it under Bun, the
 * renderer bundles it for a browser, and the root program type-checks it without the DOM.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Rgba extends Rgb {
  /** 0 to 1. Eight-digit source hex is the only thing that produces anything but 1. */
  readonly a: number;
}

const HEX_PREFIX = "#";
const SHORT_HEX_LENGTH = 3;
const HEX_LENGTH = 6;
const HEX_WITH_ALPHA_LENGTH = 8;
const HEX_RADIX = 16;
const HEX_PAIR = 2;
const BLUE_OFFSET = 4;
export const CHANNEL_MAX = 255;
export const OPAQUE = 1;
export const LINEAR_KNEE = 0.04045;
export const LINEAR_SLOPE = 12.92;
export const LINEAR_OFFSET = 0.055;
export const LINEAR_SCALE = 1.055;
export const LINEAR_EXPONENT = 2.4;
const LUMINANCE_R = 0.2126;
const LUMINANCE_G = 0.7152;
const LUMINANCE_B = 0.0722;
/** WCAG's 0.05 flare term, which is why no ratio is ever 1:0. */
export const FLARE = 0.05;

export const BLACK: Rgb = { r: 0, g: 0, b: 0 };
export const WHITE: Rgb = { r: CHANNEL_MAX, g: CHANNEL_MAX, b: CHANNEL_MAX };

/**
 * The contrast contract, as numbers rather than as a comment.
 *
 * These are `app.css`'s own tiers read back as targets. The faint tier is 4.6 and not the 4.7 the
 * stylesheet rounds to: preman-dark's `--color-ink-faint` measures 4.671 against `--color-hover`,
 * and a floor above the palette it was derived from is a floor that fails its own reference.
 */
export const CONTRAST_TARGET = {
  ink: 10.8,
  inkDim: 6.7,
  inkFaint: 4.6,
  /** WCAG 1.4.11: a non-text control's only affordance. Never used for text. */
  glyph: 3.3,
  /** AA for the method column, which is 11px monospace on two different surfaces. */
  method: 4.5,
  /** An accent fill is a large solid area, so 1.4.11 rather than 1.4.3. */
  accentFill: 3,
  /** What sits on top of that fill. */
  accentForeground: 4.5,
} as const;

export function clampChannel(value: number): number {
  return Math.min(CHANNEL_MAX, Math.max(0, Math.round(value)));
}

/**
 * `#rgb`, `#rrggbb` and `#rrggbbaa`. The last is what openchamber writes for its overlay colours,
 * and reading the alpha rather than discarding it is what makes `flatten` possible.
 */
export function parseColor(value: string): Rgba {
  const body = value.startsWith(HEX_PREFIX) ? value.slice(HEX_PREFIX.length) : value;
  const expanded =
    body.length === SHORT_HEX_LENGTH ? [...body].map((character) => `${character}${character}`).join("") : body;
  if (expanded.length !== HEX_LENGTH && expanded.length !== HEX_WITH_ALPHA_LENGTH) {
    throw new Error(`not a hex colour: ${value}`);
  }
  const channel = (index: number): number => parseInt(expanded.slice(index, index + HEX_PAIR), HEX_RADIX);
  const alpha = expanded.length === HEX_WITH_ALPHA_LENGTH ? channel(HEX_LENGTH) / CHANNEL_MAX : OPAQUE;
  return { r: channel(0), g: channel(HEX_PAIR), b: channel(BLUE_OFFSET), a: alpha };
}

export function toHex(colour: Rgb): string {
  const pair = (value: number): string => clampChannel(value).toString(HEX_RADIX).padStart(HEX_PAIR, "0");
  return `${HEX_PREFIX}${pair(colour.r)}${pair(colour.g)}${pair(colour.b)}`;
}

export function toLinear(channel: number): number {
  const scaled = channel / CHANNEL_MAX;
  return scaled <= LINEAR_KNEE
    ? scaled / LINEAR_SLOPE
    : Math.pow((scaled + LINEAR_OFFSET) / LINEAR_SCALE, LINEAR_EXPONENT);
}

export function luminance(colour: Rgb): number {
  return LUMINANCE_R * toLinear(colour.r) + LUMINANCE_G * toLinear(colour.g) + LUMINANCE_B * toLinear(colour.b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + FLARE) / (Math.min(first, second) + FLARE);
}

export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
  };
}
