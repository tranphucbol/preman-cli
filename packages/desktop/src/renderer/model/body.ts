/**
 * The windowed view of one response body.
 *
 * The store holds a handle, a byte count and a preview; it never holds the body. This is
 * what stands between that handle and a CodeMirror document: a list of contiguous byte
 * ranges, capped at `VIEWER_RETAINED_BYTES`, that grows forward as the reader reaches the
 * bottom and is replaced outright when they jump. A 50MB response therefore costs the
 * renderer half a megabyte, and a 500MB one costs the same.
 *
 * Two rules make that safe:
 *
 * 1. **Appends must be exact.** The engine aligns both ends of a window off UTF-8
 *    continuation bytes, so a window is only ever appended when its `offset` is precisely
 *    the previous `nextOffset`. Asking for `viewEnd(view)` guarantees that, because that
 *    offset is already on a codepoint boundary. Anything else is a jump and replaces the
 *    view - which is why there is no "prepend" here. Requesting the bytes *before* a
 *    window cannot be made exact (`alignStart` moves forward, so the end can overshoot),
 *    and a splice that is off by two bytes is a corrupted document nobody would suspect.
 * 2. **Never re-derive byte offsets from text.** A JS string is UTF-16 and a body may not
 *    even be valid UTF-8, so re-encoding the preview to learn how long it was would be
 *    wrong for exactly the binary responses that are hardest to debug. Offsets only ever
 *    come from the engine.
 *
 * Everything here is pure. Nothing imports React.
 */
import {
  BODY_FORMAT_LIMIT_BYTES,
  BODY_WINDOW_BYTES,
  type BodyMatch,
  type BodyWindow,
} from "@preman/desktop/engine/protocol.js";
import type { CodeLanguage } from "@preman/desktop/renderer/ui/CodeEditor.js";

import type { ResponseBody } from "./response.js";

/**
 * How much of a body the viewer holds before it starts a new page. Eight windows: long
 * enough that reading a few hundred kilobytes is one uninterrupted scroll, small enough
 * that a 500MB response costs the same as a 500KB one.
 */
export const VIEWER_RETAINED_BYTES = 512 * 1024;

/** How far before a search hit the window starts, so the match is not glued to the top edge. */
const MATCH_LEAD_BYTES = 2 * 1024;

const START_OF_BODY = 0;

export interface BodyChunk {
  readonly offset: number;
  readonly nextOffset: number;
  readonly text: string;
}

export interface BodyView {
  readonly handle: string;
  readonly byteLength: number;
  readonly contentType: string | null;
  /** Contiguous and ascending: `chunks[n].nextOffset === chunks[n + 1].offset`, always. */
  readonly chunks: readonly BodyChunk[];
}

/**
 * The view a `response-body` event alone can support.
 *
 * An untruncated preview *is* the body, so it is used directly and the viewer never calls
 * the engine at all - which is the common case, and the reason a small response paints in
 * one frame. A truncated preview is deliberately thrown away: its byte length is unknowable
 * here (see rule 2), and a view that cannot state its own `nextOffset` cannot be appended
 * to. The pane fetches window zero instead.
 */
export function seedView(body: ResponseBody): BodyView {
  const chunks: BodyChunk[] = body.truncated
    ? []
    : [{ offset: START_OF_BODY, nextOffset: body.byteLength, text: body.preview }];
  return { handle: body.handle, byteLength: body.byteLength, contentType: body.contentType, chunks };
}

/**
 * Fold one window into the view: appended when it continues the last chunk exactly,
 * otherwise it becomes the whole view. An empty window - which is what asking past the end
 * returns - changes nothing, so a reader parked at the bottom cannot spin.
 */
export function extendView(view: BodyView, window: BodyWindow): BodyView {
  if (window.nextOffset <= window.offset) return view;
  const chunk: BodyChunk = { offset: window.offset, nextOffset: window.nextOffset, text: window.text };
  const last = view.chunks.at(-1);
  const appended = last !== undefined && window.offset === last.nextOffset;
  const chunks = appended ? trim([...view.chunks, chunk]) : [chunk];
  // `byteLength` comes from the window rather than the seed: a body can only be published
  // once, but the head is the authority and the window carries it for free.
  return { ...view, byteLength: window.byteLength, chunks };
}

/**
 * Enforce the retention cap.
 *
 * Over the cap the view keeps only the newest window, which turns the reader's continuous
 * scroll into a page turn once every `VIEWER_RETAINED_BYTES`. Dropping windows one at a
 * time instead would be smoother in principle and worse in practice: text disappearing off
 * the top of a document silently moves everything the reader is looking at, whereas a page
 * turn resets the scroll and the range strip says where they now are.
 */
function trim(chunks: readonly BodyChunk[]): BodyChunk[] {
  if (span(chunks) <= VIEWER_RETAINED_BYTES) return [...chunks];
  const last = chunks.at(-1);
  return last === undefined ? [] : [last];
}

function span(chunks: readonly BodyChunk[]): number {
  const first = chunks.at(0);
  const last = chunks.at(-1);
  if (first === undefined || last === undefined) return 0;
  return last.nextOffset - first.offset;
}

export function viewText(view: BodyView): string {
  return view.chunks.map((chunk) => chunk.text).join("");
}

export function viewStart(view: BodyView): number {
  return view.chunks.at(0)?.offset ?? START_OF_BODY;
}

