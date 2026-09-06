/**
 * A streamed response, as the events it arrived in.
 *
 * The Body tab shows this instead of the document viewer when the response was a
 * `text/event-stream`, because a stream has no document: concatenating four hundred completion
 * chunks into one buffer and pretty-printing it produces something no server ever sent. What the
 * reader needs is the frames, in order, with the time each one landed.
 *
 * Newest first, which is the one layout decision here worth stating. A stream is read at its end
 * - the last token is the one you are waiting for - and putting the end at the top means the
 * list follows a live stream by doing nothing at all. The console does the opposite and has to
 * chase the bottom with `scrollToIndex` on every line; this list has no such code because it does
 * not need any.
 *
 * The raw bytes are still in the engine behind the body handle, and `docs/decisions/052` says why
 * both views exist rather than one.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useMemo, useRef, useState } from "react";

import { formatBytes } from "@preman/desktop/renderer/model/body.js";
import type { ResponseFrame } from "@preman/desktop/renderer/model/response.js";
import {
  frameCountLabel,
  frameDetailLines,
  framePretty,
  frameSummary,
  frameTime,
} from "@preman/desktop/renderer/model/stream.js";
import { useDensityTokens, useRemeasure } from "@preman/desktop/renderer/stores/appearance.js";
import type { StreamState } from "@preman/desktop/renderer/stores/runs.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { CodeEditor } from "@preman/desktop/renderer/ui/CodeEditor.js";
import { editorBoxHeight } from "@preman/desktop/renderer/ui/editorTheme.js";
import { CaretRightIcon, GLYPH_CLASS, InboundIcon } from "@preman/desktop/renderer/ui/icons.js";

const OVERSCAN = 12;
const NO_FRAMES = 0;
const CARET_SIZE = 12;
/** The direction arrow, sized with the caret rather than with the text: both are row furniture. */
const ARROW_SIZE = 12;
const WAITING_HINT = "Waiting for the first event…";
const EMPTY_HINT = "The stream closed without sending an event.";
const OPEN_LABEL = "Streaming";
const CLOSED_LABEL = "Connection closed";
/** The timestamp column, wide enough for `HH:MM:SS.mmm` and fixed so the times line up. */
const TIME_COLUMN = "w-[6.5rem]";

