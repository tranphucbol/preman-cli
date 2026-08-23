/**
 * The colour maths behind a theme, and the six properties every theme has to have.
 *
 * This module deliberately imports nothing. `generate-themes.ts` runs it to decide what to write,
 * and `test/renderer/themes.test.ts` runs the same code over what was written — so a hand edit to
 * a generated file fails `bun run test` rather than waiting for someone to remember the script.
 * A `node:*` import here would put the second of those two out of reach.
 *
 * The token names below are the *subject of the assertions*, not the theme's type. Exhaustiveness
 * over all 21 colours and 35 syntax colours is `tsc`'s job, against `renderer/appearance/theme.ts`.
 * What is named here is only the structure the six properties reason about: which surfaces an ink
 * tier has to clear, which colours form the luminance ladder, which six are the method column.
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
const CHANNEL_MAX = 255;
const OPAQUE = 1;
const LINEAR_KNEE = 0.04045;
const LINEAR_SLOPE = 12.92;
const LINEAR_OFFSET = 0.055;
const LINEAR_SCALE = 1.055;
const LINEAR_EXPONENT = 2.4;
const LUMINANCE_R = 0.2126;
const LUMINANCE_G = 0.7152;
const LUMINANCE_B = 0.0722;
/** WCAG's 0.05 flare term, which is why no ratio is ever 1:0. */
const FLARE = 0.05;
const SOLVER_STEPS = 40;
/** Enough digits that a near miss reads as a near miss in the violation text. */
const DISTANCE_DIGITS = 4;
const HALF = 2;

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

/**
 * The smallest contrast ratio between two adjacent surfaces. Below this, hovering a row does
 * nothing anybody can see. preman-dark's own smallest adjacent step is 1.064.
 */
export const SURFACE_MIN_STEP = 1.04;

/**
 * How far `selected` may sit from `hover` in luminance. `app.css` is explicit that selection is
 * "tinted toward the accent" rather than a lighter grey, and that rule is only checkable as a
 * luminance identity: preman-dark's pair measures 1.006.
 */
export const SELECTED_TOLERANCE = 1.15;

/**
 * How far apart two method colours have to be in OKLab. Calibrated to preman-dark, whose closest
 * pair is GET's green against gRPC's teal at 0.0847 — the sidebar shows all six within a few
 * hundred pixels of each other, and that pair is the one a reader actually has to separate.
 */
export const METHOD_MIN_DISTANCE = 0.08;

/**
 * `--syntax-template` is painted over whatever the JSON grammar made of a `{{token}}`, so it has to
 * be told apart from the three things a token is ever adjacent to: the string it may be written
 * inside, the number a bare one is masked to, and the key on the same line. Wider than the method
 * gap because these are neighbouring glyphs on one line rather than a column that is scanned, and
 * because the solver has a whole palette to find it in — four themes reused a colour identical to
 * `property` before this rule existed.
 */
export const TEMPLATE_MIN_DISTANCE = 0.1;
export const TEMPLATE_NEIGHBOURS = ["string", "number", "property"] as const;

/** The five surfaces every foreground tier is measured against. */
export const SURFACE_TOKENS = ["canvas", "panel", "control", "hover", "selected"] as const;

/** The four that form the luminance ladder, in order. `selected` is checked against `hover`. */
export const LADDER_TOKENS = ["canvas", "panel", "control", "hover"] as const;

export const METHOD_TOKENS = [
  "method-get",
  "method-post",
  "method-put",
  "method-patch",
  "method-delete",
  "method-grpc",
] as const;

/**
 * A theme, as much of one as the audit needs.
 *
 * Structural rather than an import of the renderer's `Theme`: `scripts/` is compiled into the Node
 * program and `renderer/` into the browser one. `Record<ColorToken, string>` satisfies this.
 */
export interface AuditableTheme {
  readonly id: string;
  readonly variant: "dark" | "light";
  readonly colors: Readonly<Record<string, string>>;
  readonly syntax: Readonly<Record<string, string>>;
}

function clampChannel(value: number): number {
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
  return { r: channel(0), g: channel(HEX_PAIR), b: channel(HEX_PAIR * HALF), a: alpha };
}