export function viewEnd(view: BodyView): number {
  return view.chunks.at(-1)?.nextOffset ?? START_OF_BODY;
}

/** How many bytes of the body the view is holding on to. The number the memory test watches. */
export function retainedBytes(view: BodyView): number {
  return span(view.chunks);
}

/** True when the view is the entire body, so no strip and no paging controls are needed. */
export function isWhole(view: BodyView): boolean {
  return viewStart(view) === START_OF_BODY && viewEnd(view) >= view.byteLength;
}

export function isEmpty(view: BodyView): boolean {
  return view.chunks.length === 0;
}

/** Where the reader can go. `next` is the only one the viewport triggers on its own. */
export type BodyMove = "next" | "previous" | "start" | "end";

/**
 * The offset to ask the engine for, or `null` when that move would not move.
 *
 * `next` returns `viewEnd`, which is on a codepoint boundary by construction and therefore
 * appends. The other three are jumps and replace the view.
 */
export function requestOffset(view: BodyView, move: BodyMove): number | null {
  const start = viewStart(view);
  const end = viewEnd(view);
  switch (move) {
    case "next":
      return end < view.byteLength ? end : null;
    case "previous":
      return start > START_OF_BODY ? Math.max(START_OF_BODY, start - BODY_WINDOW_BYTES) : null;
    case "start":
      return start > START_OF_BODY ? START_OF_BODY : null;
    case "end":
      return end < view.byteLength ? Math.max(START_OF_BODY, view.byteLength - BODY_WINDOW_BYTES) : null;
  }
}

/** The window to fetch so a search hit lands in view with a little context above it. */
export function offsetForMatch(match: BodyMatch): number {
  return Math.max(START_OF_BODY, match.offset - MATCH_LEAD_BYTES);
}

/**
 * Above the format limit the viewer drops to plain monospace text: a syntax tree over
 * 50MB is what actually freezes a renderer, not the bytes.
 */
export function isHighlightable(view: BodyView): boolean {
  return view.byteLength <= BODY_FORMAT_LIMIT_BYTES;
}

/** Substring rather than exact match, because a content type carries a charset and a suffix. */
const CONTENT_TYPE_LANGUAGE: readonly (readonly [string, CodeLanguage])[] = [
  ["json", "json"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["xml", "xml"],
  ["html", "xml"],
  ["javascript", "javascript"],
  ["ecmascript", "javascript"],
];

const SNIFF_CHARS = 64;
const JSON_OPENERS = new Set(["{", "["]);
const XML_OPENER = "<";
const PLAIN_TEXT: CodeLanguage = "text";

/**
 * What language to hand CodeMirror. The content type decides when it says anything useful;
 * a body with none is sniffed off its first characters, because an API that forgot its
 * `Content-Type` is still the API you have to read.
 */
export function languageFor(contentType: string | null, sample: string): CodeLanguage {
  if (contentType !== null) {
    const lowered = contentType.toLowerCase();
    for (const [hint, language] of CONTENT_TYPE_LANGUAGE) if (lowered.includes(hint)) return language;
  }
  const head = sample.slice(0, SNIFF_CHARS).trimStart();
  const first = head.slice(0, 1);
  if (JSON_OPENERS.has(first)) return "json";
  if (first === XML_OPENER) return "xml";
  return PLAIN_TEXT;
}

/** The language the viewer actually uses, which is plain text once the body is too large. */
export function viewerLanguage(view: BodyView, sample: string): CodeLanguage {
  return isHighlightable(view) ? languageFor(view.contentType, sample) : PLAIN_TEXT;
}

export interface FormatAvailability {
  readonly allowed: boolean;
  /** Empty when allowed. Otherwise the tooltip on the disabled toggle. */
  readonly reason: string;
}

const ALLOWED: FormatAvailability = { allowed: true, reason: "" };

/**
 * Whether to offer the pretty-print toggle at all, and what to say when not.
 *
 * The engine would refuse a body above its own limit, but a disabled control that explains
 * itself beats a click that turns into an error banner. The JSON check is the renderer's
 * alone: `BodyStore.format` hands anything else back unchanged, so offering the toggle
 * there would be offering a button that does nothing.
 */
export function formatAvailability(view: BodyView, sample: string): FormatAvailability {
  if (view.byteLength > BODY_FORMAT_LIMIT_BYTES) {
    return {
      allowed: false,
      reason: `Too large to pretty-print (${formatBytes(view.byteLength)}). The limit is ${formatBytes(BODY_FORMAT_LIMIT_BYTES)} - search it instead.`,
    };
  }
  if (languageFor(view.contentType, sample) !== "json") {
    return { allowed: false, reason: "Only JSON is pretty-printed." };
  }
  return ALLOWED;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;
const BYTES_PER_UNIT = 1024;
const BYTE_PRECISION = 1;
const FIRST_UNIT = 0;
const LAST_UNIT = BYTE_UNITS.length - 1;

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = FIRST_UNIT;
  while (value >= BYTES_PER_UNIT && unit < LAST_UNIT) {
    value /= BYTES_PER_UNIT;
    unit += 1;
  }
  const shown = unit === FIRST_UNIT ? String(value) : value.toFixed(BYTE_PRECISION);
  return `${shown} ${BYTE_UNITS[unit] ?? BYTE_UNITS[LAST_UNIT]}`;
}
