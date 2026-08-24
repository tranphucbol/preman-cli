/**
 * The one place custom properties are written.
 *
 * Everything else in the renderer reads tokens through Tailwind utilities and never learns that a
 * theme exists. That is deliberate and it is the whole reason a theme can be data: a component
 * that asked `useTheme()` for a hex value would be a component that has to be found and changed
 * the next time a token moves.
 *
 * Written to `documentElement.style`, so the values land as an inline style on `:root` and win
 * over the `@theme` block in `app.css` by specificity alone. The stylesheet keeps its literals and
 * they keep doing their job — they are what the document looks like in the frame before the first
 * script runs, and what it looks like in a browser opened straight at the built HTML.
 */
import { densityTokens, type DensityTokens } from "@preman/desktop/renderer/appearance/density.js";
import { FONT_VARIABLES, userFontValue } from "@preman/desktop/renderer/appearance/fonts.js";
import { COLOR_TOKENS, SYNTAX_TOKENS, type Theme } from "@preman/desktop/renderer/appearance/theme.js";
import type { Preferences } from "@preman/desktop/preload/bridge.js";

const PX = "px";

/**
 * Which custom property each density number is. Spelled out rather than derived from the key,
 * because `controlLarge` is `--spacing-control-lg` and a camel-to-kebab rule would call it
 * `--spacing-control-large`; one exception is not worth a transformation nobody can predict.
 */
const DENSITY_VARIABLES: Readonly<Record<keyof DensityTokens, string>> = {
  row: "--spacing-row",
  control: "--spacing-control",
  controlLarge: "--spacing-control-lg",
  tab: "--spacing-tab",
  bar: "--spacing-bar",
  text2xs: "--text-2xs",
  textXs: "--text-xs",
  textSm: "--text-sm",
};

/** The editor's own size, the only type size not decided by the density. */
const EDITOR_FONT_SIZE_VARIABLE = "--editor-font-size";

/**
 * `color-scheme` is what makes the platform's own widgets agree with the theme: scrollbars, the
 * caret, a `<select>`'s popup, and the form controls this app has not styled. It is a CSS property
 * rather than a custom property, and it is the only reason `Theme` carries `variant` at all.
 */
const COLOR_SCHEME = "color-scheme";

/** The attribute `app.css` hangs `transition: none !important` on, for exactly one frame. */
const RETHEME_ATTRIBUTE = "data-retheme";

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  const style = root.style;
  for (const token of COLOR_TOKENS) style.setProperty(`--color-${token}`, theme.colors[token]);
  for (const token of SYNTAX_TOKENS) style.setProperty(`--syntax-${token}`, theme.syntax[token]);
  style.setProperty("--shadow-float", theme.shadowFloat);
  style.setProperty(COLOR_SCHEME, theme.variant);
}

export function applyDensity(tokens: DensityTokens, root: HTMLElement = document.documentElement): void {
  for (const [key, variable] of Object.entries(DENSITY_VARIABLES)) {
    root.style.setProperty(variable, `${String(tokens[key as keyof DensityTokens])}${PX}`);
  }
}

export function applyFonts(preferences: Preferences, root: HTMLElement = document.documentElement): void {
  set(root, FONT_VARIABLES.mono, userFontValue(preferences.fontMono));
  set(root, FONT_VARIABLES.sans, userFontValue(preferences.fontSans));
  root.style.setProperty(EDITOR_FONT_SIZE_VARIABLE, `${String(preferences.editorFontSize)}${PX}`);
}

/**
 * Everything, in one call. Used at startup, before the first render, and again whenever a
 * preference changes — there is no partial path, because writing sixty-odd properties is cheaper
 * than working out which of them moved.
 *
 * Which is also why it is fenced by `data-retheme`: sixty writes with a colour transition on every
 * mounted control is forty to a hundred transitions starting in the frame the 16ms theme-switch
 * budget measures. Decision 26. The guard is here and not inside `applyTheme`/`applyDensity`/
 * `applyFonts`, because those three are called directly by tests that would then be exercising it
 * without meaning to.
 */
export function applyPreferences(theme: Theme, preferences: Preferences, root?: HTMLElement): void {
  const target = root ?? document.documentElement;
  target.setAttribute(RETHEME_ATTRIBUTE, "");
  try {
    applyTheme(theme, target);
    applyDensity(densityTokens(preferences.density), target);
    applyFonts(preferences, target);
  } finally {
    // Measuring is what forces the recalculation, so the new colours are committed while
    // transitions are still off — it is a recalculation this call already pays for, and what it
    // buys is that taking the attribute off cannot retroactively animate the sixty properties just
    // written. `finally`, because a throw between the two attribute calls would leave the whole app
    // with transitions permanently disabled. `getBoundingClientRect()` and not `offsetHeight`: a
    // bare member-expression statement is a lint smell and reads like dead code.
    target.getBoundingClientRect();
    target.removeAttribute(RETHEME_ATTRIBUTE);
  }
}

/** Removing the property, rather than writing an empty one, is what restores the `var()` fallback. */
function set(root: HTMLElement, variable: string, value: string | null): void {
  if (value === null) root.style.removeProperty(variable);
  else root.style.setProperty(variable, value);
}
