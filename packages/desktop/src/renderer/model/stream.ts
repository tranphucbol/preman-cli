/**
 * What a stream's frame list shows, without React.
 *
 * A frame is small - a token, a chunk of a completion, a progress record - and there can be
 * thousands of them. So every decision here is about a row: what one line of it says, what the
 * expanded form says, and how to be honest about the ones the window no longer holds.
 *
 * The arithmetic is separated from the pane for the same reason `model/body.ts` is: a row that
 * says the wrong time or claims the wrong count is a bug you can only see by looking, and this
 * way it is a bug a test can see.
 */
import type { HeaderPairs } from "./response.js";

const START = 0;
const ONE_CHAR = 1;
const ONE_EVENT = 1;
const NOTHING_HIDDEN = 0;
const JSON_INDENT = 2;
/** `HH:MM:SS.mmm`, and each field's width in that string. */
const TIME_PAD = 2;
const MILLIS_PAD = 3;
const TIME_JOIN = ":";
const MILLIS_JOIN = ".";
const PAD_CHAR = "0";
const CONTENT_TYPE = "content-type";
/** Any run of whitespace, which a one-line summary shows as a single space. */
const WHITESPACE = /\s+/gu;
const ONE_SPACE = " ";
/** The two shapes JSON.parse accepts that are worth pretty-printing; a bare number is not. */
const JSON_OPENERS = new Set(["{", "["]);
const NEWLINE = "\n";
/** The expanded editor's floor and ceiling, in lines. `frameDetailLines` says why each is where it is. */
const DETAIL_MIN_LINES = 3;
const DETAIL_MAX_LINES = 18;

/**
 * What the server called the stream.
 *
 * Read off the head rather than off `ResponseBody.contentType`, because the body event does not
 * exist until the stream closes and this is wanted from the first frame. Case-insensitive: the
 * header name is, and these pairs come through untouched from the wire.
 */
export function streamContentType(headers: HeaderPairs): string | null {
  const found = headers.find(([name]) => name.toLowerCase() === CONTENT_TYPE);
  if (found === undefined) return null;
  const [, value] = found;
  return value;
}

/**
 * The wall clock of a frame, to the millisecond.
 *
 * Fixed 24-hour fields rather than `toLocaleTimeString`, deliberately. Two rows of a stream are
 * read against each other, and the interesting difference is usually under a second - a format
 * that can drop the milliseconds, or move to a 12-hour clock on someone else's machine, makes
 * the one column that answers "how far apart were these" unreliable.
 */
export function frameTime(at: number): string {
  const when = new Date(at);
  const hours = String(when.getHours()).padStart(TIME_PAD, PAD_CHAR);
  const minutes = String(when.getMinutes()).padStart(TIME_PAD, PAD_CHAR);
  const seconds = String(when.getSeconds()).padStart(TIME_PAD, PAD_CHAR);
  const millis = String(when.getMilliseconds()).padStart(MILLIS_PAD, PAD_CHAR);
  return `${hours}${TIME_JOIN}${minutes}${TIME_JOIN}${seconds}${MILLIS_JOIN}${millis}`;
}

/**
 * One line of a frame, for the collapsed row.
 *
 * A `data:` field can carry newlines - the spec joins multiple `data:` lines with one - and a row
 * that grows to three lines makes a virtualized list of a thousand frames measure every one of
 * them. Collapsing the whitespace keeps the row one line by construction rather than by CSS, so
 * the list can estimate its own size and be right.
 */
export function frameSummary(data: string): string {
  return data.replace(WHITESPACE, ONE_SPACE).trim();
}

/**
 * The frame's data, indented, when it is JSON.
 *
 * `null` when it is not, which is the signal to show the raw text instead. Guarded on the first
 * character before parsing because most streams are not JSON at all and `JSON.parse` throwing is
 * not free at a thousand frames - and because `data: 42` parses successfully into something no
 * amount of indentation improves.
 */
export function framePretty(data: string): string | null {
  const trimmed = data.trim();
  const opener = trimmed.slice(START, ONE_CHAR);
  if (!JSON_OPENERS.has(opener)) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, JSON_INDENT);
  } catch {
    // A partial frame is not an error worth reporting: the reader can see the raw text.
    return null;
  }
}

/**
 * How many frames the list is not showing.
 *
 * `total` counts every frame core dispatched; `shown` is what survived the store's window. The
 * difference is always at the front, because that is the end a reader watching a stream is not
 * looking at.
 */
export function hiddenFrames(shown: number, total: number): number {
  return Math.max(total - shown, NOTHING_HIDDEN);
}

/**
 * How many frames the stream carried, for the response header.
 *
 * `total` and not the list's length, because this counts what arrived rather than what is still
 * being shown - the two differ only on a very long stream, and the header is not where that
 * distinction gets explained.
 */
export function frameTally(total: number): string {
  return `${String(total)} ${total === ONE_EVENT ? "event" : "events"}`;
}

/**
 * What the frame list says about itself.
 *
 * The hidden part is named rather than implied: a list that silently shows the last thousand of
 * four thousand rows is a list that answers "how many did I get" wrongly, and this is the one
 * place that number is stated.
 */
export function frameCountLabel(shown: number, total: number): string {
  const hidden = hiddenFrames(shown, total);
  return hidden === NOTHING_HIDDEN ? frameTally(total) : `${frameTally(total)} · first ${String(hidden)} not kept`;
}

/**
 * How many lines tall the expanded frame's editor should be.
 *
 * The editor fills a sized parent and never sizes to its own content, so an expanded row has to
 * state a height - and a virtualized row has to state it on mount, before anything has been laid
 * out, or the list measures a box that is about to change. Counting the lines is that height,
 * arrived at without a layout pass.
 *
 * Clamped at both ends for different reasons. `[DONE]` is one line, and a one-line frame in a
 * fixed 260px box is mostly empty box, so the floor is low. The ceiling is where scrolling inside
 * the row becomes better than scrolling the list past it: a completion chunk runs to about twenty
 * lines indented, and a frame longer than the viewport would push every row under it off screen
 * to show text the reader can scroll to in place.
 *
 * Wrapping is not counted. A long single line reports as one and the editor scrolls it, which
 * costs a short row for a wide frame - the alternative is measuring the glyphs, which is the
 * layout pass this function exists to avoid.
 */
export function frameDetailLines(text: string): number {
  const lines = text.split(NEWLINE).length;
  return Math.min(Math.max(lines, DETAIL_MIN_LINES), DETAIL_MAX_LINES);
}
