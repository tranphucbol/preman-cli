/**
 * Removing comments from a document that is about to be parsed as JSON.
 *
 * A body is not a file, it is a text box a human types into, and Postman's box accepts `//` and
 * block comments and drops them on the way to the wire. People write them for the reason people
 * always write them — a field commented out today was there yesterday — so a document carrying
 * comments is not a mistake to report, it is one preman is expected to understand. Decision 047
 * has the argument; this module is only the mechanism.
 *
 * It masks rather than deletes, which is decision 023's trick reused for the same reason: every
 * comment character becomes a space and every line break survives, so the text handed to the
 * parser is the same length and shape as the text the author is looking at. No offset has to be
 * translated afterwards, which means no offset can be translated wrongly — when the parse fails
 * for some other reason, the engine's own position still points at the author's line.
 *
 * This is not a JSON parser and does not pretend to be one. It knows only that a string is opened
 * and closed by `"` and that a backslash escapes the next character, which is exactly enough to
 * tell a comment from a `//` inside a URL.
 */
const LINE_COMMENT = "//";
const BLOCK_OPEN = "/*";
const BLOCK_CLOSE = "*/";
const QUOTE = '"';
const BACKSLASH = "\\";
const LINE_BREAK = "\n";
const SPACE = " ";
const START = 0;
const NOT_FOUND = -1;
const NEXT = 1;
/** `//`, the two block delimiters and a backslash escape are all two characters wide. */
const PAIR = 2;
const EMPTY = "";
/** Everything a mask replaces with a space. A line break is the one thing it must not touch. */
const NOT_A_LINE_BREAK = /[^\n]/g;
/** The parser's position, when the engine bothers to give one. */
const PARSER_POSITION = /position (\d+)/;
const FIRST_LINE = 1;

/** Every character of `text` except its line breaks, so the mask keeps the line numbering. */
function blank(text: string): string {
  return text.replace(NOT_A_LINE_BREAK, SPACE);
}

/** The document with its comments blanked out, character for character and line for line. */
export function maskComments(raw: string): string {
  let masked = EMPTY;
  let index = START;
  let inString = false;
  while (index < raw.length) {
    const char = raw[index]!;
    if (inString) {
      if (char === BACKSLASH) {
        masked += raw.slice(index, index + PAIR);
        index += PAIR;
        continue;
      }
      if (char === QUOTE) inString = false;
      masked += char;
      index += NEXT;
      continue;
    }
    if (char === QUOTE) {
      inString = true;
      masked += char;
      index += NEXT;
      continue;
    }
    const ahead = raw.slice(index, index + PAIR);
    if (ahead === LINE_COMMENT) {
      const end = raw.indexOf(LINE_BREAK, index);
      const stop = end === NOT_FOUND ? raw.length : end;
      masked += blank(raw.slice(index, stop));
      index = stop;
      continue;
    }
    if (ahead === BLOCK_OPEN) {
      const end = raw.indexOf(BLOCK_CLOSE, index + PAIR);
      // An unterminated block comment runs to the end, which is what the author asked for even
      // though the parse that follows will fail on the truncation.
      const stop = end === NOT_FOUND ? raw.length : end + PAIR;
      masked += blank(raw.slice(index, stop));
      index = stop;
      continue;
    }
    masked += char;
    index += NEXT;
  }
  return masked;
}

/**
 * The line the parser choked on, quoted back with its number, when the engine said where.
 *
 * Best effort on purpose. V8 reports a position for some faults and not others, JavaScriptCore
 * reports one for none, and a line number invented from a scan would need a second JSON parser to
 * be right. No detail is better than a wrong one.
 */
export function offendingLine(raw: string, message: string): string[] {
  const at = PARSER_POSITION.exec(message);
  if (at === null) return [];
  const position = Number(at[1]);
  if (position > raw.length) return [];
  const number = raw.slice(START, position).split(LINE_BREAK).length;
  const line = raw.split(LINE_BREAK)[number - FIRST_LINE];
  if (line === undefined) return [];
  return [`  line ${String(number)}: ${line.trim()}`];
}
