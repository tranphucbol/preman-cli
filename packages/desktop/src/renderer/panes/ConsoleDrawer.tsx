/**
 * The console drawer.
 *
 * Two things make this cheap enough to leave open during a five thousand request run: the
 * store caps each stream at `CONSOLE_MAX_LINES`, and TanStack Virtual mounts only the rows
 * in the viewport. Rows are measured rather than assumed, because a console that truncates
 * the one line you needed is a console you stop trusting - and measuring only costs what is
 * mounted.
 *
 * `pm.sendRequest` calls are interleaved with the logs by arrival order rather than kept in
 * their own list, and indented under them, so a token refresh appears between the log before
 * it and the log after it. That ordering is the whole reason `seq` exists in the store.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef } from "react";

import { clearConsole } from "@preman/desktop/renderer/actions.js";
import {
  formatDuration,
  levelTone,
  mergeConsole,
  sideRequestStatus,
  toneClass,
  type ConsoleRow,
} from "@preman/desktop/renderer/model/response.js";
import { useRunsStore } from "@preman/desktop/renderer/stores/runs.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { IconButton } from "@preman/desktop/renderer/ui/Controls.js";
import { ClearIcon, CloseIcon } from "@preman/desktop/renderer/ui/icons.js";

/** One line of mono text at 28px, which is what the row is if it does not wrap. */
const ROW_HEIGHT = 28;
const OVERSCAN = 12;
/** Within this of the bottom, the drawer follows new output instead of holding position. */
const FOLLOW_THRESHOLD_PX = 40;
const NO_ROWS = 0;
const EMPTY_HINT = "Script output and pm.sendRequest calls appear here.";

export function ConsoleDrawer({ onClose }: { readonly onClose: () => void }) {
  const lines = useRunsStore((state) => state.console);
  const sideRequests = useRunsStore((state) => state.sideRequests);
  const rows = useMemo(() => mergeConsole(lines, sideRequests), [lines, sideRequests]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Following is a scroll position, not state: it changes on every wheel event and nothing
  // renders differently because of it.
  const pinned = useRef(true);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (index) => rows[index]?.seq ?? index,
  });

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
  if (row.kind === "side-request") {
    const { summary } = row;
    return (
      <div className="flex items-baseline gap-2 py-1 pr-2 pl-8">
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
    <div className="flex items-baseline gap-2 px-2 py-1">
      <span className={cn("w-10 shrink-0 text-2xs", toneClass(levelTone(line.level)))}>{line.level}</span>
      <span className="w-28 shrink-0 truncate text-2xs text-ink-faint">{line.origin.label}</span>
      <span className="min-w-0 font-mono text-2xs break-words whitespace-pre-wrap text-ink">{line.text}</span>
    </div>
  );
}
