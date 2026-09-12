import { LOG_TAIL_LINES, type LogLine } from "@preman/desktop/preload/bridge.js";

import { type Tone, toneClass } from "./response.js";

/**
 * The window's copy of the log, and the wording around it.
 *
 * The same split `model/resources.ts` makes: the part worth asserting lives here, and what is left
 * in the pane is JSX. Nothing here decides what may be logged — `docs/decisions/035` already did,
 * and `docs/decisions/056` is why the window may draw it.
 */

/**
 * How many lines the pane keeps.
 *
 * The file is the archive; this is a tail, and it is bounded because an app left open with the
 * stream on would otherwise grow a renderer array for as long as it ran.
 *
 * Exactly the tail main sends on switch-on, and derived from it rather than agreed with it: a
 * buffer smaller than the tail would throw away part of the answer to the question the switch
 * asked, and a larger one would hold lines from before a tail that replaced them. So the steady
 * state is the one the reader can describe — five hundred lines, the newest at the bottom, each
 * live line pushing out the oldest — and the rest is in the file the Reveal button opens.
 */
export const LOG_CAPACITY = LOG_TAIL_LINES;

const NONE = 0;

/**
 * Two digits each, on the clock main stamped it with, without the date.
 *
 * The date is in the file and would be the same on every visible line here, so it would cost a
 * column and say nothing. Local time and not the file's UTC, because the reader is comparing this
 * against when they pressed the thing, not against another machine.
 */
const TIME_PAD = 2;
const TIME_PAD_CHAR = "0";
const TIME_SEPARATOR = ":";

/**
 * Fold a batch into the kept lines, newest last.
 *
 * Returns the array it was given when the batch is empty, so a flush that raced a clear cannot
 * make every subscriber re-render for nothing.
 */
export function remember(lines: readonly LogLine[], arrived: readonly LogLine[]): readonly LogLine[] {
  if (arrived.length === NONE) return lines;
  const next = [...lines, ...arrived];
  return next.length <= LOG_CAPACITY ? next : next.slice(next.length - LOG_CAPACITY);
}

/** `14:03:27`. */
export function formatLogTime(at: number): string {
  const when = new Date(at);
  return [when.getHours(), when.getMinutes(), when.getSeconds()]
    .map((part) => String(part).padStart(TIME_PAD, TIME_PAD_CHAR))
    .join(TIME_SEPARATOR);
}

/**
 * Which tone a level reads at.
 *
 * `info` is neutral rather than green: a log is mostly info, and a wall of `text-ok` would say
 * "everything succeeded" about lines that only say "this happened". Green is reserved for the
 * response pane, where it is a claim. `fatal` shares `danger` with `error` because there is no
 * fifth tone and no colour louder than the loudest — the word itself is the difference, and it is
 * in the level column.
 */
const LEVEL_TONE: Record<LogLine["level"], Tone> = {
  info: "neutral",
  warn: "warn",
  error: "danger",
  fatal: "danger",
};

export function levelClass(level: LogLine["level"]): string {
  return toneClass(LEVEL_TONE[level]);
}

/**
 * How tall the box is, in pixels, and how far it may be dragged.
 *
 * Pixels rather than rows, because the thing being dragged is an edge and the thing being read is
 * a wrapped line that is not one row tall. The floor is roughly four unwrapped lines: below that
 * the box stops being a window onto a stream and becomes a slot, and the reader would drag it back
 * immediately. There is no ceiling here — the pane scrolls, so a box taller than the window is the
 * reader's business — but there is a ceiling in {@link resizeLog}'s caller, which passes what is
 * left of the viewport, because a box that outgrows the window hides the row that says where the
 * file is.
 */
export const LOG_HEIGHT_DEFAULT = 256;
export const LOG_HEIGHT_MIN = 96;

/**
 * The height a drag lands on, never outside the bounds.
 *
 * Clamped here rather than at the pointer so the two ends behave the same way: dragging past the
 * floor and letting go leaves the box at the floor, not at whatever the pointer had accumulated,
 * so the next upward pixel of movement grows it again. A drag that stored the raw delta would need
 * that same pixel to be dragged back through the slack first.
 */
