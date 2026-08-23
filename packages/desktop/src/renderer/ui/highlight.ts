/**
 * Syntax highlighting, as a mapping from Lezer tags to this app's tokens.
 *
 * What was here before was `defaultHighlightStyle`, which is CodeMirror's stock style and is tuned
 * for a white page: its comment grey measures about 1.3:1 on `--color-canvas`. So the editor has
 * been shipping highlighting that is technically present and practically invisible. This file is
 * the fix, and it is a mapping rather than a palette: every colour is a `var(--syntax-*)`, so the
 * theme decides and this file only decides *which* token a construct is.
 *
 * That indirection is also why there is no `Compartment` and no reconfigure. Changing the theme
 * rewrites the custom properties on `:root`; the rules generated from this style name those
 * properties, so every open editor repaints on the same frame as the rest of the app without
 * anybody dispatching a transaction. A `HighlightStyle` holding hex values would need one
 * reconfigure per mounted view and a way to find them all.
 *
 * A tag that is not listed inherits from its parent tag, and one with no listed ancestor falls
 * through to `--color-ink`, which is the body colour and is audited. There is no arrangement of
 * this table that produces unreadable text.
 */
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

import type { SyntaxToken } from "@preman/desktop/renderer/appearance/theme.js";

/**
 * The only way a colour is named here. Typed against `SyntaxToken`, so a property this app does
 * not define is a compile error rather than a rule the browser silently drops.
 */
function syntax(token: SyntaxToken): string {
  return `var(--syntax-${token})`;
}

const ITALIC = "italic";
const BOLD = "600";
const UNDERLINE = "underline";
const STRIKETHROUGH = "line-through";

/**
 * Ordered roughly as a file reads: what surrounds the code, then its literals, then its names.
 *
 * Several tokens take a list of tags rather than one. `operator` covers eleven, because a theme
 * that distinguished `+` from `&&` from `=>` would be asking a palette to make a distinction no
 * reader makes.
 */
export const HIGHLIGHT_STYLE = HighlightStyle.define([
  { tag: t.comment, color: syntax("comment"), fontStyle: ITALIC },
  { tag: t.docComment, color: syntax("comment-doc"), fontStyle: ITALIC },

  { tag: [t.keyword, t.controlKeyword, t.self, t.operatorKeyword], color: syntax("keyword") },
  { tag: t.moduleKeyword, color: syntax("keyword-import") },
  { tag: [t.modifier, t.definitionKeyword], color: syntax("storage-modifier") },

  { tag: [t.atom, t.bool, t.null, t.unit], color: syntax("atom") },
  { tag: [t.number, t.integer, t.float], color: syntax("number") },
  { tag: [t.string, t.docString, t.character, t.special(t.string)], color: syntax("string") },
  { tag: t.escape, color: syntax("string-escape") },
  { tag: t.regexp, color: syntax("regex") },

  {
    tag: [
      t.operator,
      t.derefOperator,
      t.arithmeticOperator,
      t.logicOperator,
      t.bitwiseOperator,
      t.compareOperator,
      t.updateOperator,
      t.definitionOperator,
      t.typeOperator,
      t.controlOperator,
    ],
    color: syntax("operator"),
  },
  { tag: [t.punctuation, t.separator], color: syntax("punctuation") },
  { tag: [t.bracket, t.angleBracket, t.squareBracket, t.paren, t.brace], color: syntax("bracket") },

  { tag: t.variableName, color: syntax("variable") },
  { tag: t.local(t.variableName), color: syntax("parameter") },
  { tag: [t.propertyName, t.special(t.propertyName)], color: syntax("property") },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: syntax("constant") },
  { tag: t.function(t.variableName), color: syntax("function") },
  { tag: t.function(t.propertyName), color: syntax("method") },
  { tag: [t.typeName, t.standard(t.typeName)], color: syntax("type") },
  { tag: t.className, color: syntax("class-name") },
  { tag: t.namespace, color: syntax("namespace") },
  { tag: [t.meta, t.annotation], color: syntax("decorator") },
  { tag: t.labelName, color: syntax("label") },
  { tag: t.macroName, color: syntax("macro") },

  { tag: t.tagName, color: syntax("tag-name") },
  { tag: t.attributeName, color: syntax("attribute-name") },
  { tag: t.attributeValue, color: syntax("attribute-value") },
  { tag: t.url, color: syntax("url"), textDecoration: UNDERLINE },
  { tag: t.link, color: syntax("link"), textDecoration: UNDERLINE },
  { tag: t.heading, color: syntax("heading"), fontWeight: BOLD },

  { tag: t.inserted, color: syntax("diff-added") },
  { tag: t.changed, color: syntax("diff-modified") },
  { tag: t.deleted, color: syntax("diff-removed") },
  { tag: t.invalid, color: syntax("invalid") },

  // Weight and slant, with no colour of their own: markdown emphasis is a shape, and giving it a
  // hue as well would make a bolded word read as a different kind of thing.
  { tag: t.strong, fontWeight: BOLD },
  { tag: t.emphasis, fontStyle: ITALIC },
  { tag: t.strikethrough, textDecoration: STRIKETHROUGH },
]);
