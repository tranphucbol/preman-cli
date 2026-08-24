/**
 * The console drawer.
 *
 * Two things make this cheap enough to leave open during a five thousand request run: the
 * store caps each stream at `CONSOLE_MAX_LINES`, and TanStack Virtual mounts only the rows
 * in the viewport. Rows are measured rather than assumed, because a console that truncates
 * the one line you needed is a console you stop trusting - and measuring only costs what is
 * mounted.
 *
 * The three streams - main calls, script logs and `pm.sendRequest` calls - are interleaved by
 * arrival order rather than kept in their own lists, and the call parents the two things it
 * caused, so a token refresh appears between the log before it and the log after it and both
 * appear under the request that ran them. That ordering is the whole reason `seq` exists in
 * the store.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef } from "react";

import { clearConsole } from "@preman/desktop/renderer/actions.js";
import { formatBytes } from "@preman/desktop/renderer/model/body.js";
import {
  callStatus,
  clampBody,
  durationOf,
  formatDuration,
  levelTone,
  mergeConsole,
  sideRequestStatus,
  statusTone,
  toneClass,
  type ConsoleRow,
  type HeaderPairs,
  type SentRequest,
} from "@preman/desktop/renderer/model/response.js";
import { useDensityTokens, useRemeasure } from "@preman/desktop/renderer/stores/appearance.js";
import {
  useCallExpanded,
  useRequestItem,
  useRunsStore,
  type RequestRun,
} from "@preman/desktop/renderer/stores/runs.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { IconButton } from "@preman/desktop/renderer/ui/Controls.js";
import { CaretRightIcon, ClearIcon, CloseIcon, GLYPH_CLASS } from "@preman/desktop/renderer/ui/icons.js";
import { AnimatePresence, m } from "@preman/desktop/renderer/ui/motion.js";

const OVERSCAN = 12;
/** Within this of the bottom, the drawer follows new output instead of holding position. */
const FOLLOW_THRESHOLD_PX = 40;
const NO_ROWS = 0;
const EMPTY_HINT = "Every request sent, script log and pm.sendRequest call appears here, in order.";
/** A call row is the outer level; everything it caused is one level in. Two levels, not three:
 * a side request is caused by a script which is caused by the call, but three indents inside a
 * 28px row leaves no room for a URL, and a side-request row is already its own layout. */
const CALL_INDENT = "px-2";
const CAUSED_INDENT = "py-1 pr-2 pl-8";
/** The caret is a non-text control, so it takes `text-glyph` at 3:1 rather than an ink tier. */
const CARET_SIZE = 12;
/**
 * The call detail opens and shuts by height, in both directions - a disclosure that opens smoothly
 * and closes instantly reads as a bug rather than as speed, and this is the app's first exit
 * animation outside a banner.
 *
 * `height: "auto"` is a measured animation, which means the row's own `ResizeObserver` (the
 * `virtualizer.measureElement` ref below) fires once per frame while it runs, and every row under
 * it gets a new `start`. Those are transform writes, the cheap kind, but the observer callback is
 * main-thread work at ~60Hz for 150ms. That is the price of this one, paid knowingly: the console
 * carries no perf budget, and if a full drawer stutters the fix is to drop the height and keep the
 * opacity, not to work around the virtualizer. Decision 26, as amended by plan 019.
 *
 * Nothing asks Motion for `layout` on the row itself, so the absolute `translateY` the virtualizer
 * owns stays the virtualizer's.
 */
const DETAIL_SHUT = { height: 0, opacity: 0 } as const;
const DETAIL_OPEN = { height: "auto", opacity: 1 } as const;
const DETAIL_TIMING = { duration: 0.15, ease: [0.23, 1, 0.32, 1] } as const;

const JSON_INDENT = 2;
const NO_TEXT = "";
const NO_PAIRS = 0;

