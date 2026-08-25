/**
 * The two editor rules that cannot be checked by reading them.
 *
 * Both are facts about CodeMirror's cascade rather than about the style object, and both were
 * once wrong in a way that looked entirely reasonable in a diff: the selection band was styled,
 * with the right token, in a rule that lost — first to a base-theme selector with two more
 * classes in it, and then, on the one line that mattered, to an opaque active line painted above
 * the layer the band is drawn on. The editor reported no error and simply showed nothing.
 *
 * So what is asserted here is not "the band has a colour". It is the shape of the selector and
 * the kind of colour, which is the part a later simplification would take out.
 */
import { describe, expect, it } from "vitest";

import { SELECTING_CLASS, THEME_SPEC } from "@preman/desktop/renderer/ui/editorTheme.js";

/** The class CodeMirror's own base theme reaches the focused band through. Five classes deep. */
const SELECTION_LAYER = ".cm-selectionLayer";
const SELECTION_BACKGROUND = ".cm-selectionBackground";
const ACTIVE_LINE = ".cm-activeLine";
const ACCENT = "--color-accent";
/** The row tint. Correct for a tree row, 1.2:1 against the panel, and never the band. */
const ROW_TINT = "--color-selected";
const TRANSPARENT = "transparent";

const RULES: Readonly<Record<string, Record<string, string>>> = THEME_SPEC;

function selectorsMentioning(fragment: string): string[] {
  return Object.keys(RULES).filter((selector) => selector.includes(fragment));
}

describe("the editor theme", () => {
  it("givenTheSelectionRule_whenRead_thenItMatchesTheBaseThemeSelectorDepth", () => {
    const [selector, ...rest] = selectorsMentioning(SELECTION_BACKGROUND);

    expect(rest).toEqual([]);
    expect(selector).toBeDefined();
    // Without this, `&.cm-focused .cm-selectionBackground` is three classes against the base
    // theme's five and an editable editor paints CodeMirror's #233 no matter what is written here.
    expect(selector).toContain(SELECTION_LAYER);
    // And a read-only editor never carries `.cm-focused` at all, so the bare selector has to be
    // in the same rule rather than left behind on the old token.
    expect(selector?.split(/,\s*/)).toContain(SELECTION_BACKGROUND);
  });

  it("givenTheSelectionRule_whenRead_thenTheFillIsDerivedFromTheAccentAndNotTheRowTint", () => {
    const selector = selectorsMentioning(SELECTION_BACKGROUND)[0] ?? "";
    const fill = RULES[selector]?.backgroundColor ?? "";

    expect(fill).toContain(ACCENT);
    expect(fill).not.toContain(ROW_TINT);
  });

  it("givenASelection_whenTheActiveLineIsPainted_thenItStepsOutOfTheBandsWay", () => {
    const [selector, ...rest] = selectorsMentioning(`.${SELECTING_CLASS}`);

    expect(rest).toEqual([]);
    expect(selector).toContain(ACTIVE_LINE);
    expect(RULES[selector ?? ""]?.backgroundColor).toBe(TRANSPARENT);
  });
});
