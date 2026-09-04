/**
 * POSIX word splitting, with no knowledge of curl.
 *
 * Its own module because it is where every bug in every curl importer lives: the most common
 * source of a pasted command is *Copy as cURL* in browser devtools, and that emits ANSI-C
 * `$'…'` quoting on macOS and `^` line continuations on Windows. A `split(/\s+/)` fails on
 * both, and fails quietly — it produces words, just not the ones the user copied.
 *
 * Deliberately ignorant of the grammar above it (decision 2): a clustered short flag like
 * `-sSL` is one word here, because clustering is curl's rule and not the shell's.
 */
import { EXIT, PremanError } from "@preman/core/errors.js";

const SINGLE_QUOTE = "'";
const DOUBLE_QUOTE = '"';
const BACKSLASH = "\\";
const DOLLAR = "$";
const CARET = "^";
const BACKTICK = "`";
const NEWLINE = "\n";
const CARRIAGE_RETURN = "\r";
const ANSI_C_OPENER = "$'";

/**
 * What a shell would start a subprocess for.
 *
 * Refused rather than guessed (decision 3): there is no request field that means "run this
 * and use the output", so importing one would silently produce a request that means something
 * else than the command did.
 */
const SUBSTITUTION_OPENERS = new Set(["$(", "`"]);

/** The escapes `$'…'` gives a meaning other than "the next character, literally". */
const ANSI_C_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'" };
const HEX_ESCAPE = "x";
/** bash accepts one or two hex digits after `\x`, and stops at the first non-digit. */
const HEX_ESCAPE_PATTERN = /^[0-9a-fA-F]{1,2}/;
const HEX_RADIX = 16;

/**
 * The characters a backslash escapes inside `"…"`. Everything else keeps its backslash,
 * which is what makes `"C:\Users"` survive a paste from a Windows terminal.
 */
const DOUBLE_QUOTE_ESCAPES = new Set([DOUBLE_QUOTE, BACKSLASH, DOLLAR, BACKTICK, NEWLINE]);

const WHITESPACE = /\s/;
/** How much of the offending text a refusal quotes back, so the reader can find it. */
const FRAGMENT_LENGTH = 32;

interface Read {
  readonly value: string;
  /** The index just past the closing quote. */
  readonly next: number;
}

function fragmentAt(text: string, at: number): string {
  return text.slice(at, at + FRAGMENT_LENGTH).split(NEWLINE)[0] ?? "";
}

/** The substitution opener starting at `at`, when one does. */
function substitutionAt(text: string, at: number): string | undefined {
  for (const opener of SUBSTITUTION_OPENERS) {
    if (text.startsWith(opener, at)) return opener;
  }
  return undefined;
}

function refuseSubstitution(text: string, at: number, opener: string): PremanError {
  return new PremanError(`the command runs another command with ${opener}`, {
    exitCode: EXIT.CLI,
    details: [
      `near: ${fragmentAt(text, at)}`,
      "a request file has no way to say \u201Crun this and use the output\u201D",
      "replace the substitution with the value it produces, then paste it again",
    ],
  });
}

function refuseUnterminated(text: string, at: number, opener: string): PremanError {
  return new PremanError(`the command has an unterminated ${opener} quote`, {
    exitCode: EXIT.CLI,
    details: [`near: ${fragmentAt(text, at)}`, "the paste may have been cut short"],
  });
}

/** `'…'`: no escapes at all, which is why the mac form wraps anything awkward in `$'…'`. */
function readSingleQuoted(text: string, start: number): Read {
  const end = text.indexOf(SINGLE_QUOTE, start);
  if (end === -1) throw refuseUnterminated(text, start - SINGLE_QUOTE.length, SINGLE_QUOTE);
  return { value: text.slice(start, end), next: end + 1 };
}

