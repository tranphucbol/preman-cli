/**
 * The editor's keymap gives up the Send key.
 *
 * `Mod-Enter` is the window's Send shortcut, but CodeMirror's `defaultKeymap` also binds it, to
 * `insertBlankLine`, and the editor's handler runs first. With both, a send from inside a body left
 * a stray blank line in it. What is asserted is that the editor no longer claims the key, and
 * that nothing else of the default keymap went with it.
 */
import { defaultKeymap } from "@codemirror/commands";
import { describe, expect, it } from "vitest";

import { EDITOR_KEYMAP, SEND_KEY } from "@preman/desktop/renderer/ui/editorKeymap.js";

/** The only binding the editor drops from CodeMirror's defaults. */
const DROPPED_BINDINGS = 1;

describe("the editor keymap", () => {
  it("givenDefaultKeymap_whenEditorKeymapBuilt_thenSendKeyIsNotBound", () => {
    expect(defaultKeymap.some((binding) => binding.key === SEND_KEY)).toBe(true);
    expect(EDITOR_KEYMAP.some((binding) => binding.key === SEND_KEY)).toBe(false);
  });

  it("givenDefaultKeymap_whenEditorKeymapBuilt_thenEveryOtherBindingIsKept", () => {
    expect(EDITOR_KEYMAP).toHaveLength(defaultKeymap.length - DROPPED_BINDINGS);
    expect(EDITOR_KEYMAP.every((binding) => defaultKeymap.includes(binding))).toBe(true);
  });
});
