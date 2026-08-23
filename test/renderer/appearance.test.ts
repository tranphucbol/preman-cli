/**
 * The density table and the one module that writes custom properties.
 *
 * The presets are the interesting half. Their comments claim two derivations — a tab is a control
 * plus six, a bar is a large control plus ten — and a table you can read down is exactly the kind
 * of thing that gets a row edited without its neighbours. So the derivations are asserted, and
 * `default` is asserted to still be the numbers `app.css` shipped with, because that equality is
 * what makes turning this feature on invisible to everyone who does not go looking for it.
 *
 * `apply.ts` is tested through a stand-in root rather than jsdom: the suite runs under
 * `environment: "node"` and the module only ever touches `element.style`, so a recording stub
 * proves more about the contract than a DOM would.
 */
import { describe, expect, it } from "vitest";

import { applyDensity, applyFonts, applyPreferences, applyTheme } from "@preman/desktop/renderer/appearance/apply.js";
import {
  DENSITIES,
  DENSITY,
  densityTokens,
  paletteRowHeight,
  searchRowHeight,
} from "@preman/desktop/renderer/appearance/density.js";
import { FONT_VARIABLES, sanitiseFamily, userFontValue } from "@preman/desktop/renderer/appearance/fonts.js";
import { COLOR_TOKENS, SYNTAX_TOKENS } from "@preman/desktop/renderer/appearance/theme.js";
import { THEMES } from "@preman/desktop/renderer/appearance/themes/index.js";
import { HIGHLIGHT_STYLE } from "@preman/desktop/renderer/ui/highlight.js";
import { DEFAULT_PREFERENCES, type Preferences } from "@preman/desktop/preload/bridge.js";

/** The two derivations stated in `density.ts`. */
const TAB_OVER_CONTROL = 6;
const BAR_OVER_CONTROL_LARGE = 10;
const PALETTE_OVER_ROW = 6;
const SEARCH_OVER_ROW = 16;

/** What `app.css` declares, and therefore what `default` has to keep saying. */
const SHIPPED = { row: 28, control: 26, controlLarge: 30, tab: 32, bar: 40, text2xs: 11, textXs: 12, textSm: 13.5 };

const DENSITY_PROPERTY_COUNT = Object.keys(SHIPPED).length;
/** Every colour, every syntax colour, `--shadow-float`, and `color-scheme`. */
const THEME_PROPERTY_COUNT = COLOR_TOKENS.length + SYNTAX_TOKENS.length + 2;

/**
 * Only the surface `apply.ts` uses. Removal is recorded as an absence rather than a null so a test
 * can tell "never written" from "written and then cleared" — which is the whole point of the
 * `var()` fallback path.
 */
function recordingRoot(): { readonly written: Map<string, string>; readonly element: HTMLElement } {
  const written = new Map<string, string>();
  const style = {
    setProperty(name: string, value: string): void {
      written.set(name, value);
    },
    removeProperty(name: string): void {
      written.delete(name);
    },
  };
  return { written, element: { style } as unknown as HTMLElement };
}

function preferences(overrides: Partial<Preferences> = {}): Preferences {
  return { ...DEFAULT_PREFERENCES, ...overrides };
}

describe("density presets", () => {
  it("givenTheDefaultPreset_whenRead_thenItIsTheStylesheetsOwnNumbers", () => {
    expect(DENSITY.default).toStrictEqual(SHIPPED);
  });

  it.each(DENSITIES)("given%sDensity_whenRead_thenTheRowsAreDerivedFromTheirControls", (density) => {
    const tokens = DENSITY[density];
    expect(tokens.tab).toBe(tokens.control + TAB_OVER_CONTROL);
    expect(tokens.bar).toBe(tokens.controlLarge + BAR_OVER_CONTROL_LARGE);
  });

  it("givenTheThreePresets_whenOrdered_thenEveryNumberGrows", () => {
    const keys = Object.keys(SHIPPED) as (keyof typeof SHIPPED)[];
    for (const key of keys) {
      expect(DENSITY.compact[key]).toBeLessThanOrEqual(DENSITY.default[key]);
      expect(DENSITY.default[key]).toBeLessThanOrEqual(DENSITY.comfortable[key]);
    }
    // Not every value has to move, but the row that six virtualizers measure in does.
    expect(DENSITY.compact.row).toBeLessThan(DENSITY.comfortable.row);
  });

  it("givenAnUnknownDensity_whenResolved_thenTheDefaultPresetIsUsed", () => {
    // A hand-edited state file is the source of this string, so it is not a programmer error.
    expect(densityTokens("cosy" as never)).toStrictEqual(DENSITY.default);
  });

  it.each(DENSITIES)("given%sDensity_whenTheTallerRowsAreDerived_thenTheyTrackTheRow", (density) => {
    expect(paletteRowHeight(density)).toBe(DENSITY[density].row + PALETTE_OVER_ROW);
    expect(searchRowHeight(density)).toBe(DENSITY[density].row + SEARCH_OVER_ROW);
  });
});