export function toHex(colour: Rgb): string {
  const pair = (value: number): string => clampChannel(value).toString(HEX_RADIX).padStart(HEX_PAIR, "0");
  return `${HEX_PREFIX}${pair(colour.r)}${pair(colour.g)}${pair(colour.b)}`;
}

/** An overlay over an opaque base, which is what preman's solid `hover` and `selected` are. */
export function flatten(overlay: Rgba, base: Rgb): Rgb {
  return {
    r: overlay.r * overlay.a + base.r * (OPAQUE - overlay.a),
    g: overlay.g * overlay.a + base.g * (OPAQUE - overlay.a),
    b: overlay.b * overlay.a + base.b * (OPAQUE - overlay.a),
  };
}

function toLinear(channel: number): number {
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

/**
 * Move a colour until it has the luminance asked for, by mixing it toward black or white.
 *
 * Mixing rather than scaling the channels: scaling drags a colour toward its dominant primary and
 * turns a grey-blue surface into a blue one three steps up the ladder.
 */
export function toLuminance(colour: Rgb, target: number): Rgb {
  const current = luminance(colour);
  const anchor = target > current ? WHITE : BLACK;
  let low = 0;
  let high = OPAQUE;
  for (let step = 0; step < SOLVER_STEPS; step += 1) {
    const middle = (low + high) / HALF;
    const candidate = luminance(mix(colour, anchor, middle));
    const overshot = anchor === WHITE ? candidate > target : candidate < target;
    if (overshot) high = middle;
    else low = middle;
  }
  return mix(colour, anchor, (low + high) / HALF);
}

const OKLAB_M1 = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
] as const;
const OKLAB_M2 = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
] as const;
const FIRST = 0;
const SECOND = 1;
const THIRD = 2;

/**
 * OKLab, for the one question WCAG contrast cannot answer: are these two colours *different*.
 * A green and a teal at the same luminance have a contrast ratio of 1 against each other and are
 * still two colours a reader can tell apart, which is exactly the method column's problem.
 */
export function oklab(colour: Rgb): readonly [number, number, number] {
  const linear = [toLinear(colour.r), toLinear(colour.g), toLinear(colour.b)] as const;
  const cone = OKLAB_M1.map((row) =>
    Math.cbrt(
      (row[FIRST] ?? 0) * linear[FIRST] + (row[SECOND] ?? 0) * linear[SECOND] + (row[THIRD] ?? 0) * linear[THIRD],
    ),
  );
  const project = (row: readonly number[]): number =>
    (row[FIRST] ?? 0) * (cone[FIRST] ?? 0) +
    (row[SECOND] ?? 0) * (cone[SECOND] ?? 0) +
    (row[THIRD] ?? 0) * (cone[THIRD] ?? 0);
  return [project(OKLAB_M2[FIRST]), project(OKLAB_M2[SECOND]), project(OKLAB_M2[THIRD])];
}

const OKLAB_INVERSE_CONE = [
  [OPAQUE, 0.3963377774, 0.2158037573],
  [OPAQUE, -0.1055613458, -0.0638541728],
  [OPAQUE, -0.0894841775, -1.291485548],
] as const;
const OKLAB_INVERSE_LINEAR = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
] as const;
const CUBE = 3;

function fromLinear(channel: number): number {
  const encoded =
    channel <= LINEAR_KNEE / LINEAR_SLOPE
      ? channel * LINEAR_SLOPE
      : LINEAR_SCALE * Math.pow(channel, OPAQUE / LINEAR_EXPONENT) - LINEAR_OFFSET;
  return clampChannel(encoded * CHANNEL_MAX);
}

