/**
 * JSON with `{{token}}` in it, for the editors that hold a body someone authored.
 *
 * A bare `{{app_id}}` is brace-balanced, which is exactly why it is so destructive: Lezer's JSON
 * grammar reads the two openers as two nested objects and then pairs the two closers with them, so
 * the brace that should have closed the *enclosing* object is gone. From there the parser believes
 * it is at top level, and a quoted key at top level is just a string — which is why every key after
 * the first bare token came out `--syntax-string` instead of `--syntax-property`, and why bracket
 * matching, folding and auto-indent were wrong too, until the next `{` happened to resynchronise
 * the parse. One token made the rest of the document a different colour.
 *
 * So the grammar is not given the real document. Every `{{…}}` is replaced by a JSON number of
 * exactly the same length before parsing. Equal length is the load-bearing part: every position in
 * the resulting tree then maps 1:1 onto the real text, so the tree needs no translation and
 * incremental reparsing keeps working.
 *
 * A number and not a string because a token is just as likely to be written inside quotes, and
 * masking `"{{id}}"` to `""____""` would be worse than the disease. `"0.0000"` is an ordinary
 * string, and `0.0000` is an ordinary value, so one mask covers both positions.
 *
 * The tokens are then painted back on top, because the mask deliberately loses them: a bare token
 * would read as a number and a quoted one as part of its string, and the whole point is that a
 * token looks like a token wherever it appears.
 *
 * Two holes remain, both far narrower than the one this closes: a bare token used as a *key*
 * (`{{name}}: 1`) still fails, because a number is not a legal key, and two bare tokens with
 * nothing between them mask to one malformed number. Both are rare enough to be worth the
 * simplicity of a single length-preserving substitution.
 */

import { jsonLanguage } from "@codemirror/lang-json";
import { Language, LanguageSupport } from "@codemirror/language";
import { Prec } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { type Input, Parser, type PartialParse, type TreeFragment } from "@lezer/common";

/**
 * Two compiled instances of one pattern. A global regex carries `lastIndex`, and `MatchDecorator`
 * takes ownership of the one it is handed, so sharing a single instance with the masker would have
 * them stepping on each other.
 */
const TOKEN_SOURCE = String.raw`\{\{[^{}]*\}\}`;
const MASK_PATTERN = new RegExp(TOKEN_SOURCE, "g");
const DECORATED_PATTERN = new RegExp(TOKEN_SOURCE, "g");

/** `{{}}` is the shortest possible match at four characters, so `0.` always has two digits to spare. */
const MASK_LEAD = "0.";
const MASK_DIGIT = "0";

/**
 * Masking reads the whole document once per parse. That is free for a request body and not free for
 * a response, so past this size the text is handed to the grammar untouched — a document that big
 * is not one somebody typed a token into.
 */
const MASK_LIMIT_CHARS = 256 * 1024;

/**
 * `--syntax-macro` was the obvious reuse — a macro is also a name expanded before anything evaluates
 * it — and measuring it killed the idea: four of the vendored palettes give `macro` and `property`
 * the same hex, and several more put it within 0.04 of `number` in OKLab. A token sits where a
 * string or a number would with a `property` key beside it, so its own token it is, solved and gated
 * against those three by `scripts/audit.ts`.
 */
const TOKEN_COLOR = "var(--syntax-template)";

const NO_EXTRA_EXTENSIONS = [] as const;

/** Named so the language reports itself as JSON, because for every purpose but parsing it is. */
const LANGUAGE_NAME = "json";

/** Length-preserving by construction: the replacement is always as long as the match it replaces. */
export function maskTemplates(text: string): string {
  return text.replace(MASK_PATTERN, (match) => MASK_LEAD + MASK_DIGIT.repeat(match.length - MASK_LEAD.length));
}

function maskedInput(input: Input): Input {
  const masked = maskTemplates(input.read(0, input.length));

  return {
    length: input.length,
    // Chunks may be any size when this is false, so the whole remainder is a legal answer.
    lineChunks: false,
    chunk: (from: number) => masked.slice(from),
    read: (from: number, to: number) => masked.slice(from, to),
  };
}

type ParseRanges = readonly { readonly from: number; readonly to: number }[];

class MaskedParser extends Parser {
  private readonly inner: Parser;

  constructor(inner: Parser) {
    super();
    this.inner = inner;
  }

  // `ranges` passes through unchanged: the mask preserves every offset, so it still means the same.
  createParse(input: Input, fragments: readonly TreeFragment[], ranges: ParseRanges): PartialParse {
    const source = input.length <= MASK_LIMIT_CHARS ? maskedInput(input) : input;
    return this.inner.createParse(source, fragments, ranges);
  }
}

/**
 * Reusing `jsonLanguage.data` is what makes this legal: the JSON parser already attaches that exact
 * facet to its top node through `languageDataProp`, so language-data lookups keep resolving.
 */
const templateJsonLanguage = new Language(
  jsonLanguage.data,
  new MaskedParser(jsonLanguage.parser),
  [...NO_EXTRA_EXTENSIONS],
  LANGUAGE_NAME,
);

const TOKEN_MARK = Decoration.mark({ attributes: { style: `color: ${TOKEN_COLOR}` } });
const TOKEN_MATCHER = new MatchDecorator({ regexp: DECORATED_PATTERN, decoration: TOKEN_MARK });

const tokenPainter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = TOKEN_MATCHER.createDeco(view);
    }

    update(update: ViewUpdate) {
      this.decorations = TOKEN_MATCHER.updateDeco(update, this.decorations);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * `Prec.highest` is not a detail, and it is the opposite of what reading the docs suggests.
 * Overlapping mark decorations nest, and `color` on the *innermost* span is what the reader sees —
 * an outer span loses, `!important` or not, because inheritance always loses to a declaration on
 * the element itself. Measured in a real window: syntax highlighting registers its plugin at
 * `Prec.high`, and at `Prec.low` this one wrapped it and the tokens came out number-amber and
 * string-green. `Prec.highest` puts this inside it, where it wins. Lower this and the tokens
 * silently stop looking like tokens, with nothing failing to say so.
 */
export function jsonTemplate(): LanguageSupport {
  return new LanguageSupport(templateJsonLanguage, [Prec.highest(tokenPainter)]);
}