export function StreamViewer({
  stream,
  contentType,
}: {
  readonly stream: StreamState;
  readonly contentType: string | null;
}) {
  // Newest first. The store appends, because that is the order the wire has and the order the
  // window trims from; reversing is this pane's business and nobody else's.
  const rows = useMemo(() => [...stream.frames].reverse(), [stream.frames]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = useCallback((seq: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(seq)) next.add(seq);
      return next;
    });
  }, []);

  /** One line of mono text, until a row is expanded and measured. */
  const rowHeight = useDensityTokens().row;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    // The dispatch sequence, so an expanded row keeps its identity as frames arrive above it.
    getItemKey: (index) => rows[index]?.seq ?? index,
  });
  useRemeasure(virtualizer, rowHeight);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-tab shrink-0 items-center gap-2 border-b border-line px-2">
        <span className="truncate font-mono text-2xs text-ink-dim">{contentType ?? "text/event-stream"}</span>
        <span className="text-2xs text-ink-faint">{frameCountLabel(rows.length, stream.total)}</span>
        <span className="text-2xs text-ink-faint">{formatBytes(stream.byteLength)}</span>
        <div className="flex-1" />
        <span className={cn("shrink-0 text-2xs", stream.open ? "text-ok" : "text-ink-faint")}>
          {stream.open ? OPEN_LABEL : CLOSED_LABEL}
        </span>
      </div>

      {/* Why a stream stopped before its server closed it is the pane's most important line when
          it exists, so it is stated once at the top rather than attached to the last frame - the
          last frame arrived fine, and blaming it would be wrong. */}
      {stream.cutShort !== null && (
        <p className="shrink-0 border-b border-line px-2 py-1.5 text-2xs text-warn">{stream.cutShort}</p>
      )}

      {rows.length === NO_FRAMES ? (
        <p className="p-gutter text-xs text-ink-faint">{stream.open ? WAITING_HINT : EMPTY_HINT}</p>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const frame = rows[item.index];
              if (frame === undefined) return null;
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${String(item.start)}px)` }}
                >
                  <FrameRow frame={frame} open={expanded.has(frame.seq)} onToggle={toggle} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One frame.
 *
 * The whole row is the disclosure, unlike the console's call row, because a frame has nowhere
 * else to send the reader: there is no deeper pane for it and no second action to compete with.
 * Both glyphs are inside the button for the same reason.
 *
 * The arrow leads and the caret trails, which is the opposite of every other list here. It is the
 * one layout in the app where the left edge is not a disclosure: an arrow saying the row came down
 * the wire is a fact about the frame, and a caret is a control, so the fact takes the reading
 * position and the control goes to the end of the row where the reader's hand already is after the
 * timestamp. The caret still turns the way every other caret in the app turns.
 */
function FrameRow({
  frame,
  open,
  onToggle,
}: {
  readonly frame: ResponseFrame;
  readonly open: boolean;
  readonly onToggle: (seq: number) => void;
}) {
  return (
    <div className="border-b border-line/50">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          onToggle(frame.seq);
        }}
        className="flex h-row w-full items-center gap-2 px-2 text-left hover:bg-hover"
      >
        {/* Accent as ink, never as a fill: the one filled accent per pane is Send. */}
        <InboundIcon size={ARROW_SIZE} className="shrink-0 text-accent" />
        {/* An unnamed event is the overwhelming majority, and a column reading `message` on every
            row of a completion stream is a column that says nothing. Named events get the space. */}
        {frame.event !== "" && <span className="shrink-0 font-mono text-2xs text-accent">{frame.event}</span>}
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink">{frameSummary(frame.data)}</span>
        <span className={cn("shrink-0 text-right font-mono text-2xs text-ink-faint", TIME_COLUMN)}>
          {frameTime(frame.at)}
        </span>
        <CaretRightIcon
          size={CARET_SIZE}
          className={cn(
            "shrink-0 transition-transform duration-(--duration-glyph) ease-out",
            GLYPH_CLASS,
            open && "rotate-90",
          )}
        />
      </button>
      {open && <FrameDetail frame={frame} />}
    </div>
  );
}

/**
 * The frame, in the app's editor rather than in a `<pre>`.
 *
 * A completion chunk is nested JSON, and the thing a reader opens a frame to do is find one field
 * in it - which is line numbers, syntax colour, folding and `Cmd+F`, all of which the editor
 * already has and none of which a `<pre>` will ever have. It is the same editor as the request
 * body and the response viewer, so the keymap learned in one works here (decision 16).
 *
 * Read-only, and with no `onCommit`: there is nothing to save. A frame is a record of something
 * that already happened.
 *
 * The height is stated rather than measured. `CodeEditor` fills a sized parent - it is `flex-1`
 * and has no intrinsic height - so inside a virtualized row, whose parent is sized by its content,
 * it would collapse to nothing. `frameDetailLines` counts what the box has to hold and
 * `editorBoxHeight` turns that into a `calc` over the editor's own font-size variable, so the row
 * reports a stable height the moment it mounts and still tracks the reader's font size.
 */
function FrameDetail({ frame }: { readonly frame: ResponseFrame }) {
  const pretty = framePretty(frame.data);
  const text = pretty ?? frame.data;
  return (
    <div className="flex flex-col gap-1 px-2 pt-0.5 pb-2 pl-6">
      {frame.id !== "" && (
        <p className="font-mono text-2xs text-ink-faint">
          id: <span className="text-ink-dim">{frame.id}</span>
        </p>
      )}
      <div
        className="flex flex-col overflow-hidden rounded-sm border border-line bg-canvas"
        style={{ height: editorBoxHeight(frameDetailLines(text)) }}
      >
        {/* `json` and not `json-template`: this came off the wire, so there is nothing left in it
            to resolve. */}
        <CodeEditor value={text} language={pretty === null ? "text" : "json"} readOnly />
      </div>
    </div>
  );
}
