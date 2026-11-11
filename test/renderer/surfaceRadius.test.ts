/**
 * The floating ladder, held by scanning the renderer rather than by trusting review.
 *
 * ADR 058 gives every floating surface one of three rungs - dialog, popover, tooltip - each a
 * radius token and a shadow token that `apply.ts` writes per window style and per variant. The way
 * that rots is a new surface reaching for what Tailwind offers: `rounded-lg` is 8px whatever the
 * window style, and `shadow-lg shadow-black/40` is one black for every theme. Neither is wrong to
 * look at the day it lands, which is why it takes a test to notice.
 *
 * The scan is line by line over the renderer's TypeScript, comments included, because a class
 * string is a string and a comment naming the forbidden utility is the cheapest place to stop it
 * being copied.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CLASSIC_DIALOG_RADIUS_PX,
  CLASSIC_POPOVER_RADIUS_PX,
  TOOLTIP_RADIUS_PX,
} from "@preman/desktop/renderer/appearance/islands.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RENDERER = join(ROOT, "packages/desktop/src/renderer");
const APP_CSS = join(RENDERER, "app.css");
const SOURCE = /\.tsx?$/;

/**
 * Where a literal is the definition rather than a use. `appearance/` is the TypeScript that owns
 * the values `apply.ts` writes: `ELEVATION` spells its shadows in `rgb(0 0 0 / …)`, each generated
 * theme carries its own `shadowFloat`, and the comments there say what the tokens replaced. Banning
 * the words in the one directory that has to name them would only move the definitions somewhere
 * less obvious.
 */
const DEFINITIONS = new Set(["appearance"]);

const DIALOG_SHADOW = "shadow-dialog";
const DIALOG_RADIUS = "rounded-dialog";
/** 8px in both styles: under Islands a dialog follows the island, and this would not. */
const LITERAL_DIALOG_RADIUS = /\brounded-lg\b/;
/** Tailwind's scale and a hand-picked black: one shadow for every theme, in every window style. */
const LITERAL_SHADOW =
  /(?<![\w-])shadow-(?:2xs|xs|sm|md|lg|xl|2xl)(?![\w-])|shadow-black\/|shadow-\[|drop-shadow|rgb\(0 0 0/;

/** What `rounded-md`, `rounded-sm` and `rounded-lg` drew before the ladder: Classic must not move. */
const CLASSIC_RADII = {
  popover: { px: CLASSIC_POPOVER_RADIUS_PX, was: "--radius-md", expected: 6 },
  tooltip: { px: TOOLTIP_RADIUS_PX, was: "--radius-sm", expected: 4 },
  dialog: { px: CLASSIC_DIALOG_RADIUS_PX, was: "--radius-lg", expected: 8 },
} as const;

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return DEFINITIONS.has(relative(RENDERER, path)) ? [] : sources(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

function sourceLines(): { where: string; line: string }[] {
  return sources(RENDERER).flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .map((line, index) => ({ where: `${relative(RENDERER, path)}:${String(index + 1)}`, line })),
  );
}

function cssPixels(name: string): number {
  const match = new RegExp(`${name}:\\s*(\\d+)px;`).exec(readFileSync(APP_CSS, "utf8"));
  if (match?.[1] === undefined) throw new Error(`app.css declares no ${name}`);
  return Number(match[1]);
}

describe("floating surface radius tokens", () => {
  it("givenRendererSources_whenScanned_thenNoSurfaceHardCodesRoundedLg", () => {
    const offenders = sourceLines()
      .filter(({ line }) => LITERAL_DIALOG_RADIUS.test(line))
      .map(({ where }) => where);

    expect(offenders).toEqual([]);
  });

  it("givenRendererSources_whenScanned_thenNoSurfaceCastsALiteralShadow", () => {
    const offenders = sourceLines()
      .filter(({ line }) => LITERAL_SHADOW.test(line))
      .map(({ where }) => where);

    expect(offenders).toEqual([]);
  });

  it("givenRendererSources_whenScanned_thenEveryDialogShadowSurfaceIsRoundedDialog", () => {
    const surfaces = sourceLines().filter(({ line }) => line.includes(DIALOG_SHADOW));
    const offenders = surfaces.filter(({ line }) => !line.includes(DIALOG_RADIUS)).map(({ where }) => where);

    expect(surfaces.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it.each(Object.entries(CLASSIC_RADII))(
    "givenClassic_whenThe%sRungIsRead_thenItIsWhatTheOldClassDrew",
    (_rung, { px, was, expected }) => {
      expect(px).toBe(expected);
      expect(cssPixels(was)).toBe(expected);
    },
  );
});