/** The inverse of {@link oklab}, clamped back into the eight-bit cube. */
export function fromOklab(lab: readonly [number, number, number]): Rgb {
  const cone = OKLAB_INVERSE_CONE.map((row) =>
    Math.pow((row[FIRST] ?? 0) * lab[FIRST] + (row[SECOND] ?? 0) * lab[SECOND] + (row[THIRD] ?? 0) * lab[THIRD], CUBE),
  );
  const project = (row: readonly number[]): number =>
    (row[FIRST] ?? 0) * (cone[FIRST] ?? 0) +
    (row[SECOND] ?? 0) * (cone[SECOND] ?? 0) +
    (row[THIRD] ?? 0) * (cone[THIRD] ?? 0);
  return {
    r: fromLinear(project(OKLAB_INVERSE_LINEAR[FIRST])),
    g: fromLinear(project(OKLAB_INVERSE_LINEAR[SECOND])),
    b: fromLinear(project(OKLAB_INVERSE_LINEAR[THIRD])),
  };
}

/** Polar OKLab: lightness, chroma, and a hue in radians. */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

export function oklch(colour: Rgb): Oklch {
  const [l, a, b] = oklab(colour);
  return { l, c: Math.hypot(a, b), h: Math.atan2(b, a) };
}

export function fromOklch(polar: Oklch): Rgb {
  return fromOklab([polar.l, polar.c * Math.cos(polar.h), polar.c * Math.sin(polar.h)]);
}

export function perceptualDistance(a: Rgb, b: Rgb): number {
  const first = oklab(a);
  const second = oklab(b);
  return Math.hypot(first[FIRST] - second[FIRST], first[SECOND] - second[SECOND], first[THIRD] - second[THIRD]);
}

/**
 * Fade `ink` toward `canvas` until it sits exactly on `target` against the worst of `surfaces`.
 *
 * This is the point of the whole approach: the three quiet tiers are not read out of a palette and
 * hoped about, they are solved so that the contract in `app.css` holds for every palette rather
 * than describing the one it was written against. Monotonic by construction — every step toward
 * the canvas lowers the ratio against all five — so a bisection is exact.
 */
export function fadeToTarget(ink: Rgb, canvas: Rgb, surfaces: readonly Rgb[], target: number): Rgb {
  const worst = (colour: Rgb): number => Math.min(...surfaces.map((surface) => contrast(colour, surface)));
  if (worst(ink) < target) return ink;
  let low = 0;
  let high = OPAQUE;
  for (let step = 0; step < SOLVER_STEPS; step += 1) {
    const middle = (low + high) / HALF;
    if (worst(mix(ink, canvas, middle)) >= target) low = middle;
    else high = middle;
  }
  return mix(ink, canvas, low);
}

/** The luminance a colour needs so that it clears `ratio` against one at `from`, on `side`. */
export function stepLuminance(from: number, ratio: number, side: "lighter" | "darker"): number {
  return side === "lighter" ? ratio * (from + FLARE) - FLARE : (from + FLARE) / ratio - FLARE;
}

function ratio(value: number): string {
  return `${value.toFixed(HEX_PAIR)}:1`;
}

/**
 * The six properties, as a list of what is wrong.
 *
 * A list rather than a throw so that one run reports every failure in every theme: fixing palettes
 * one exception at a time is how a generator run becomes an afternoon.
 */
