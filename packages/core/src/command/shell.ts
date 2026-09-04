/**
 * POSIX word joining, with no knowledge of curl.
 *
 * The half of the round trip `import/shell.ts` never needed: that module splits a pasted
 * command into an argv, this one puts an argv back into a string a shell will split the same
 * way. Its own module for the same reason `splitWords` is (027 decision 2), and because it is
 * the half with no other test — `splitWords(quoteWords(words))` deep-equalling `words` is what
 * pins it, and a property that holds in only one file is not a property.
 *
 * Deliberately ignorant of the grammar above it: `-H` and `a: b` are two words here, and
 * whether curl clusters them is curl's business.
 */

/**
 * Words that survive {@link import("@preman/core/import/shell.js").splitWords} unquoted.
 *
 * Deliberately conservative. Everything outside this set is single-quoted, which is the one
 * form with no escapes inside it at all, so a body holding `$(`, a backtick or a newline
 * cannot become something the receiving shell executes.
 */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const QUOTE = "'";
/** Close the quote, escape the apostrophe, reopen — the one escape POSIX single quoting has. */
const ESCAPED_QUOTE = String.raw`'\''`;
const WORD_SEPARATOR = " ";
/** A word that vanished would change the argv, so an empty one is written out loud. */
const EMPTY_WORD = "''";

function quoteWord(word: string): string {
  if (word.length === 0) return EMPTY_WORD;
  if (SHELL_SAFE.test(word)) return word;
  return `${QUOTE}${word.split(QUOTE).join(ESCAPED_QUOTE)}${QUOTE}`;
}

/**
 * Join `words` into one line a shell splits back into exactly `words`.
 *
 * One line, always: no `\` continuations, so the round-trip property has one shape to hold
 * (decision 14). Multi-line is additive later, not a redesign.
 */
export function quoteWords(words: readonly string[]): string {
  return words.map(quoteWord).join(WORD_SEPARATOR);
}
