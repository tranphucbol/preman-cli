/**
 * What a theme is.
 *
 * A palette, exhaustively. `Record<Token, string>` and never `Partial`: a theme missing a token
 * has to fail `tsc`, not fall back at runtime to a colour out of a different palette. A
 * half-applied theme is worse than a wrong one, because it is a palette nobody designed.
 *
 * The values are generated and audited — see `packages/desktop/scripts/generate-themes.ts` and the
 * six properties in `scripts/audit.ts`. This file is the shape; `themes/` is the data.
 */

export type Variant = "dark" | "light";

/**
 * The 21, in the order `app.css` declares them: five surfaces, two hairlines, three ink tiers, the
 * non-text glyph tier, the accent, three statuses, six methods.
 *
 * A token's name is its custom property with `--color-` taken off, which is what lets `apply.ts`
 * write the whole record in one loop rather than through a mapping nobody would keep current.
 */
export const COLOR_TOKENS = [
  "canvas",
  "panel",
  "control",
  "hover",
  "selected",
  "line",
  "line-strong",
  "ink",
  "ink-dim",
  "ink-faint",
  "glyph",
  "accent",
  "ok",
  "warn",
  "danger",
  "method-get",
  "method-post",
  "method-put",
  "method-patch",
  "method-delete",
  "method-grpc",
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];

/**
 * The 35 the editor paints with, written as `--syntax-*`.
 *
 * Wider than the stock CodeMirror highlight style on purpose. `propertyName` is the single
 * most-read token in a request tool and the stock style has none; `tag-name` / `attribute-name` /
 * `attribute-value` are what an XML response is made of; `atom` is `true`, `false` and `null`.
 *
 * The gutter is deliberately absent. A line number is quiet text, and the quiet text tiers are
 * already solved against every surface — reading a palette's own `lineNumber` would put a 2:1
 * colour in the one place this app has a solved answer for.
 */
export const SYNTAX_TOKENS = [
  "comment",
  "comment-doc",
  "keyword",
  "keyword-import",
  "storage-modifier",
  "atom",
  "number",
  "string",
  "string-escape",
  "regex",
  "operator",
  "punctuation",
  "bracket",
  "variable",
  "parameter",
  "property",
  "constant",
  "function",
  "method",
  "type",
  "class-name",
  "namespace",
  "decorator",
  "label",
  "macro",
  "tag-name",
  "attribute-name",
  "attribute-value",
  "url",
  "invalid",
  "diff-added",
  "diff-modified",
  "diff-removed",
  "heading",
  "link",
  /**
   * The odd one out: `{{token}}` is not a Lezer tag and no palette has a slot for it, so this is
   * not read from anywhere. It is solved, like the dim tiers and the method column, to sit far
   * enough from `string`, `number` and `property` — the three things a token is read beside — and
   * `ui/template.ts` paints it over whatever the grammar made of the token.
   */
  "template",
] as const;

export type SyntaxToken = (typeof SYNTAX_TOKENS)[number];

export interface Theme {
  readonly id: string;
  readonly name: string;
  readonly variant: Variant;
  /** The upstream project, for `scripts/palettes/NOTICE`. */
  readonly source: string;
  readonly licence: string;
  readonly colors: Readonly<Record<ColorToken, string>>;
  readonly syntax: Readonly<Record<SyntaxToken, string>>;
  /**
   * The one elevation in the app. A separate field rather than a colour token because it is a
   * whole `box-shadow` value: a near-black shadow tuned for a near-black canvas is a smudge on a
   * light one, so the offset and the alpha move with the palette, not only the hue.
   */
  readonly shadowFloat: string;
}