function readDoubleQuoted(text: string, start: number): Read {
  let value = "";
  let at = start;
  while (at < text.length) {
    const character = text[at]!;
    if (character === DOUBLE_QUOTE) return { value, next: at + 1 };

    const opener = substitutionAt(text, at);
    if (opener !== undefined) throw refuseSubstitution(text, at, opener);

    if (character === BACKSLASH) {
      const next = text[at + 1];
      if (next !== undefined && DOUBLE_QUOTE_ESCAPES.has(next)) {
        // A backslash-newline is a continuation even here: it contributes nothing to the word.
        if (next !== NEWLINE) value += next;
        at += 2;
        continue;
      }
      value += BACKSLASH;
      at += 1;
      continue;
    }

    value += character;
    at += 1;
  }
  throw refuseUnterminated(text, start - DOUBLE_QUOTE.length, DOUBLE_QUOTE);
}

/** `$'…'`: the form Chrome emits on macOS whenever a header or a body holds a newline. */
function readAnsiCQuoted(text: string, start: number): Read {
  let value = "";
  let at = start;
  while (at < text.length) {
    const character = text[at]!;
    if (character === SINGLE_QUOTE) return { value, next: at + 1 };

    if (character !== BACKSLASH) {
      value += character;
      at += 1;
      continue;
    }

    const next = text[at + 1];
    if (next === undefined) {
      value += BACKSLASH;
      at += 1;
      continue;
    }
    const mapped = ANSI_C_ESCAPES[next];
    if (mapped !== undefined) {
      value += mapped;
      at += 2;
      continue;
    }
    if (next === HEX_ESCAPE) {
      const digits = HEX_ESCAPE_PATTERN.exec(text.slice(at + 2));
      if (digits !== null) {
        value += String.fromCharCode(Number.parseInt(digits[0], HEX_RADIX));
        at += 2 + digits[0].length;
        continue;
      }
    }
    // Unknown escape: bash keeps the character and drops the backslash.
    value += next;
    at += 2;
  }
  throw refuseUnterminated(text, start - ANSI_C_OPENER.length, ANSI_C_OPENER);
}

/** The length of the line ending at `at`, or 0 when there is not one. */
function lineBreakAt(text: string, at: number): number {
  if (text[at] === NEWLINE) return 1;
  if (text[at] === CARRIAGE_RETURN && text[at + 1] === NEWLINE) return 2;
  return 0;
}

/**
 * Split `text` into the argv a shell would hand the program.
 *
 * Raises rather than guesses on a command substitution, a backtick or an unbalanced quote.
 */
export function splitWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  // Tracked separately from `current.length` so an empty quoted word (`-d ''`) survives.
  let started = false;
  let at = 0;

  const flush = (): void => {
    if (!started) return;
    words.push(current);
    current = "";
    started = false;
  };
  const take = (read: Read): void => {
    current += read.value;
    started = true;
    at = read.next;
  };

  while (at < text.length) {
    const character = text[at]!;

    if (WHITESPACE.test(character)) {
      flush();
      at += 1;
      continue;
    }

    if (character === BACKSLASH || character === CARET) {
      const skip = lineBreakAt(text, at + 1);
      if (skip > 0) {
        at += 1 + skip;
        continue;
      }
      // `^` is a continuation and nothing else; a backslash escapes whatever follows it.
      if (character === CARET) {
        current += CARET;
        started = true;
        at += 1;
        continue;
      }
      const next = text[at + 1];
      current += next ?? BACKSLASH;
      started = true;
      at += next === undefined ? 1 : 2;
      continue;
    }

    const opener = substitutionAt(text, at);
    if (opener !== undefined) throw refuseSubstitution(text, at, opener);

    if (text.startsWith(ANSI_C_OPENER, at)) {
      take(readAnsiCQuoted(text, at + ANSI_C_OPENER.length));
      continue;
    }
    if (character === SINGLE_QUOTE) {
      take(readSingleQuoted(text, at + 1));
      continue;
    }
    if (character === DOUBLE_QUOTE) {
      take(readDoubleQuoted(text, at + 1));
      continue;
    }

    current += character;
    started = true;
    at += 1;
  }

  flush();
  return words;
}
