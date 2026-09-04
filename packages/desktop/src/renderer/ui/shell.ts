/**
 * A shell command line, coloured enough to be read at a glance.
 *
 * Deliberately not a shell grammar. Nothing here is a shell *script*: the only documents this ever
 * sees are the one-line `curl` and `grpcurl` that `command/` renders, which have no pipelines, no
 * expansions, no substitutions and no control flow. A real parser would be a dependency and several
 * hundred lines to describe constructs that cannot occur, and it would still colour this document
 * the same way. `StreamLanguage` over a five-branch tokenizer is the honest size of the problem.
 *
 * What it paints is what a reader of one of these commands actually scans for: which tool this is,
 * where each flag starts, which of the words are quoted arguments, and where the target is. Those
 * four are the shape of the command; everything else is left as body text.
 *
 * The quoting understood here is the quoting `quoteWords` emits and no other: single quotes, with
 * an embedded quote written `'\''`. That closes the loop rather than narrowing it — a document this
 * cannot tokenize is a document preman did not produce.
 *
 * The tags are returned by name and resolved through the same `HIGHLIGHT_STYLE` table every other
 * language goes through, so this inherits all 43 themes and the contrast audit with them. No colour
 * is named in this file, which is the rule in `docs/design-system.md` and is why there is no theme
 * work to do when one is added.
 */
import { StreamLanguage, type StreamParser } from "@codemirror/language";

/** The tool. `variableName.function` is what a called name is everywhere else in this app. */
const COMMAND_TAG = "variableName.function";
/** `-X`, `--data-raw`, `-import-path`: one dash or two, since grpcurl uses one for long flags. */
const FLAG_TAG = "attributeName";
const STRING_TAG = "string";
/** A url or an `authority:port`. Underlined by the shared table, which is why it is worth naming. */
const URL_TAG = "url";
/** Body text: an unquoted argument that is not a flag and not a target. */
const PLAIN_TAG = null;

const QUOTE = "'";
const DASH = "-";
const SPACE = " ";
const TAB = "\t";

/**
 * A bare word that is a place rather than a value: `curl` ends on a url, `grpcurl` on `host:port`.
 *
 * Two branches and not three. A schemeless host with a path — `api.example.test/v1` — looks like a
 * third case worth catching and is not: `finaliseHttpRequest` refuses a url that is not one, so no
 * `curl` this renders can end that way, while `test.echo.EchoService/Ping` matches it exactly. The
 * looser rule painted every gRPC method as a url. The `\S` tail keeps a query string in the token.
 */
const TARGET_PATTERN = /^(?:[a-z][a-z0-9+.-]*:\/\/\S+|[\w.-]+:\d+\S*)$/i;

interface ShellState {
  /** Whether the first word has been consumed. The tool is only the tool in first position. */
  started: boolean;
}

/**
 * Consume one single-quoted run, including the `'\''` an embedded quote is written as.
 *
 * That sequence closes the string, emits a literal quote and reopens it, so a tokenizer that
 * stopped at the first closing quote would end the token in the middle of a header value. Peeking
 * at what follows the close is the whole of the handling.
 */
function eatQuoted(stream: Parameters<StreamParser<ShellState>["token"]>[0]): void {
  stream.next();
  for (;;) {
    const next = stream.next();
    if (next === undefined) return;
    if (next !== QUOTE) continue;
    // `'\''` — a close, an escaped quote, a reopen. `eat` only advances when it matches.
    if (stream.peek() !== "\\") return;
    stream.next();
    if (stream.peek() === QUOTE) stream.next();
    if (stream.peek() === QUOTE) stream.next();
  }
}

const shellParser: StreamParser<ShellState> = {
  name: "shell-command",
  startState: () => ({ started: false }),
  token(stream, state) {
    if (stream.eatSpace()) return PLAIN_TAG;

    if (stream.peek() === QUOTE) {
      state.started = true;
      eatQuoted(stream);
      return STRING_TAG;
    }

    const first = !state.started;
    state.started = true;

    if (stream.peek() === DASH) {
      stream.eatWhile((char) => char !== SPACE && char !== TAB);
      return FLAG_TAG;
    }

    // Up to the next separator, then decide what the word was. Deciding after consuming rather
    // than by lookahead keeps the two questions - where does it end, what is it - apart.
    const from = stream.pos;
    stream.eatWhile((char) => char !== SPACE && char !== TAB && char !== QUOTE);
    const word = stream.string.slice(from, stream.pos);

    if (first) return COMMAND_TAG;
    return TARGET_PATTERN.test(word) ? URL_TAG : PLAIN_TAG;
  },
};

/** The extension `CodeEditor` installs for `language="shell"`. */
export const shellCommand = StreamLanguage.define(shellParser);
