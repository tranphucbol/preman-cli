/**
 * What the find bar says and where it lands, with no view and no React.
 *
 * The bar is one component in front of two searches: CodeMirror's, over a document the
 * renderer holds, and the engine's, over a body it does not. Everything both of them have to
 * agree on - how a count reads, what an opening query is, which hit typing jumps to - lives
 * here so the agreement is a function call and a test, not two copies of a sentence.
 */
import type { SearchQuery } from "@codemirror/search";
import type { EditorState, SelectionRange, Text } from "@codemirror/state";

/**
 * Where counting stops. A regex like `.` over a pretty-printed 2MB body has two million hits;
 * nobody steps through ten thousand, and a counter that froze the window to say so would be
 * the find bar's only visible cost.
 */
export const FIND_COUNT_CAP = 10_000;

/** Up to here the count is taken on every keystroke; above it, once typing pauses. */
export const FIND_COUNT_EAGER_CHARS = 200_000;

/** The pause that counts as having stopped typing. Also what the engine's search waits for. */
export const FIND_COUNT_DEBOUNCE_MS = 120;

/**
 * A selection longer than this is not a search term - it is a paragraph the reader happened to
 * have selected. CodeMirror's own panel draws the line at the same place.
 */
export const PREFILL_MAX_CHARS = 100;

const LINE_BREAK = "\n";
const NUMBER_LOCALE = "en-US";
const FIRST = 1;

export interface FindCount {
  readonly total: number;
  /** 1-based, or `null` when the selection is not on a hit - which is the bar's `?`. */
  readonly current: number | null;
  /** `total` is the cap and there are more. */
  readonly capped: boolean;
  /** The pattern does not compile; `total` and `current` mean nothing. */
  readonly invalid: boolean;
}

/**
 * The engine's search, for a body the editor holds only a window of. The engine's search is
 * exact bytes, so the bar offers no options in front of it.
 */
export interface RemoteFind {
  /** Count the hits for `query` across the whole body; `null` when the search failed. */
  search(query: string): Promise<{ readonly total: number; readonly capped: boolean } | null>;
  /** Bring hit `index` (0-based, in body order) into the editor and select it. */
  step(index: number): void;
}

export interface FoundMatches {
  readonly ranges: readonly { readonly from: number; readonly to: number }[];
  readonly capped: boolean;
}

const INVALID: FindCount = { total: 0, current: null, capped: false, invalid: true };

/**
 * Every hit in the document, up to `cap`. `null` for an empty query, which is no search at
 * all rather than a search with no hits; `"invalid"` for a regex that does not compile.
 */
export function findMatches(
  doc: EditorState | Text,
  query: SearchQuery,
  cap: number = FIND_COUNT_CAP,
): FoundMatches | "invalid" | null {
  if (query.search === "") return null;
  if (!query.valid) return "invalid";
  const ranges: { from: number; to: number }[] = [];
  const cursor = query.getCursor(doc);
  for (let next = cursor.next(); next.done !== true; next = cursor.next()) {
    if (ranges.length === cap) return { ranges, capped: true };
    ranges.push({ from: next.value.from, to: next.value.to });
  }
  return { ranges, capped: false };
}

/**
 * Which hit the selection sits on. Exact on both ends, because a selection that merely
 * overlaps a hit is the reader's own and saying "3/12" over it would claim otherwise.
 */
export function countOf(found: FoundMatches | "invalid", selection: SelectionRange): FindCount {
  if (found === "invalid") return INVALID;
  const { ranges, capped } = found;
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = ranges[middle];
    if (range === undefined) break;
    if (range.from < selection.from) low = middle + 1;
    else if (range.from > selection.from) high = middle - 1;
    else {
      const current = range.to === selection.to ? middle + FIRST : null;
      return { total: ranges.length, current, capped, invalid: false };
    }
  }
  return { total: ranges.length, current: null, capped, invalid: false };
}

export function countMatches(state: EditorState, query: SearchQuery, cap: number = FIND_COUNT_CAP): FindCount | null {
  const found = findMatches(state, query, cap);
  return found === null ? null : countOf(found, state.selection.main);
}

function totalText(count: FindCount): string {
  return count.capped ? `${count.total.toLocaleString(NUMBER_LOCALE)}+` : String(count.total);
}

/** What the counter shows: `""` with no query, then `0/0`, `?/12`, `3/12`, `10,000+`. */
export function counterText(count: FindCount | null): string {
  if (count === null) return "";
  if (count.invalid) return "Invalid regex";
  const current = count.total === 0 ? "0" : count.current === null ? "?" : String(count.current);
  return `${current}/${totalText(count)}`;
}

/** The same count as a sentence, for the screen reader the counter's glyphs would fail. */
export function counterSpoken(count: FindCount | null): string {
  if (count === null) return "";
  if (count.invalid) return "Invalid regular expression";
  if (count.total === 0) return "No matches";
  const total = count.capped ? `more than ${totalText(count).slice(0, -1)}` : String(count.total);
  const noun = count.total === 1 && !count.capped ? "match" : "matches";
  return count.current === null ? `${total} ${noun}` : `${String(count.current)} of ${total} ${noun}`;
}

/** Whether the counter is bad news: a pattern that does not compile, or nothing to find. */
export function countFailed(count: FindCount | null): boolean {
  return count !== null && (count.invalid || count.total === 0);
}

/**
 * The query the bar opens with: the selection when it reads as a search term - one line, not
 * empty, not a paragraph - and otherwise whatever was searched last in this editor.
 */
export function openingQuery(state: EditorState, previous: string): string {
  const { from, to } = state.selection.main;
  if (from === to || to - from > PREFILL_MAX_CHARS) return previous;
  const text = state.sliceDoc(from, to);
  return text.includes(LINE_BREAK) ? previous : text;
}

/**
 * The hit typing jumps to: the first at or after `from`, wrapping to the top when there is
 * none below. `null` when the query finds nothing anywhere or does not compile.
 */
export function nearestMatch(
  state: EditorState,
  query: SearchQuery,
  from: number,
): { readonly from: number; readonly to: number } | null {
  if (query.search === "" || !query.valid) return null;
  const below = query.getCursor(state, from).next();
  const hit = below.done === true ? query.getCursor(state).next() : below;
  return hit.done === true ? null : { from: hit.value.from, to: hit.value.to };
}
