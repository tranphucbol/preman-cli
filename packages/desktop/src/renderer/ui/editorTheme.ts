/**
 * What the editor is painted with: the chrome spec, the two themes over it, and the one extension
 * a rule in that spec needs to exist.
 *
 * Split out of `CodeEditor.tsx` because two of these rules are correct only in relation to
 * CodeMirror's own base theme — a selector depth and a paint order — and a fact like that wants an
 * assertion rather than a comment. `CodeEditor.tsx` reaches the appearance store and therefore
 * `window`, which a Node test has none of; this module reaches nothing, so
 * `test/renderer/editor.test.ts` can read the spec directly.
 *
 * The syntax colours are next door in `highlight.ts` for the same reason they always were: this
 * file is the editor's chrome, that one is its text.
 */

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { Variant } from "@preman/desktop/renderer/appearance/theme.js";

/**
 * The document's size is a reading preference the settings pane writes; the find panel's is not.
 * A find panel that grew to 20px because someone wanted a bigger document would be a control
 * sized by the wrong question, so it stays on the density scale like every other control.
 */
const FONT_SIZE = "var(--editor-font-size)";
const PANEL_FONT_SIZE = "var(--text-xs)";
const PANEL_LABEL_SIZE = "var(--text-2xs)";
const LINE_HEIGHT = "1.55";
const GUTTER_MIN_WIDTH = "2.25rem";

/**
 * The selection band, and why it is not `--color-selected`.
 *
 * `--color-selected` is a row tint, argued down to hover luminance in `app.css` on purpose so that
 * a 5,000-row tree does not shimmer. That is the right call for a full-width row carrying text of
 * its own and the wrong one here: it reads at 1.2:1 against the panel, and behind four characters
 * a band is the only indicator there is. WCAG 1.4.11 asks 3:1 of exactly that.
 *
 * The accent mixed down is the answer that holds for all forty-three themes rather than for one.
 * It is the single colour every palette is already audited readable against both canvas and panel
 * (`scripts/audit.ts`), so deriving the band from it costs no new token, no regenerated themes and
 * no new row in the audit. Thirty percent is where it clears the surface it sits on — 1.8:1 on
 * `preman-dark`, about what every other editor spends — while still letting the syntax through.
 */
const SELECTION_FILL = "color-mix(in oklab, var(--color-accent) 30%, transparent)";

/**
 * The same colour at the weight "this text, elsewhere" deserves. `--color-control` was 1.1:1
 * against the panel, which made `highlightSelectionMatches` an extension that rendered nothing.
 */
const SELECTION_MATCH_FILL = "color-mix(in oklab, var(--color-accent) 14%, transparent)";

/** Set on `.cm-editor` while any range is non-empty; read by the `.cm-activeLine` rule below. */
export const SELECTING_CLASS = "pm-selecting";

/** Adding no class at all. Hoisted and widened because CodeMirror's `Attrs` is not exported. */
const NO_ATTRIBUTES: Record<string, string> = {};

/**
 * The band's selector, spelled the long way on purpose.
 *
 * CodeMirror's base theme paints the focused band through
 * `&dark.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground` — five classes.
 * The obvious `&.cm-focused .cm-selectionBackground` is three, so the base theme's `#233` won on
 * specificity no matter what this file said, and no matter that the base theme is `Prec.lowest`:
 * precedence orders the stylesheet, it does not order the cascade. Matching the shape exactly puts
 * the two at five apiece, and a tie goes to the module mounted later, which is this one.
 *
 * A read-only editor never carries `.cm-focused` at all — `EditorView.editable.of(false)` leaves
 * `.cm-content` unfocusable — so the bare first selector is what a response body actually paints
 * with, and both have to name the same fill.
 */
const SELECTION_SELECTOR =
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground";

/**
 * Kept as one object so the whole editor's chrome is legible in one place. Colours are
 * `var(--color-*)` because the palette was contrast-audited once and must not be forked.
 *
 * Exported for `test/renderer/editor.test.ts`, which asserts the two rules whose correctness is a
 * fact about CodeMirror's cascade rather than about anything visible in this file.
 */
