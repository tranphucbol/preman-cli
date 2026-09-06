import { StringDecoder } from "node:string_decoder";

/**
 * One dispatched server-sent event.
 *
 * `event` holds what the stream actually named, so it is empty when the stream named
 * nothing. The specification calls that case `message`; saying so here would put the
 * word "message" on every row of an OpenAI-style stream that never sent the field,
 * which is a claim about the protocol dressed up as a claim about the response.
 */
export interface SseFrame {
  /** 1-based, in dispatch order. */
  readonly seq: number;
  /** Wall clock at the chunk that completed the frame, supplied by the caller. */
  readonly at: number;
  /** The `event:` field, empty when the stream did not send one. */
  readonly event: string;
  /** The `data:` lines, joined by newlines. Never empty: an empty block dispatches nothing. */
  readonly data: string;
  /** The last `id:` seen at or before this frame, empty when the stream never sent one. */
  readonly id: string;
}

const MEDIA_TYPE_END = ";";
const EVENT_STREAM_TYPE = "text/event-stream";

/**
 * Whether a `content-type` names a stream preman should read frame by frame.
 *
 * Parameters are ignored: `text/event-stream; charset=utf-8` is the same media type,
 * and the specification fixes the encoding as UTF-8 regardless of what the charset says.
 */
export function isEventStream(contentType: string | undefined): boolean {
  const [type] = (contentType ?? "").split(MEDIA_TYPE_END);
  return (type ?? "").trim().toLowerCase() === EVENT_STREAM_TYPE;
}

/** Doubles as the comment marker: a line that begins with it has no field name. */
const FIELD_SEPARATOR = ":";
/** One optional space after the separator belongs to the syntax, not to the value. */
const VALUE_PAD = " ";
const EVENT_FIELD = "event";
const DATA_FIELD = "data";
const ID_FIELD = "id";
const DATA_JOIN = "\n";
const CR = "\r";
const LF = "\n";
const BOM = "\ufeff";
const NUL = "\u0000";
const NO_EVENT = "";
const NO_ID = "";
const NO_VALUE = "";
const NOT_FOUND = -1;
const START = 0;
const NO_DATA = 0;
const SINGLE_CHAR = 1;
const CRLF_WIDTH = 2;
const SEQ_STEP = 1;
const UTF8: BufferEncoding = "utf8";

/**
 * An incremental reader for `text/event-stream`, fed the chunks as they land.
 *
 * Written as a parser rather than a split over the finished body because the point of
 * the feature is that there is no finished body to split: a chat completion arrives over
 * seconds and a subscription may never end at all. It therefore has to survive every way
 * a chunk boundary can fall - mid-frame, mid-line, between the two halves of a CRLF, and
 * between the two halves of a UTF-8 codepoint, which is what {@link StringDecoder} is for.
 */
export class SseParser {
  readonly #decoder = new StringDecoder(UTF8);
  #pending = NO_VALUE;
  /** How much of `#pending` is known to hold no line terminator, so it is scanned once. */
  #scanned = START;
  #started = false;
  #event = NO_EVENT;
  #data: string[] = [];
  #id = NO_ID;
  #seq = START;

  /** Read one chunk, returning whatever frames it completed. */
  push(chunk: Buffer, at: number): SseFrame[] {
    return this.#consume(this.#decoder.write(chunk), at, false);
  }

  /**
   * Close the stream, returning the frames the last bytes completed.
   *
   * A block left unterminated by the blank line is dispatched rather than discarded, which
   * the specification does not do. The specification is written for a browser that will
   * reconnect and see the frame again; nothing reconnects here, so discarding it would mean
   * a server that died one newline early looks like a server that sent one frame fewer.
   */
  end(at: number): SseFrame[] {
    const frames = this.#consume(this.#decoder.end(), at, true);
    if (this.#pending !== NO_VALUE) {
      const frame = this.#line(this.#pending, at);
      if (frame !== null) frames.push(frame);
      this.#pending = NO_VALUE;
      this.#scanned = START;
    }
    const trailing = this.#dispatch(at);
    if (trailing !== null) frames.push(trailing);
    return frames;
  }

  #consume(text: string, at: number, final: boolean): SseFrame[] {
    const frames: SseFrame[] = [];
    this.#pending += this.#trimBom(text);
    for (const line of this.#lines(final)) {
      const frame = this.#line(line, at);
      if (frame !== null) frames.push(frame);
    }
    return frames;
  }

  /** Only the very first character of the whole stream can be a byte order mark. */
  #trimBom(text: string): string {
    if (this.#started || text === NO_VALUE) return text;
    this.#started = true;
    return text.startsWith(BOM) ? text.slice(BOM.length) : text;
  }

  #lines(final: boolean): string[] {
    const text = this.#pending;
    const lines: string[] = [];
    let start = START;
    let index = this.#scanned;
    while (index < text.length) {
      const char = text[index];
      if (char !== CR && char !== LF) {
        index += SINGLE_CHAR;
        continue;
      }
      // A CR at the very end may be the first half of a CRLF whose LF is still in flight.
      // Treating it as a terminator now would dispatch on a blank line that does not exist.
      if (char === CR && index === text.length - SINGLE_CHAR && !final) break;
      const width = char === CR && text[index + SINGLE_CHAR] === LF ? CRLF_WIDTH : SINGLE_CHAR;
      lines.push(text.slice(start, index));
      index += width;
      start = index;
    }
    this.#pending = text.slice(start);
    this.#scanned = index - start;
    return lines;
  }

  #line(line: string, at: number): SseFrame | null {
    if (line === NO_VALUE) return this.#dispatch(at);
    // A comment. Keep-alives arrive as `: ping` and would otherwise show up as frames.
    if (line.startsWith(FIELD_SEPARATOR)) return null;

    const separator = line.indexOf(FIELD_SEPARATOR);
    const field = separator === NOT_FOUND ? line : line.slice(START, separator);
    const raw = separator === NOT_FOUND ? NO_VALUE : line.slice(separator + SINGLE_CHAR);
    const value = raw.startsWith(VALUE_PAD) ? raw.slice(SINGLE_CHAR) : raw;

    if (field === EVENT_FIELD) this.#event = value;
    else if (field === DATA_FIELD) this.#data.push(value);
    else if (field === ID_FIELD && !value.includes(NUL)) this.#id = value;
    // `retry` is named so it does not fall through into the data buffer, and then dropped:
    // it sets a reconnection delay, and preman performs one exchange and never reconnects.
    return null;
  }

  #dispatch(at: number): SseFrame | null {
    if (this.#data.length === NO_DATA) {
      // A block with no data - a lone comment, or an `event:` with nothing under it -
      // dispatches nothing, but still spends the type it named.
      this.#event = NO_EVENT;
      return null;
    }
    this.#seq += SEQ_STEP;
    const frame: SseFrame = {
      seq: this.#seq,
      at,
      event: this.#event,
      data: this.#data.join(DATA_JOIN),
      id: this.#id,
    };
    this.#event = NO_EVENT;
    this.#data = [];
    return frame;
  }
}
