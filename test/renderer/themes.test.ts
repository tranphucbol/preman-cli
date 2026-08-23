/**
 * The contrast contract, asserted rather than described.
 *
 * `app.css` used to state its ratios in a comment, which is true of exactly one palette and
 * unverifiable for any other. Now that a theme is data, the same sentences are a table-driven test
 * over every bundled theme: the generator is not trusted, its output is measured. A palette that
 * arrives with an unreadable comment colour fails here, in a diff, and not in a user's editor.
 *
 * What is deliberately not tested is whether a theme looks *good*. That is taste, and a test that
 * claimed to measure it would only be measuring whoever wrote it.
 */
import { describe, expect, it } from "vitest";

import { COLOR_TOKENS, SYNTAX_TOKENS, type Theme } from "@preman/desktop/renderer/appearance/theme.js";
import { THEMES } from "@preman/desktop/renderer/appearance/themes/index.js";
import {
  CONTRAST_TARGET,
  LADDER_TOKENS,
  METHOD_MIN_DISTANCE,
  METHOD_TOKENS,
  SURFACE_TOKENS,
  TEMPLATE_MIN_DISTANCE,
  TEMPLATE_NEIGHBOURS,
  auditTheme,
  contrast,
  parseColor,
  perceptualDistance,
} from "../../packages/desktop/scripts/audit.js";

const DEFAULT_THEME = "preman-dark";
/** Enough palettes that a regression in the generator is visible; the exact count is not the point. */
const MINIMUM_THEMES = 40;

function colour(theme: Theme, token: string): ReturnType<typeof parseColor> {
  return parseColor(theme.colors[token as (typeof COLOR_TOKENS)[number]]);
}

describe("bundled themes", () => {
  it("givenTheBundledThemes_whenListed_thenPremanDarkIsFirstAndIdsAreUnique", () => {
    expect(THEMES[0]?.id).toBe(DEFAULT_THEME);
    expect(THEMES.length).toBeGreaterThanOrEqual(MINIMUM_THEMES);
    expect(new Set(THEMES.map((theme) => theme.id)).size).toBe(THEMES.length);
  });

  it.each(THEMES.map((theme) => [theme.id, theme] as const))(
    "givenTheme_%s_whenAudited_thenNothingIsFlagged",
    (_id, theme) => {
      expect(auditTheme(theme)).toEqual([]);
    },
  );

  it.each(THEMES.map((theme) => [theme.id, theme] as const))(
    "givenTheme_%s_whenRead_thenEveryTokenIsPresentAndParses",
    (_id, theme) => {
      for (const token of COLOR_TOKENS) expect(() => parseColor(theme.colors[token])).not.toThrow();
      for (const token of SYNTAX_TOKENS) expect(() => parseColor(theme.syntax[token])).not.toThrow();
      expect(theme.shadowFloat).toMatch(/^\d/);
    },
  );

  it.each(THEMES.map((theme) => [theme.id, theme] as const))(
    "givenTheme_%s_whenInkIsMeasured_thenItClearsTheTargetOnEverySurface",
    (_id, theme) => {
      const ink = colour(theme, "ink");
      for (const surface of SURFACE_TOKENS) {
        expect(contrast(ink, colour(theme, surface))).toBeGreaterThanOrEqual(CONTRAST_TARGET.ink);
      }
    },
  );

  it.each(THEMES.map((theme) => [theme.id, theme] as const))(
    "givenTheme_%s_whenTheDimmerTiersAreMeasured_thenEachClearsItsOwnTarget",
    (_id, theme) => {
      const tiers = [
        ["ink-dim", CONTRAST_TARGET.inkDim],
        ["ink-faint", CONTRAST_TARGET.inkFaint],
        ["glyph", CONTRAST_TARGET.glyph],
      ] as const;
      for (const [token, target] of tiers) {
        for (const surface of SURFACE_TOKENS) {
          expect(contrast(colour(theme, token), colour(theme, surface))).toBeGreaterThanOrEqual(target);
        }
      }
    },
  );

  it.each(THEMES.map((theme) => [theme.id, theme] as const))(
    "givenTheme_%s_whenHoverIsCompared_thenItIsDistinguishableFromPanel",
    (_id, theme) => {
      // Every rung of the ladder has to be visibly apart from the one below it, or a hovered row
      // and a resting row are the same row.
      const steps = LADDER_TOKENS.map((token) => colour(theme, token));
      for (const [index, step] of steps.entries()) {
        if (index === 0) continue;
        expect(contrast(step, steps[index - 1] ?? step)).toBeGreaterThan(1);
      }
    },
  );

  it.each(THEMES.map((theme) => [theme.id, theme] as const))(
    "givenTheme_%s_whenTheMethodColoursAreCompared_thenNoTwoVerbsLookAlike",
    (_id, theme) => {
      const verbs = METHOD_TOKENS.map((token) => colour(theme, token));
      for (const [index, verb] of verbs.entries()) {
        for (const other of verbs.slice(index + 1)) {
          expect(perceptualDistance(verb, other)).toBeGreaterThanOrEqual(METHOD_MIN_DISTANCE);
        }
      }
    },
  );

  /**
   * The template token is the only syntax colour with fixed neighbours it did not choose: a
   * `{{token}}` sits exactly where a string or a number would, with a `property` key beside it. So
   * unlike the verbs, which only have to differ from each other, this one is measured against three
   * colours the palette already spent. Four vendored palettes made this test fail on its first run.
   */
  it.each(THEMES.map((theme) => [theme.id, theme] as const))(
    "givenTheme_%s_whenTheTemplateColourIsCompared_thenItIsNotMistakenForItsNeighbours",
    (_id, theme) => {
      const template = parseColor(theme.syntax.template);
      for (const neighbour of TEMPLATE_NEIGHBOURS) {
        expect(perceptualDistance(template, parseColor(theme.syntax[neighbour]))).toBeGreaterThanOrEqual(
          TEMPLATE_MIN_DISTANCE,
        );
      }
    },
  );

  it.each(THEMES.map((theme) => [theme.id, theme] as const))(
    "givenTheme_%s_whenSyntaxIsMeasured_thenEveryTokenIsReadableOnCanvasAndPanel",
    (_id, theme) => {
      const canvas = colour(theme, "canvas");
      const panel = colour(theme, "panel");
      for (const token of SYNTAX_TOKENS) {
        const value = parseColor(theme.syntax[token]);
        expect(Math.min(contrast(value, canvas), contrast(value, panel))).toBeGreaterThanOrEqual(
          CONTRAST_TARGET.method,
        );
      }
    },
  );
});
