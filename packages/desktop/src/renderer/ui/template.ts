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
 * Comments are masked the same way and for a related reason. Decision 047 lets a body preman parses
 * carry `//` and `/* *\/`, so the grammar must not see them either — left in, they are error nodes
 * in a document the engine is perfectly happy to send, and the editor and the engine disagree about
 * the same text. Blanking them to spaces is a legal JSON document again. They are then painted back
 * on, from the scan rather than from the tree, since by parse time they are whitespace.
 *
 * Two holes remain, both far narrower than the one this closes: a bare token used as a *key*
 * (`{{name}}: 1`) still fails, because a number is not a legal key, and two bare tokens with
 * nothing between them mask to one malformed number. Both are rare enough to be worth the
 * simplicity of a single length-preserving substitution.
 */

import type { CommentTokens } from "@codemirror/commands";
import { jsonLanguage } from "@codemirror/lang-json";
import { Language, LanguageSupport } from "@codemirror/language";
import { type Diagnostic, linter } from "@codemirror/lint";
import { type Extension, Prec, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  type Rect,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { type Input, Parser, type PartialParse, type TreeFragment } from "@lezer/common";

import { VARIABLE_TOKEN_SOURCE } from "@preman/desktop/engine/protocol.js";
import {
  BLOCK_CLOSE,
  BLOCK_OPEN,
  LINE_COMMENT,
  commentRanges,
  maskComments,
} from "@preman/desktop/renderer/model/comments.js";
import { tokenAt } from "@preman/desktop/renderer/model/tokens.js";

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
 *
 * Exported because the beautifier bounds itself by the same number: it validates through
 * `maskTemplates`, so the size at which masking stops being free is the size at which it declines.
 */
export const MASK_LIMIT_CHARS = 256 * 1024;

/**
 * `--syntax-macro` was the obvious reuse — a macro is also a name expanded before anything evaluates
 * it — and measuring it killed the idea: four of the vendored palettes give `macro` and `property`
 * the same hex, and several more put it within 0.04 of `number` in OKLab. A token sits where a
 * string or a number would with a `property` key beside it, so its own token it is, solved and gated
 * against those three by `scripts/audit.ts`.
 */
export const TOKEN_COLOR = "var(--syntax-template)";

const NO_EXTRA_EXTENSIONS = [] as const;

/** Named so the language reports itself as JSON, because for every purpose but parsing it is. */
const LANGUAGE_NAME = "json";

/** Length-preserving by construction: the replacement is always as long as the match it replaces. */
export function maskTemplates(text: string): string {
  return text.replace(MASK_PATTERN, (match) => MASK_LEAD + MASK_DIGIT.repeat(match.length - MASK_LEAD.length));
}

/**
 * Both masks, in the order that cannot misread either.
 *
 * Tokens first. A name is not a string, so `{{a//b}}` would otherwise have its tail blanked as a
 * comment and stop being a token at all; masked to digits first, it is safe from the comment scan.
 * The reverse hazard does not exist — a token inside a comment masks to digits and is then blanked
 * with the rest of the line, which is the same answer either way.
 *
 * Both are length-preserving, so composing them is still length-preserving.
 */
export function maskAuthored(text: string): string {
  return maskComments(maskTemplates(text));
}

function maskedInput(input: Input): Input {
  const masked = maskAuthored(input.read(0, input.length));

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
 * The same colour and slant `highlight.ts` gives `t.comment`, reached the long way round.
 *
 * A comment cannot be painted off the tree the way every other token is, because the mask has
 * already turned it into whitespace by the time the grammar runs — which is the point, and is what
 * stops it becoming a run of error nodes. So it is painted from the scan instead.
 */
const COMMENT_MARK = Decoration.mark({
  attributes: { style: `color: var(--syntax-comment); font-style: italic` },
});

/**
 * Painted from a whole-document scan rather than a viewport one, because `//` is only a comment
 * when it is not inside a string, and a viewport can begin in the middle of one. The scan is the
 * same cost as the mask the parser already runs, over a document `MASK_LIMIT_CHARS` bounds.
 */
function commentDecorations(view: EditorView): DecorationSet {
  const doc = view.state.doc;
  if (doc.length > MASK_LIMIT_CHARS) return Decoration.none;
  const ranges = commentRanges(doc.toString());
  return Decoration.set(ranges.map((range) => COMMENT_MARK.range(range.from, range.to)));
}

/**
 * What `Cmd+/` writes, and the reason it did nothing before decision 048.
 *
 * `defaultKeymap` has bound `Mod-/` to `toggleComment` all along; the command reads
 * `commentTokens` out of the language data at the caret and gives up when nobody published any.
 * Plain JSON has no comments, so `@codemirror/lang-json` publishes none — which is correct for it
 * and wrong here, since this is the language for a body 047 lets carry both forms. So the keystroke
 * was never missing, only the two markers it needed, and the editor that already *paints* a comment
 * refused to write one.
 *
 * The markers come from the scanner rather than being restated, so the toggle cannot write a form
 * the mask and the painter would then fail to recognise.
 *
 * Both forms, though `Cmd+/` reaches only the first: `toggleComment` takes `line` whenever a
 * language has one and never consults `block`, so what the shortcut does is always whole lines.
 * `block` is published anyway because this facet describes the language and not the keymap — 047
 * makes both forms legal in the file, `toggleBlockComment` is a command a keymap could bind, and
 * `lang-javascript` publishes the pair on the same grounds. Omitting it would encode a fact about
 * today's bindings into an answer about JSON.
 */
export const COMMENT_TOKENS: CommentTokens = {
  line: LINE_COMMENT,
  block: { open: BLOCK_OPEN, close: BLOCK_CLOSE },
};

const commentPainter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = commentDecorations(view);
    }

    update(update: ViewUpdate) {
      // Only a text change can move a comment; scrolling cannot, because the scan is not viewport
      // bound. Recomputing on every update would rescan the document on every cursor movement.
      if (update.docChanged) this.decorations = commentDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * What the engine answered about the names in this document, and the environment it answered for.
 *
 * `null` is "nobody has asked yet", which is the state an editor whose Preview was never opened
 * stays in for its whole life: a warning that costs a round trip must not be triggered by a
 * keystroke, so nothing here ever asks on its own.
 */
export interface Unresolved {
  /** Names that resolved to nothing, as `previewText` reported them. */
  readonly names: ReadonlySet<string>;
  /** How the environment is named in the message. */
  readonly environment: string;
}

export type UnresolvedNames = Unresolved | null;

/** Typed as `null` and not as `UnresolvedNames`, so a comparison against it narrows. */
export const NOTHING_ASKED = null;

/** `VARIABLE_TOKEN_SOURCE` has exactly one group, and it is the name. */
const NAME_GROUP = 1;
const NO_DIAGNOSTICS: Diagnostic[] = [];
const WARNING = "warning";

/** How a new answer reaches a live editor. */
export const setUnresolved = StateEffect.define<UnresolvedNames>();

/**
 * One field per editor rather than one shared instance.
 *
 * A `StateField` holds its value inside an `EditorState`, so sharing one would in fact be correct —
 * but the field is what decides whether the `linter()` is installed at all, and building it per
 * caller is what lets an editor that never lints carry neither.
 */
export function unresolvedField(): StateField<UnresolvedNames> {
  return StateField.define<UnresolvedNames>({
    create: () => NOTHING_ASKED,
    update: (value, transaction) => {
      // Last effect wins: two answers in one transaction would mean two previews landed together,
      // and the later one is the one that describes the current text.
      let next = value;
      for (const effect of transaction.effects) if (effect.is(setUnresolved)) next = effect.value;
      return next;
    },
  });
}

/**
 * The diagnostics for a document, as a pure function of the text and the answer.
 *
 * Split out from the `linter()` because the test suite has no DOM (`vitest.config.ts`), so an
 * `EditorView` is not something a test here can build. It is also the whole of the behaviour.
 */
export function unresolvedDiagnostics(doc: string, unresolved: UnresolvedNames): Diagnostic[] {
  if (unresolved === NOTHING_ASKED) return NO_DIAGNOSTICS;
  // Its own instance, per the note above: this pattern is global, and `lastIndex` on a shared one
  // would make the second call over the same text find nothing.
  const pattern = new RegExp(VARIABLE_TOKEN_SOURCE, "g");
  const found: Diagnostic[] = [];
  for (const match of doc.matchAll(pattern)) {
    const [whole] = match;
    const name = match[NAME_GROUP];
    if (name === undefined || !unresolved.names.has(name)) continue;
    found.push({
      from: match.index,
      to: match.index + whole.length,
      severity: WARNING,
      message: `{{${name}}} is not defined in ${unresolved.environment}`,
    });
  }
  return found;
}

/** What a click on a token reports: the name, and where on screen the token was drawn. */
export type TokenReporter = (name: string, at: DOMRect) => void;

/**
 * A rect covering both ends of the token, in viewport coordinates.
 *
 * `coordsAtPos` answers per position, and a wrapped token's two ends can be on different lines, so
 * the union is the honest anchor: the box then hangs off the whole token rather than off whichever
 * half the click was nearer.
 */
function rectBetween(start: Rect, end: Rect): DOMRect {
  const left = Math.min(start.left, end.left);
  const right = Math.max(start.right, end.right);
  return new DOMRect(left, start.top, right - left, end.bottom - start.top);
}

/**
 * Clicking a token reports it, and changes nothing else.
 *
 * Every handler returns `false`, which is decision 6: CodeMirror still places the caret where the
 * click landed. A gesture that stole the click would make a body the one text field in the app
 * where you cannot put the cursor in the middle of a name.
 */
export function tokenClicks(report: TokenReporter): Extension {
  return EditorView.domEventHandlers({
    mousedown: (event, view) => {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      // Hit-tested against the clicked line rather than the whole document: the name group can
      // cross a newline, and a token written across two lines is not one anybody meant.
      const line = view.state.doc.lineAt(pos);
      const token = tokenAt(line.text, pos - line.from);
      if (token === null) return false;
      const start = view.coordsAtPos(line.from + token.from);
      const end = view.coordsAtPos(line.from + token.to);
      if (start === null || end === null) return false;
      report(token.name, rectBetween(start, end));
      return false;
    },
  });
}

/**
 * `Prec.highest` is not a detail, and it is the opposite of what reading the docs suggests.
 * Overlapping mark decorations nest, and `color` on the *innermost* span is what the reader sees —
 * an outer span loses, `!important` or not, because inheritance always loses to a declaration on
 * the element itself. Measured in a real window: syntax highlighting registers its plugin at
 * `Prec.high`, and at `Prec.low` this one wrapped it and the tokens came out number-amber and
 * string-green. `Prec.highest` puts this inside it, where it wins. Lower this and the tokens
 * silently stop looking like tokens, with nothing failing to say so.
 *
 * The optional field is how an unresolved name becomes visible before send (decision 10). A
 * `linter()` and no `lintGutter()`: the wavy underline and the hover message are what is wanted,
 * and a gutter would change the editor's layout for a class of problem the Preview pane above
 * already lists in a banner. The field is an argument rather than something this module owns, so
 * the language stays a pure function of what it was handed and the pane keeps the async.
 *
 * `COMMENT_TOKENS` goes in here rather than into `templateJsonLanguage`'s own extensions, which
 * matters because that language shares `jsonLanguage.data` — the facet is reused deliberately, so
 * language-data lookups keep resolving. Providing the pair as part of *this* `LanguageSupport`
 * scopes it to a state configured with it, so a response body on plain `json` publishes nothing
 * and keeps the shortcut inert where a comment would be a lie about bytes off the wire.
 */
export function jsonTemplate(unresolved?: StateField<UnresolvedNames>): LanguageSupport {
  const lint =
    unresolved === undefined
      ? NO_EXTRA_EXTENSIONS
      : [unresolved, linter((view) => unresolvedDiagnostics(view.state.doc.toString(), view.state.field(unresolved)))];
  return new LanguageSupport(templateJsonLanguage, [
    templateJsonLanguage.data.of({ commentTokens: COMMENT_TOKENS }),
    Prec.highest(tokenPainter),
    Prec.highest(commentPainter),
    ...lint,
  ]);
}
