/**
 * The default, and the only theme in this directory that is written rather than generated.
 *
 * Its twenty-one colours are byte-identical to the `@theme` block in `app.css`, and that is the
 * whole reason it is hand-written: upgrading into a themable build has to produce zero visual diff
 * for anyone who never opens the picker. A generator run over a `preman-dark.json` would land
 * within a rounding step of these values and be wrong in exactly the way that matters, because
 * every screenshot in the docs is of these bytes.
 *
 * The thirty-five syntax colours are new — the editor used stock CodeMirror until now, and stock
 * CodeMirror's default highlight style is tuned for a white page. They are drawn from the six hues
 * the palette already has rather than from a sixth family, and they are held to the same audit as
 * every generated theme: `test/renderer/themes.test.ts` does not know which of these files a human
 * touched.
 */
import type { Theme } from "@preman/desktop/renderer/appearance/theme.js";

export const premanDark: Theme = {
  id: "preman-dark",
  name: "preman Dark",
  source: "preman",
  licence: "MIT",
  variant: "dark",
  colors: {
    canvas: "#111214",
    panel: "#17191c",
    control: "#1d2024",
    hover: "#23262b",
    selected: "#1d2632",
    line: "#2a2d32",
    "line-strong": "#383c43",
    ink: "#d8dade",
    "ink-dim": "#a8adb6",
    "ink-faint": "#8a8f98",
    glyph: "#6e7684",
    accent: "#6aa9ff",
    ok: "#5ec27f",
    warn: "#e0b355",
    danger: "#ff7a6b",
    "method-get": "#5ec27f",
    "method-post": "#e0b355",
    "method-put": "#6aa9ff",
    "method-patch": "#b78bff",
    "method-delete": "#ff7a6b",
    "method-grpc": "#4ec9c0",
  },
  syntax: {
    comment: "#8a8f98",
    "comment-doc": "#9aa0a9",
    keyword: "#b78bff",
    "keyword-import": "#ff7a6b",
    "storage-modifier": "#4ec9c0",
    atom: "#e0b355",
    number: "#e0b355",
    string: "#5ec27f",
    "string-escape": "#4ec9c0",
    regex: "#7fd6a0",
    operator: "#ff9d8f",
    punctuation: "#8a8f98",
    bracket: "#a8adb6",
    variable: "#d8dade",
    parameter: "#d0b6ff",
    // The most-read token in a request tool takes the accent, because a JSON body is mostly keys.
    property: "#6aa9ff",
    constant: "#4ec9c0",
    function: "#6aa9ff",
    method: "#5ec27f",
    type: "#e0b355",
    "class-name": "#e0b355",
    namespace: "#4ec9c0",
    decorator: "#b78bff",
    label: "#ff7a6b",
    macro: "#4ec9c0",
    "tag-name": "#ff7a6b",
    "attribute-name": "#e0b355",
    "attribute-value": "#5ec27f",
    url: "#4ec9c0",
    invalid: "#ff7a6b",
    "diff-added": "#5ec27f",
    "diff-modified": "#e0b355",
    "diff-removed": "#ff7a6b",
    heading: "#6aa9ff",
    link: "#4ec9c0",
    // A pink nothing else in this theme is, because a `{{token}}` sits between a string and a
    // number on the same line and has to be neither. The teal `constant` wears would have been the
    // obvious reuse; it measures 0.0847 from `string`, under the 0.1 the audit asks for.
    template: "#ff8ad8",
  },
  shadowFloat: "0 4px 12px rgb(9 10 12 / 0.55)",
};
