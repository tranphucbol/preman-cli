import { EXIT, PremanError } from "@preman/core/errors.js";

/** How much of a body travels with the `response-body` event, unasked. */
const PREVIEW_BYTES = 256 * 1024;
/**
 * Above this, pretty-printing costs more than it is worth and is refused.
 *
 * Exported because a front end has to know the limit before it offers the toggle: asking
 * and being refused is a worse experience than a disabled control that says why.
 */
export const FORMAT_LIMIT_BYTES = 2 * 1024 * 1024;
/** How many bodies one store keeps. LRU, so the oldest handle goes first. */
const BODY_RETENTION = 20;
const SEARCH_MATCH_LIMIT = 500;
/** How much of a matching line comes back with a search hit. */
const SEARCH_PREVIEW_CHARS = 200;

const HANDLE_PREFIX = "body-";
const FIRST_HANDLE = 1;
const LINE_FEED = 0x0a;
const FIRST_LINE = 1;
const JSON_INDENT = 2;
const ENCODING = "utf8";
const NOT_FOUND = -1;

/**
 * A UTF-8 continuation byte is `10xxxxxx`. Slicing on one splits a codepoint and
 * produces a replacement character, so both ends of every window are aligned off them.
 */
const CONTINUATION_MASK = 0b1100_0000;
const CONTINUATION_MARK = 0b1000_0000;

export interface BodyHead {
  byteLength: number;
  contentType: string | null;
}

export interface BodyWindow {
  text: string;
  /** Byte offset the window actually starts at, after alignment. */
  offset: number;
  /** Byte offset to ask for next; equals `byteLength` when `eof`. */
  nextOffset: number;
  /** Total size of the whole body, not of this window. */
  byteLength: number;
  eof: boolean;
}

export interface BodyMatch {
  /** Byte offset of the match, in the same space as {@link BodyWindow.offset}. */
  offset: number;
  line: number;
  preview: string;
}

/** Everything the `response-body` event needs, in one call. */
export interface BodyPublication extends BodyHead {
  handle: string;
  preview: string;
  truncated: boolean;
}

interface Entry {
  bytes: Buffer;
  contentType: string | null;
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & CONTINUATION_MASK) === CONTINUATION_MARK;
}

/** Move forward off a continuation byte, so the window starts on a codepoint. */
function alignStart(bytes: Buffer, at: number): number {
  let start = at;
  while (start < bytes.length && isContinuation(bytes[start])) start += 1;
  return start;
}

/**
 * Move back off a partial trailing codepoint, so the window ends on a boundary.
 *
 * A byte at `at` that is a continuation means the sequence it belongs to runs past
 * the requested end, so the whole sequence is left for the next window.
 */
function alignEnd(bytes: Buffer, at: number): number {
  if (at >= bytes.length) return bytes.length;
  let end = at;
  while (end > 0 && isContinuation(bytes[end])) end -= 1;
  return end;
}

function countLineFeeds(bytes: Buffer, from: number, to: number): number {
  let seen = 0;
  for (let at = from; at < to; at += 1) if (bytes[at] === LINE_FEED) seen += 1;
  return seen;
}

/**
 * Response bodies, held where the engine runs and handed out a window at a time.
 *
 * One per engine host. The point is that a 50MB response is paid for once, in the
 * process that already received it, and the viewer in front of it stays constant in
 * memory however large the body is.
 */
export class BodyStore {
  /** Insertion-ordered, and re-inserted on read, which makes it the LRU order. */
  private readonly entries = new Map<string, Entry>();
  private nextHandle = FIRST_HANDLE;

  /** How many bodies are currently retained. */
  get size(): number {
    return this.entries.size;
  }

  put(bytes: Buffer, contentType: string | null): string {
    const handle = `${HANDLE_PREFIX}${this.nextHandle}`;
    this.nextHandle += 1;
    this.entries.set(handle, { bytes, contentType });
    this.evict();
    return handle;
  }

