/**
 * Where the comments are in a body someone authored, and the same document with them blanked out.
 *
 * Decision 047 made a body preman parses accept `//` and `/* *\/`, which the engine implements in
 * `packages/core/src/json/comments.ts`. This is that scanner again, on this side of the fence,
 * because the renderer may not import `@preman/core` — the rule that keeps a window from becoming
 * an engine. Two copies of forty lines is the price, and it is the right one: what is duplicated is
 * a definition of JSON's syntax, which does not change, rather than any of preman's behaviour.
 *
 * The engine only ever needs the masked text. An editor also needs to know where the comments were,
 * to paint them, so the range scan is the exported primitive here and the mask is derived from it.
 *
 * Not a JSON parser. It knows two things: `"` opens and closes a string, and a backslash escapes
 * whatever follows it. That is exactly enough to tell a comment from a `//` inside a URL.
 */

/**
 * The three markers, exported because `ui/template.ts` hands them to the comment commands so that
 * what `Cmd+/` writes is by construction what this scanner recognises. One definition, both
 * directions: a scanner that learned a fourth marker could not be shipped without the keystroke
 * learning it too.
 */
export const LINE_COMMENT = "//";
export const BLOCK_OPEN = "/*";
export const BLOCK_CLOSE = "*/";
const QUOTE = '"';
const BACKSLASH = "\\";
const LINE_BREAK = "\n";
const SPACE = " ";
const START = 0;
const NOT_FOUND = -1;
const NEXT = 1;
/** `//`, `/*`, `*\/` and a backslash escape are all two characters wide. */
const PAIR = 2;
const EMPTY = "";
/** Everything a mask replaces with a space. A line break is what it must not touch. */
const NOT_A_LINE_BREAK = /[^\n]/g;

/** Half-open, in document positions, exactly as CodeMirror wants a decoration range. */
export interface CommentRange {
  readonly from: number;
  readonly to: number;
}

const NO_COMMENTS: readonly CommentRange[] = [];

/**
 * Every comment in `text`, in document order.
 *
 * A line comment ends at its newline and does not include it; an unterminated block comment runs to
 * the end of the document, which is what the author asked for even though nothing after it parses.
 */
export function commentRanges(text: string): readonly CommentRange[] {
  let found: CommentRange[] | undefined;
  let at = START;
  let inString = false;

  while (at < text.length) {
    const char = text.charAt(at);

    if (inString) {
      if (char === BACKSLASH) {
        at += PAIR;
        continue;
      }
      if (char === QUOTE) inString = false;
      at += NEXT;
      continue;
    }

    if (char === QUOTE) {
      inString = true;
      at += NEXT;
      continue;
    }

    const ahead = text.slice(at, at + PAIR);

    if (ahead === LINE_COMMENT) {
      const end = text.indexOf(LINE_BREAK, at);
      const to = end === NOT_FOUND ? text.length : end;
      found ??= [];
      found.push({ from: at, to });
      at = to;
      continue;
    }

    if (ahead === BLOCK_OPEN) {
      const end = text.indexOf(BLOCK_CLOSE, at + PAIR);
      const to = end === NOT_FOUND ? text.length : end + PAIR;
      found ??= [];
      found.push({ from: at, to });
      at = to;
      continue;
    }

    at += NEXT;
  }

  // The shared empty array is the common answer, and returning it allocates nothing per keystroke.
  return found ?? NO_COMMENTS;
}

/**
 * The document with every comment blanked to spaces, line breaks kept.
 *
 * Length-preserving for decision 023's reason, which is the same reason here as there: every
 * position in the masked text is the same position in the real text, so a tree built from it needs
 * no translation and no offset exists to get wrong.
 */
export function maskComments(text: string): string {
  const ranges = commentRanges(text);
  if (ranges.length === START) return text;

  let out = EMPTY;
  let at = START;
  for (const range of ranges) {
    out += text.slice(at, range.from) + text.slice(range.from, range.to).replace(NOT_A_LINE_BREAK, SPACE);
    at = range.to;
  }
  return out + text.slice(at);
}