describe("syntax highlighting", () => {
  /**
   * The token list and the tag mapping are two files that have to agree, and nothing else would
   * notice if they stopped: an unmapped token is a colour every theme carries and no editor shows,
   * and a mistyped property is a rule the browser drops in silence.
   */
  it("givenTheHighlightStyle_whenRead_thenEverySyntaxTokenIsMappedToATagAndNothingElseIs", () => {
    const used = new Set<string>();
    for (const spec of HIGHLIGHT_STYLE.specs) {
      const colour = (spec as { readonly color?: string }).color;
      if (colour !== undefined) used.add(colour);
    }

    // `template` is the one token with no Lezer tag behind it: `{{name}}` is not a language
    // construct, so `ui/template.ts` paints it with a decoration instead. Every other token is a tag.
    const tagged = SYNTAX_TOKENS.filter((token) => token !== "template");
    expect([...used].sort()).toStrictEqual(tagged.map((token) => `var(--syntax-${token})`).sort());
  });
});

describe("applying preferences", () => {
  it("givenADensity_whenApplied_thenEveryTokenIsWrittenInPixels", () => {
    const { written, element } = recordingRoot();
    applyDensity(DENSITY.compact, element);

    expect(written.size).toBe(DENSITY_PROPERTY_COUNT);
    expect(written.get("--spacing-row")).toBe("24px");
    expect(written.get("--spacing-control-lg")).toBe("26px");
    expect(written.get("--text-2xs")).toBe("10.5px");
  });

  it("givenATheme_whenApplied_thenEveryColourAndTheColourSchemeAreWritten", () => {
    const theme = THEMES[0];
    if (theme === undefined) throw new Error("no themes are bundled");
    const { written, element } = recordingRoot();
    applyTheme(theme, element);

    expect(written.size).toBe(THEME_PROPERTY_COUNT);
    expect(written.get("--color-canvas")).toBe(theme.colors.canvas);
    expect(written.get("--syntax-keyword")).toBe(theme.syntax.keyword);
    expect(written.get("--shadow-float")).toBe(theme.shadowFloat);
    expect(written.get("color-scheme")).toBe(theme.variant);
  });

  it("givenALightTheme_whenApplied_thenTheColourSchemeSaysSo", () => {
    const light = THEMES.find((candidate) => candidate.variant === "light");
    if (light === undefined) throw new Error("no light theme is bundled");
    const { written, element } = recordingRoot();
    applyTheme(light, element);

    expect(written.get("color-scheme")).toBe("light");
  });

  it("givenNoFontChoice_whenApplied_thenTheSlotIsLeftUnsetSoTheShippedStackResolves", () => {
    const { written, element } = recordingRoot();
    applyFonts(preferences(), element);

    expect(written.has(FONT_VARIABLES.mono)).toBe(false);
    expect(written.has(FONT_VARIABLES.sans)).toBe(false);
    expect(written.get("--editor-font-size")).toBe("12px");
  });

  it("givenAChosenFamily_whenApplied_thenItIsQuotedIntoTheSlot", () => {
    const { written, element } = recordingRoot();
    applyFonts(preferences({ fontMono: "Iosevka", editorFontSize: 15 }), element);

    expect(written.get(FONT_VARIABLES.mono)).toBe('"Iosevka"');
    expect(written.get("--editor-font-size")).toBe("15px");
  });

  it("givenAFamilyThatWouldEscapeTheDeclaration_whenSanitised_thenTheDangerousCharactersAreGone", () => {
    expect(sanitiseFamily('Ios";} body{display:none')).toBe("Ios bodydisplay:none");
    expect(userFontValue("  ")).toBeNull();
    expect(userFontValue(null)).toBeNull();
  });

  it("givenEverything_whenAppliedTogether_thenTheThemeDensityAndFontsAllLand", () => {
    const theme = THEMES[0];
    if (theme === undefined) throw new Error("no themes are bundled");
    const { written, element } = recordingRoot();
    applyPreferences(theme, preferences({ density: "comfortable", fontSans: "Inter" }), element);

    expect(written.get("--color-canvas")).toBe(theme.colors.canvas);
    expect(written.get("--spacing-bar")).toBe("44px");
    expect(written.get(FONT_VARIABLES.sans)).toBe('"Inter"');
  });
});