  /** Store a body and describe it, which is exactly what one `response-body` needs. */
  publish(bytes: Buffer, contentType: string | null): BodyPublication {
    const handle = this.put(bytes, contentType);
    const first = this.window(handle, 0, PREVIEW_BYTES);
    return {
      handle,
      byteLength: bytes.length,
      contentType,
      preview: first.text,
      truncated: !first.eof,
    };
  }

  head(handle: string): BodyHead {
    const entry = this.require(handle);
    return { byteLength: entry.bytes.length, contentType: entry.contentType };
  }

  window(handle: string, offset: number, length: number): BodyWindow {
    const { bytes } = this.require(handle);
    const start = alignStart(bytes, Math.min(Math.max(offset, 0), bytes.length));
    const end = alignEnd(bytes, Math.min(start + Math.max(length, 0), bytes.length));
    return {
      text: bytes.subarray(start, end).toString(ENCODING),
      offset: start,
      nextOffset: end,
      byteLength: bytes.length,
      eof: end >= bytes.length,
    };
  }

  /**
   * Find `query` in the body and report byte offsets.
   *
   * Runs here rather than in the viewer because the viewer only ever holds one
   * window, and searching what you can see is not searching.
   */
  search(handle: string, query: string, limit: number = SEARCH_MATCH_LIMIT): BodyMatch[] {
    const { bytes } = this.require(handle);
    if (query.length === 0 || limit <= 0) return [];
    const needle = Buffer.from(query, ENCODING);
    const matches: BodyMatch[] = [];
    let line = FIRST_LINE;
    let counted = 0;
    let from = 0;

    while (matches.length < limit) {
      const at = bytes.indexOf(needle, from);
      if (at === NOT_FOUND) break;
      line += countLineFeeds(bytes, counted, at);
      counted = at;
      matches.push({ offset: at, line, preview: this.lineAt(bytes, at) });
      // Advance past this match so an empty or overlapping needle cannot loop.
      from = at + Math.max(needle.length, 1);
    }
    return matches;
  }

  /**
   * Pretty-print the body.
   *
   * JSON only. An XML or HTML body comes back unchanged rather than reformatted by a
   * guess, because a wrong reformat of a payload someone is about to paste into a bug
   * report is worse than no reformat at all.
   */
  format(handle: string): string {
    const { bytes } = this.require(handle);
    if (bytes.length > FORMAT_LIMIT_BYTES) {
      throw new PremanError(`this response is too large to pretty-print (${bytes.length} bytes)`, {
        exitCode: EXIT.CLI,
        details: [`the limit is ${FORMAT_LIMIT_BYTES} bytes`, "view it as plain text, or search it instead"],
      });
    }
    const text = bytes.toString(ENCODING);
    try {
      return JSON.stringify(JSON.parse(text), null, JSON_INDENT);
    } catch {
      return text;
    }
  }

  release(handle: string): void {
    this.entries.delete(handle);
  }

  private lineAt(bytes: Buffer, at: number): string {
    const before = bytes.lastIndexOf(LINE_FEED, at);
    const start = before === NOT_FOUND ? 0 : before + 1;
    const after = bytes.indexOf(LINE_FEED, at);
    const end = after === NOT_FOUND ? bytes.length : after;
    return bytes.subarray(start, end).toString(ENCODING).slice(0, SEARCH_PREVIEW_CHARS);
  }

  /**
   * A handle the store no longer holds is a normal outcome, not a bug: retention is
   * bounded, so a viewer left open on an old response has to be told, not guessed for.
   */
  private require(handle: string): Entry {
    const entry = this.entries.get(handle);
    if (entry === undefined) {
      throw new PremanError(`response body ${handle} is no longer available`, {
        exitCode: EXIT.CLI,
        details: [`the last ${BODY_RETENTION} response bodies are kept`, "send the request again to see it"],
      });
    }
    // Re-insert to move it to the back, which is what makes the eviction order LRU.
    this.entries.delete(handle);
    this.entries.set(handle, entry);
    return entry;
  }

  private evict(): void {
    while (this.entries.size > BODY_RETENTION) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      this.entries.delete(oldest.value);
    }
  }
}