export function resizeLog(height: number, ceiling: number): number {
  // The floor wins a contradiction: a window too short to hold even the minimum box would
  // otherwise hand back a ceiling below the floor, and the box would collapse on a resize nobody
  // asked for. A box overflowing a tiny window is the better of the two failures.
  const highest = Math.max(ceiling, LOG_HEIGHT_MIN);
  return Math.min(Math.max(Math.round(height), LOG_HEIGHT_MIN), highest);
}

/** A run of characters, and whether the query put it there. */
export interface LogSegment {
  readonly text: string;
  readonly hit: boolean;
}

/** No query, and therefore nothing matched and nothing to step through. */
export const NO_QUERY = "";
export const NO_MATCHES: readonly number[] = [];
/** What `matches[active]` is when there is no active match. Never an index into the array. */
export const NO_MATCH = -1;
/** `String.indexOf`'s miss. The same number as {@link NO_MATCH} and a different statement. */
const NOT_FOUND = -1;

/**
 * Everything a line offers a search, in the order the row draws it.
 *
 * The rule is "you can search what you can see", which is why the formatted time is in here and
 * the raw `at` is not: `16:35` is what the row says and what a reader would type, and the epoch
 * milliseconds behind it are a number nobody has ever searched for.
 */
function columnsOf(line: LogLine): readonly string[] {
  return [formatLogTime(line.at), line.level, line.text];
}

/**
 * Case-insensitive, substring, and deliberately not a regex.
 *
 * A log search is typed one character at a time against text that is already noisy with brackets
 * and slashes, and a regex engine turns a half-typed `(` into an error or, worse, into a silent
 * zero matches. Nothing here can fail to parse.
 */
function foundIn(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

/**
 * Split one column into alternating plain and matched runs.
 *
 * Runs rather than characters — the palette's `Highlighted` marks a fuzzy subsequence, so it has to
 * go letter by letter, and this is a substring, so one span per run is both correct and three
 * hundred fewer elements on a full screen of log.
 */
export function splitMatches(text: string, query: string): readonly LogSegment[] {
  const needle = query.toLowerCase();
  if (needle === NO_QUERY) return [{ text, hit: false }];
  const haystack = text.toLowerCase();
  const segments: LogSegment[] = [];
  let cursor = NONE;
  for (;;) {
    const at = haystack.indexOf(needle, cursor);
    if (at === NOT_FOUND) break;
    if (at > cursor) segments.push({ text: text.slice(cursor, at), hit: false });
    segments.push({ text: text.slice(at, at + needle.length), hit: true });
    cursor = at + needle.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}

/**
 * Which lines the query hits, as indices into the list, in the order they are drawn.
 *
 * Indices and not lines, because next and previous are positions in a list that is still growing
 * underneath them: a new line arriving appends, so every index already computed still points at
 * the row it did — until the buffer is full, at which point they all shift by one and the caller
 * recomputes anyway.
 */
export function matchingLines(lines: readonly LogLine[], query: string): readonly number[] {
  const needle = query.toLowerCase();
  if (needle === NO_QUERY) return NO_MATCHES;
  const hits: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (columnsOf(line).some((column) => foundIn(column, needle))) hits.push(index);
  }
  return hits;
}

/**
 * The next match in a direction, wrapping at both ends.
 *
 * Wrapping rather than stopping: the list is a ring of scrollback with no beginning worth
 * defending, and a Next that goes dead at the last match makes the reader scroll back by hand to
 * do the thing the button was for. Answers {@link NO_MATCH} when there is nothing to step to.
 */
export function stepMatch(count: number, active: number, delta: number): number {
  if (count === NONE) return NO_MATCH;
  if (active === NO_MATCH) return delta < NONE ? count - 1 : NONE;
  return (((active + delta) % count) + count) % count;
}