export function ConsoleDrawer({ onClose }: { readonly onClose: () => void }) {
  const lines = useRunsStore((state) => state.console);
  const sideRequests = useRunsStore((state) => state.sideRequests);
  const calls = useRunsStore((state) => state.calls);
  const rows = useMemo(() => mergeConsole(lines, sideRequests, calls), [lines, sideRequests, calls]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Following is a scroll position, not state: it changes on every wheel event and nothing
  // renders differently because of it.
  const pinned = useRef(true);

  /** One line of mono text, which is what the row is if it does not wrap. */
  const rowHeight = useDensityTokens().row;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    getItemKey: (index) => rows[index]?.seq ?? index,
  });
  useRemeasure(virtualizer, rowHeight);

  const last = rows.length - 1;
  useEffect(() => {
    if (pinned.current && rows.length > NO_ROWS) virtualizer.scrollToIndex(last);
  }, [last, rows.length, virtualizer]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-tab shrink-0 items-center gap-2 border-b border-line px-2">
        <span className="text-2xs tracking-wide text-ink-dim uppercase">Console</span>
        {rows.length > NO_ROWS && <span className="text-2xs text-ink-faint">{String(rows.length)}</span>}
        <div className="flex-1" />
        <IconButton label="Clear the console" onClick={clearConsole}>
          <ClearIcon />
        </IconButton>
        <IconButton label="Hide the console" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>

      {rows.length === NO_ROWS ? (
        <p className="p-gutter text-xs text-ink-faint">{EMPTY_HINT}</p>
      ) : (
        <div
          ref={scrollRef}
          onScroll={(scroll) => {
            const element = scroll.currentTarget;
            pinned.current = element.scrollHeight - (element.scrollTop + element.clientHeight) <= FOLLOW_THRESHOLD_PX;
          }}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (row === undefined) return null;
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${String(item.start)}px)` }}
                >
                  <Row row={row} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ row }: { readonly row: ConsoleRow }) {
  if (row.kind === "call") return <CallRow row={row} />;

  if (row.kind === "side-request") {
    const { summary } = row;
    return (
      <div className={cn("flex items-baseline gap-2", CAUSED_INDENT)}>
        <span className={cn("shrink-0 font-mono text-2xs", summary.ok ? "text-ok" : "text-danger")}>
          {summary.method}
        </span>
        <span className="min-w-0 font-mono text-2xs break-all text-ink-dim">{summary.url}</span>
        <span className="ml-auto shrink-0 font-mono text-2xs text-ink-faint">{sideRequestStatus(summary)}</span>
        <span className="shrink-0 text-2xs text-ink-faint">{formatDuration(summary.durationMs)}</span>
      </div>
    );
  }

  const { line } = row;
  return (
    <div className={cn("flex items-baseline gap-2", CAUSED_INDENT)}>
      <span className={cn("w-10 shrink-0 text-2xs", toneClass(levelTone(line.level)))}>{line.level}</span>
      <span className="w-28 shrink-0 truncate text-2xs text-ink-faint">{line.origin.label}</span>
      <span className="min-w-0 font-mono text-2xs break-words whitespace-pre-wrap text-ink">{line.text}</span>
    </div>
  );
}

/**
 * The call the reader pressed Send for.
 *
 * It subscribes to its own item rather than reading the map, for the same reason a runner row
 * does: a response landing on the four-thousandth call of a run must repaint one row.
 *
 * Two affordances in one row, deliberately. The caret expands in place, which survives the
 * engine evicting the body; clicking the rest focuses the response pane, which is the deep
 * viewer. Neither is a substitute for the other, and both are one click away.
 */
function CallRow({ row }: { readonly row: Extract<ConsoleRow, { kind: "call" }> }) {
  const item = useRequestItem(row.itemKey);
  const expanded = useCallExpanded(row.itemKey);
  if (item === undefined) return null;

  const status = callStatus(item.head);
  const ms = durationOf(item.head);
  const head = item.head;
  return (
    <div className={CALL_INDENT}>
      <div className="flex items-baseline gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse this call" : "Expand this call"}
          onClick={() => {
            useRunsStore.getState().toggleCall(row.itemKey);
          }}
          className={cn("shrink-0 self-center", GLYPH_CLASS)}
        >
          {/*
            The same turning caret as the sidebar's, for the same reason `Menu.tsx` shares one
            `CONTENT_CLASS`: two disclosure carets that behave differently teach the reader there
            are two kinds of disclosure.
          */}
          <CaretRightIcon
            size={CARET_SIZE}
            className={cn("transition-transform duration-(--duration-glyph) ease-out", expanded && "rotate-90")}
          />
        </button>
        <button
          type="button"
          onClick={() => {
            useRunsStore.getState().focus(row.runId, row.itemKey);
          }}
          className="flex min-w-0 flex-1 items-baseline gap-2 py-1 text-left"
        >
          <span className="min-w-0 font-mono text-2xs break-all text-ink">{item.target ?? item.name}</span>
          {status !== null && head !== null && (
            <span className={cn("ml-auto shrink-0 font-mono text-2xs", toneClass(statusTone(head.status)))}>
              {status}
            </span>
          )}
          {ms !== null && <span className="shrink-0 text-2xs text-ink-faint">{formatDuration(ms)}</span>}
        </button>
      </div>
      <AnimatePresence>
        {expanded && (
          /* The wrapper animates, not `CallDetail`'s own root: that root is a padded flex column,
           * and a box whose padding is part of its height is the version that jumps on the last
           * frame. `overflow-hidden` has nothing to fight. */
          <m.div
            className="overflow-hidden"
            initial={DETAIL_SHUT}
            animate={DETAIL_OPEN}
            exit={DETAIL_SHUT}
            transition={DETAIL_TIMING}
          >
            <CallDetail item={item} row={row} />
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * What the call actually was, repeated here rather than only in the response pane.
 *
 * `BODY_RETENTION` in the engine means the pane cannot show the body of a call from earlier in
 * a long run, while the preview arrived inline on the event and is retained. Expansion survives
 * eviction; focus does not. Decision 24 records what the duplication costs.
 */
function CallDetail({ item, row }: { readonly item: RequestRun; readonly row: Extract<ConsoleRow, { kind: "call" }> }) {
  const sent = item.sent;
  const head = item.head;
  const body = item.body;
  const reveal = () => {
    useRunsStore.getState().focus(row.runId, row.itemKey);
  };
  return (
    <div className="flex flex-col gap-1.5 pt-0.5 pb-2 pl-5">
      {sent !== null && <Pairs label={sentPairsLabel(sent)} pairs={sentPairs(sent)} />}
      {sent !== null && <Body label="Request body" text={sentBody(sent)} onReveal={reveal} />}
      {head !== null && <Pairs label="Response headers" pairs={head.headers} />}
      {body !== null && (
        <Body
          label="Response body"
          text={body.preview}
          bytes={body.byteLength}
          truncated={body.truncated}
          onReveal={reveal}
        />
      )}
    </div>
  );
}

/** Request headers for HTTP and metadata for gRPC: one table under whichever name is true. */
function sentPairsLabel(sent: SentRequest): string {
  return sent.protocol === "http" ? "Request headers" : "Request metadata";
}

function sentPairs(sent: SentRequest): HeaderPairs {
  return sent.protocol === "http" ? sent.headers : sent.metadata;
}

function sentBody(sent: SentRequest): string {
  if (sent.protocol === "http") return sent.body ?? NO_TEXT;
  return JSON.stringify(sent.message, null, JSON_INDENT) ?? NO_TEXT;
}

function Pairs({ label, pairs }: { readonly label: string; readonly pairs: HeaderPairs }) {
  if (pairs.length === NO_PAIRS) return null;
  return (
    <section>
      <h3 className="text-2xs text-ink-dim">{label}</h3>
      {pairs.map(([key, value], index) => (
        <p key={`${key}:${String(index)}`} className="font-mono text-2xs break-all text-ink">
          <span className="text-ink-faint">{key}: </span>
          {value}
        </p>
      ))}
    </section>
  );
}

/**
 * A body, clamped. The footer is the escape hatch rather than a truncation the reader has to
 * guess at: the console owns the bounded view and the response pane keeps the windowed one.
 */
function Body({
  label,
  text,
  bytes,
  truncated = false,
  onReveal,
}: {
  readonly label: string;
  readonly text: string;
  readonly bytes?: number;
  readonly truncated?: boolean;
  readonly onReveal: () => void;
}) {
  const clamped = clampBody(text);
  if (clamped.totalLines === NO_PAIRS) return null;
  return (
    <section>
      <h3 className="text-2xs text-ink-dim">
        {label}
        {bytes !== undefined && <span className="text-ink-faint"> · {formatBytes(bytes)}</span>}
      </h3>
      <pre className="font-mono text-2xs break-all whitespace-pre-wrap text-ink">{clamped.text}</pre>
      {clamped.clamped && (
        <button type="button" onClick={onReveal} className="text-2xs text-ink-faint hover:text-ink">
          {`${clamped.shownLines.toLocaleString()} of ${truncated ? "more than " : ""}${clamped.totalLines.toLocaleString()} lines`}
        </button>
      )}
    </section>
  );
}