export const THEME_SPEC = {
  "&": {
    backgroundColor: "transparent",
    color: "var(--color-ink)",
    fontSize: FONT_SIZE,
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: LINE_HEIGHT,
    overflow: "auto",
  },
  ".cm-content": { padding: "6px 0", caretColor: "var(--color-accent)" },
  ".cm-line": { padding: "0 10px" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--color-ink-faint)",
    border: "none",
    minWidth: GUTTER_MIN_WIDTH,
  },
  ".cm-gutterElement": { padding: "0 6px 0 8px" },
  ".cm-activeLine": { backgroundColor: "var(--color-hover)" },
  /**
   * The active line steps aside for the band rather than blending with it.
   *
   * A line decoration is a background on `.cm-line`, inside `.cm-content`, which paints above the
   * `z-index: -1` selection layer — and `highlightActiveLine` decorates the head line of every
   * range, empty or not. CodeMirror survives that because its own active line is `#99eeff33`;
   * ours is an opaque surface token, so the stock extension hid the band on the one line a
   * single-line selection is on, which is every selection anyone makes.
   *
   * Thinning `--color-hover` instead would have left both cues at about 1.2:1. Dropping this one
   * has the better answer to what the active line is for: it says where the caret is, and while
   * there is a selection the band says that better.
   */
  [`&.${SELECTING_CLASS} .cm-activeLine`]: { backgroundColor: "transparent" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--color-ink-dim)" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--color-control)",
    border: "1px solid var(--color-line-strong)",
    color: "var(--color-ink-dim)",
    padding: "0 4px",
    borderRadius: "var(--radius-xs)",
  },
  [SELECTION_SELECTOR]: { backgroundColor: SELECTION_FILL },
  // The find panel's field, and nothing else: `drawSelection` hides the native highlight inside
  // `.cm-line` with `!important`, so on the document itself this rule is dead and the band above
  // is the whole of what anyone sees.
  "::selection": { backgroundColor: SELECTION_FILL },
  ".cm-cursor": { borderLeftColor: "var(--color-accent)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--color-control)",
    outline: "1px solid var(--color-line-strong)",
  },
  ".cm-selectionMatch": { backgroundColor: SELECTION_MATCH_FILL },
  ".cm-placeholder": { color: "var(--color-ink-faint)" },
  // The find widget ships as a browser-styled form. Retuned here for the same reason
  // Radix is retuned: a stock panel in a dense tool reads as somebody else's software.
  ".cm-panels": { backgroundColor: "var(--color-panel)", color: "var(--color-ink)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--color-line)" },
  ".cm-search": { display: "flex", alignItems: "center", gap: "6px", padding: "5px 8px" },
  ".cm-search label": { display: "inline-flex", alignItems: "center", gap: "4px", fontSize: PANEL_LABEL_SIZE },
  ".cm-textfield": {
    backgroundColor: "var(--color-control)",
    border: "1px solid var(--color-line-strong)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-ink)",
    fontSize: PANEL_FONT_SIZE,
    padding: "2px 6px",
  },
  ".cm-button": {
    backgroundColor: "var(--color-control)",
    backgroundImage: "none",
    border: "1px solid var(--color-line-strong)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-ink)",
    fontSize: PANEL_LABEL_SIZE,
    padding: "2px 8px",
  },
};

/**
 * Two themes over one spec, differing only in the flag.
 *
 * Nothing in the rules above depends on the variant — they are all `var(--color-*)`, and those are
 * rewritten by `apply.ts` — but `dark` is not a colour. It decides which of CodeMirror's own
 * built-in styles apply and it puts `cm-dark` on the element, which is what a future extension
 * shipping its own light and dark rules will look at. It is the one thing about the editor a
 * custom property cannot express, and therefore the one thing that needs a compartment.
 */
export const THEMES: Readonly<Record<Variant, Extension>> = {
  dark: EditorView.theme(THEME_SPEC, { dark: true }),
  light: EditorView.theme(THEME_SPEC, { dark: false }),
};

/**
 * What the `.cm-activeLine` override reads. Computed from the selection rather than watched in a
 * view plugin, so "anything is selected" is a function of the state and cannot drift out of one.
 * Stateless, and therefore shared across mounts like the themes above.
 */
export const SELECTING_ATTRIBUTE = EditorView.editorAttributes.compute(["selection"], (state) =>
  state.selection.ranges.some((range) => !range.empty) ? { class: SELECTING_CLASS } : NO_ATTRIBUTES,
);