export function auditTheme(theme: AuditableTheme): string[] {
  const violations: string[] = [];
  const colour = (token: string): Rgb => {
    const value = theme.colors[token];
    if (value === undefined) throw new Error(`${theme.id} has no --color-${token}`);
    return parseColor(value);
  };
  const surfaces = SURFACE_TOKENS.map(colour);
  const lighter = theme.variant === "dark";

  // 1 and 2. The four foreground tiers, each against all five surfaces. The solver makes these
  // pass by construction; they are asserted anyway, because a hand edit is not the solver.
  const tiers = [
    ["ink", CONTRAST_TARGET.ink],
    ["ink-dim", CONTRAST_TARGET.inkDim],
    ["ink-faint", CONTRAST_TARGET.inkFaint],
    ["glyph", CONTRAST_TARGET.glyph],
  ] as const;
  for (const [token, target] of tiers) {
    for (const [index, surface] of surfaces.entries()) {
      const measured = contrast(colour(token), surface);
      if (measured < target) {
        violations.push(`${token} is ${ratio(measured)} on ${SURFACE_TOKENS[index] ?? "?"}, below ${ratio(target)}`);
      }
    }
  }

  // 3. The ladder. Strictly monotonic away from the ink, with a step big enough to see.
  for (let index = 1; index < LADDER_TOKENS.length; index += 1) {
    const previous = colour(LADDER_TOKENS[index - 1] ?? "canvas");
    const current = colour(LADDER_TOKENS[index] ?? "canvas");
    const rose = luminance(current) > luminance(previous);
    if (rose !== lighter) {
      violations.push(`${LADDER_TOKENS[index] ?? "?"} does not continue the ladder away from the ink`);
    } else if (contrast(previous, current) < SURFACE_MIN_STEP) {
      violations.push(
        `${LADDER_TOKENS[index] ?? "?"} is ${ratio(contrast(previous, current))} from ${LADDER_TOKENS[index - 1] ?? "?"}, below ${ratio(SURFACE_MIN_STEP)}`,
      );
    }
  }

  // 4. Tinted, not lighter.
  const selectedStep = contrast(colour("selected"), colour("hover"));
  if (selectedStep > SELECTED_TOLERANCE) {
    violations.push(`selected is ${ratio(selectedStep)} from hover, so it is a lighter grey rather than a tint`);
  }

  // 5. The method column: readable on both surfaces it appears on, and six colours not five.
  for (const token of METHOD_TOKENS) {
    for (const surface of ["canvas", "panel"] as const) {
      const measured = contrast(colour(token), colour(surface));
      if (measured < CONTRAST_TARGET.method) {
        violations.push(`${token} is ${ratio(measured)} on ${surface}, below ${ratio(CONTRAST_TARGET.method)}`);
      }
    }
  }
  for (let first = 0; first < METHOD_TOKENS.length; first += 1) {
    for (let second = first + 1; second < METHOD_TOKENS.length; second += 1) {
      const left = METHOD_TOKENS[first] ?? "method-get";
      const right = METHOD_TOKENS[second] ?? "method-get";
      const distance = perceptualDistance(colour(left), colour(right));
      if (distance < METHOD_MIN_DISTANCE) {
        violations.push(`${left} and ${right} are ${distance.toFixed(DISTANCE_DIGITS)} apart in OKLab`);
      }
    }
  }

  // 6. The accent, as the fill it always is.
  for (const surface of ["canvas", "panel"] as const) {
    const measured = contrast(colour("accent"), colour(surface));
    if (measured < CONTRAST_TARGET.accentFill) {
      violations.push(`accent is ${ratio(measured)} on ${surface}, below ${ratio(CONTRAST_TARGET.accentFill)}`);
    }
  }
  const onAccent = contrast(colour("canvas"), colour("accent"));
  if (onAccent < CONTRAST_TARGET.accentForeground) {
    violations.push(`canvas is ${ratio(onAccent)} on accent, below ${ratio(CONTRAST_TARGET.accentForeground)}`);
  }

  // 7. The interpolation colour, against the three tokens it is read beside.
  const template = theme.syntax.template;
  if (template === undefined) {
    violations.push("no --syntax-template");
  } else {
    for (const neighbour of TEMPLATE_NEIGHBOURS) {
      const other = theme.syntax[neighbour];
      if (other === undefined) {
        violations.push(`no --syntax-${neighbour} to separate template from`);
        continue;
      }
      const distance = perceptualDistance(parseColor(template), parseColor(other));
      if (distance < TEMPLATE_MIN_DISTANCE) {
        violations.push(`template and ${neighbour} are ${distance.toFixed(DISTANCE_DIGITS)} apart in OKLab`);
      }
    }
  }

  // The editor's own colours are text like any other text, and the editor is transparent: it sits
  // on `panel` inside a pane and on `canvas` in the response viewer. Stock CodeMirror shipped a
  // light-background highlight style over a near-black canvas for a whole release, which is what
  // this line is here to stop happening again.
  for (const [token, value] of Object.entries(theme.syntax)) {
    for (const surface of ["canvas", "panel"] as const) {
      const measured = contrast(parseColor(value), colour(surface));
      if (measured < CONTRAST_TARGET.method) {
        violations.push(`syntax-${token} is ${ratio(measured)} on ${surface}, below ${ratio(CONTRAST_TARGET.method)}`);
      }
    }
  }

  return violations;
}
