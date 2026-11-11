/**
 * The default, and the only theme in this directory that is written rather than generated.
 *
 * Its twenty-one colours are byte-identical to the `@theme` block in `app.css`, and that is the
 * whole reason it is hand-written: upgrading into a themable build has to produce zero visual diff
 * for anyone who never opens the picker. A generator run over a `preman-dark.json` would land
 * within a rounding step of these values and be wrong in exactly the way that matters, because
 * every screenshot in the docs is of these bytes.
 *
 * The surfaces lean blue rather than neutral grey: a graphite with a cool cast reads as one
 * designed palette where the old greys read as unstyled, and the accent and method colours are a
 * step softer so they sit on it instead of shouting. gRPC is cyan, not teal, so it stays clear of
 * GET's green in the method column.
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
    canvas: "#0e1016",
    panel: "#141721",
    control: "#1a1e2a",
    hover: "#212635",
    selected: "#1b2741",
    line: "#252a37",
    "line-strong": "#333a4b",
    ink: "#e2e6f0",
    "ink-dim": "#adb4c4",
    "ink-faint": "#8a91a3",
    glyph: "#737b90",
    accent: "#7c9cff",
    ok: "#6fd49b",
    warn: "#f0c674",
    danger: "#ff8080",
    "method-get": "#6fd49b",
    "method-post": "#f0c674",
    "method-put": "#7cb7ff",
    "method-patch": "#c3a0ff",
    "method-delete": "#ff8080",
    "method-grpc": "#5ccfe0",
  },
  syntax: {
    comment: "#8a91a3",
    "comment-doc": "#9aa1b2",
    keyword: "#c3a0ff",
    "keyword-import": "#ff8080",
    "storage-modifier": "#5ccfe0",
    atom: "#f0c674",
    number: "#f0c674",
    string: "#6fd49b",
    "string-escape": "#5ccfe0",
    regex: "#8fe0b3",
    operator: "#ffa0a0",
    punctuation: "#8a91a3",
    bracket: "#adb4c4",
    variable: "#e2e6f0",
    parameter: "#d6c2ff",
    // The most-read token in a request tool takes the accent, because a JSON body is mostly keys.
    property: "#7c9cff",
    constant: "#5ccfe0",
    function: "#7cb7ff",
    method: "#6fd49b",
    type: "#f0c674",
    "class-name": "#f0c674",
    namespace: "#5ccfe0",
    decorator: "#c3a0ff",
    label: "#ff8080",
    macro: "#5ccfe0",
    "tag-name": "#ff8080",
    "attribute-name": "#f0c674",
    "attribute-value": "#6fd49b",
    url: "#5ccfe0",
    invalid: "#ff8080",
    "diff-added": "#6fd49b",
    "diff-modified": "#f0c674",
    "diff-removed": "#ff8080",
    heading: "#7c9cff",
    link: "#5ccfe0",
    // A pink nothing else in this theme is, because a `{{token}}` sits between a string and a
    // number on the same line and has to be neither. The teal `constant` wears would have been the
    // obvious reuse; it measures 0.0847 from `string`, under the 0.1 the audit asks for.
    template: "#ff92d0",
  },
  shadowFloat: "0 4px 12px rgb(6 8 14 / 0.55)",
};
