/**
 * Re-indenting a body somebody is authoring.
 *
 * There is a second formatter in this app — `BodyStore.format` in `packages/core/src/api/bodies.ts`
 * — and it is `JSON.stringify(JSON.parse(text), null, 2)`. This one is not, deliberately, and a
 * reader who unifies the two breaks requests. A response is already interpolated and is only ever
 * looked at, so reserialising it is free. A request body is bytes that go on the wire, and a round
 * trip through `JSON.parse` rewrites them:
 *
 * ```
 * in  : {"n": {{count}}, "big": 12345678901234567890, "f": 1.0, "e": 1e3}
 * out : {"n": 0, "big": 12345678901234567000, "f": 1, "e": 1000}
 * ```
 *
 * The bare token is the worst of those — nine characters become one — but every one of them is a
 * different request than the author wrote. So this module never parses a value: it copies strings,
 * numbers and tokens through verbatim and rewrites only the whitespace between them. See ADR 031.
 *
 * `{{…}}` is matched before `{` is read as a brace, because a bare token is brace-balanced and a
 * scanner that met `{` first would indent inside a variable name.
 *
 * Well-formedness is answered by `JSON.parse(maskTemplates(text))`, which is already-tested code,
 * and its answer never touches the output. That leaves the scanner free to assume balance. The
 * masker's two documented holes — a bare token as a key, two bare tokens with nothing between them
 * — are inherited here as a refusal, which is the direction that cannot mangle anything.
 */

import { VARIABLE_TOKEN_SOURCE } from "@preman/desktop/engine/protocol.js";
import { MASK_LIMIT_CHARS, maskTemplates } from "@preman/desktop/renderer/ui/template.js";

export type FormatOutcome =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

/** Two, so the two formatters in the app disagree about method and agree about output shape. */
const INDENT = "  ";
const NEWLINE = "\n";
const KEY_SEPARATOR = ": ";

const EMPTY = "";
const NOTHING = 0;
const START = 0;
const NEXT = 1;
const ONE_LEVEL = 1;
/** A backslash and the character it escapes are consumed together, so neither is ever read alone. */
const ESCAPED_PAIR = 2;
const WHOLE_MATCH = 0;

const QUOTE = '"';
const BACKSLASH = "\\";
const OPEN_BRACE = "{";
const COMMA = ",";
const COLON = ":";

/** Sticky, not global: every attempt is at a position the scanner chose. */
const AT_THIS_POSITION = "y";

const CLOSER_OF: Record<string, string> = { "{": "}", "[": "]" };
const CLOSERS = new Set(["}", "]"]);
const JSON_WHITESPACE = new Set([" ", "\t", NEWLINE, "\r"]);

/**
 * Both reasons say what was checked rather than pronouncing on the document, because the masker's
 * holes mean this can refuse a body that is, to its author, perfectly fine.
 */
const UNPARSEABLE_REASON =
  "Reading it as JSON, with every {{token}} stood in for, did not succeed. A token used as a key, " +
  "or two tokens with nothing between them, fails that check even when the body is otherwise fine.";
const TOO_LONG_REASON = `Tokens stop being recognised past ${String(MASK_LIMIT_CHARS)} characters, and this body is longer than that.`;

/** Re-indents JSON that may contain `{{token}}`, without reserialising any value in it. */
export function formatJsonTemplate(text: string): FormatOutcome {
  // Formatting nothing is not a failure; the caller's equality guard makes it a no-op.
  if (text.trim().length === NOTHING) return { ok: true, text };
  if (text.length > MASK_LIMIT_CHARS) return { ok: false, reason: TOO_LONG_REASON };

  try {
    JSON.parse(maskTemplates(text));
  } catch {
    return { ok: false, reason: UNPARSEABLE_REASON };
  }

  return reindent(text);
}

function reindent(text: string): FormatOutcome {
  const token = new RegExp(VARIABLE_TOKEN_SOURCE, AT_THIS_POSITION);
  let out = EMPTY;
  let depth = NOTHING;
  let at = START;

  while (at < text.length) {
    const char = text.charAt(at);

    if (char === OPEN_BRACE && text.charAt(at + NEXT) === OPEN_BRACE) {
      token.lastIndex = at;
      const match = token.exec(text);
      // The masker accepts `{{}}` and this pattern requires a name, so they disagree on exactly one
      // input. Refusing it is cheaper than deciding which of the two is right.
      if (match === null) return { ok: false, reason: UNPARSEABLE_REASON };
      out += match[WHOLE_MATCH];
      at = token.lastIndex;
      continue;
    }

    if (char === QUOTE) {
      const end = endOfString(text, at);
      out += text.slice(at, end);
      at = end;
      continue;
    }

    if (JSON_WHITESPACE.has(char)) {
      at += NEXT;
      continue;
    }

    const closer = CLOSER_OF[char];
    if (closer !== undefined) {
      // Look past whitespace, not one character, so `{ }` collapses the way `{}` already does.
      const after = skipWhitespace(text, at + NEXT);
      if (text.charAt(after) === closer) {
        out += char + closer;
        at = after + NEXT;
        continue;
      }
      depth += ONE_LEVEL;
      out += char + NEWLINE + INDENT.repeat(depth);
      at += NEXT;
      continue;
    }

    if (CLOSERS.has(char)) {
      depth -= ONE_LEVEL;
      out += NEWLINE + INDENT.repeat(depth) + char;
      at += NEXT;
      continue;
    }

    if (char === COMMA) {
      out += COMMA + NEWLINE + INDENT.repeat(depth);
      at += NEXT;
      continue;
    }

    if (char === COLON) {
      out += KEY_SEPARATOR;
      at += NEXT;
      continue;
    }

    // A number, a keyword, or anything else the oracle already accepted: copied, never read.
    out += char;
    at += NEXT;
  }

  return { ok: true, text: out };
}

/** The index just past the closing quote of the string opening at `quoteAt`. */
function endOfString(text: string, quoteAt: number): number {
  let at = quoteAt + NEXT;

  while (at < text.length) {
    const char = text.charAt(at);
    if (char === BACKSLASH) {
      at += ESCAPED_PAIR;
      continue;
    }
    if (char === QUOTE) return at + NEXT;
    at += NEXT;
  }

  return at;
}

function skipWhitespace(text: string, from: number): number {
  let at = from;
  while (at < text.length && JSON_WHITESPACE.has(text.charAt(at))) at += NEXT;
  return at;
}
