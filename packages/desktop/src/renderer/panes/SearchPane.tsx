/**
 * Workspace search, in the sidebar rather than over the editor.
 *
 * In the sidebar because a result list you lose the moment you click a result is a list you have
 * to rebuild for every hit, and the whole reason to search a workspace is that there are several
 * matches worth visiting. The tree and this pane swap; nothing is stacked.
 *
 * Search runs on Enter, not per keystroke. The engine parses every request file to answer, which
 * is what buys the field path on each row, and doing that between two letters would be a search
 * box that punishes typing. `Cmd+Shift+F` is the same commitment made by a shortcut.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useRef } from "react";

import type { GrepMatch } from "@preman/desktop/engine/protocol.js";

import { searchWorkspace } from "@preman/desktop/renderer/actions.js";
import { searchRowHeight } from "@preman/desktop/renderer/appearance/density.js";
import { describeFieldPath } from "@preman/desktop/renderer/model/search.js";
import { useDensity, useRemeasure } from "@preman/desktop/renderer/stores/appearance.js";
import { useNode } from "@preman/desktop/renderer/stores/catalog.js";
import { useSearchStore, type SearchState } from "@preman/desktop/renderer/stores/search.js";
import { Field } from "@preman/desktop/renderer/ui/Controls.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";

const OVERSCAN = 6;

const selectMatches = (state: SearchState) => state.matches;
const selectQuery = (state: SearchState) => state.query;

export interface SearchPaneProps {
  /** Open the file the match is in, on the section the match is in. */
  readonly onOpen: (match: GrepMatch) => void;
}

export function SearchPane({ onOpen }: SearchPaneProps): React.JSX.Element {
  const query = useSearchStore(selectQuery);

  const run = useCallback((next: string) => {
    const store = useSearchStore.getState();
    store.setQuery(next);
    if (next.trim().length === 0) {
      store.settled({ matches: [], truncated: false, warnings: [] });
      return;
    }
    store.started();
    void searchWorkspace(next).then((result) => {
      if (result.ok) store.settled(result.value);
      else store.failed(result.failure.message);
    });
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line p-2">
        <Field
          // Keyed on the committed query so `Cmd+Shift+F` with a query already in flight leaves
          // the box showing what was actually searched for.
          key={query}
          defaultValue={query}
          autoFocus
          placeholder="Search requests, then Enter"
          aria-label="Search the workspace"
          onKeyDown={(event) => {
            if (event.key === "Enter") run(event.currentTarget.value);
          }}
        />
      </div>
      <Summary />
      <Results onOpen={onOpen} />
    </div>
  );
}

/** What the last answer was, above the rows, because "23 results" is the first thing you look for. */
function Summary(): React.JSX.Element | null {
  const running = useSearchStore((state) => state.running);
  const answered = useSearchStore((state) => state.answered);
  const total = useSearchStore((state) => state.matches.length);
  const truncated = useSearchStore((state) => state.truncated);
  const error = useSearchStore((state) => state.error);
  const warnings = useSearchStore((state) => state.warnings);

  if (running) return <Line text="Searching." />;
  if (error !== null) return <Line text={error} tone="danger" />;
  if (!answered) return null;

  return (
    <div className="shrink-0 px-2 py-1">
      <p className="text-2xs text-ink-faint">
        {total === 0 ? "No matches." : `${String(total)} ${total === 1 ? "match" : "matches"}`}
        {truncated ? " (more were found than are shown)" : ""}
      </p>
      {warnings.map((warning) => (
        <p key={warning} className="text-2xs text-warn">
          {warning}
        </p>
      ))}
    </div>
  );
}

function Line({
  text,
  tone = "faint",
}: {
  readonly text: string;
  readonly tone?: "faint" | "danger";
}): React.JSX.Element {
  return (
    <p className={cn("shrink-0 px-2 py-1 text-2xs", tone === "danger" ? "text-danger" : "text-ink-faint")}>{text}</p>
  );
}

function Results({ onOpen }: SearchPaneProps): React.JSX.Element {
  const matches = useSearchStore(selectMatches);
  const scrollRef = useRef<HTMLDivElement>(null);

  /** Two lines: what matched, and where. A one-line row would have to drop one of them. */
  const rowHeight = searchRowHeight(useDensity());
  const virtualizer = useVirtualizer({
    count: matches.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
  });
  useRemeasure(virtualizer, rowHeight);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const match = matches[item.index];
          if (match === undefined) return null;
          return (
            <ResultRow
              key={`${match.nodeId}:${String(match.line)}:${describeFieldPath(match.fieldPath)}:${String(match.offset)}`}
              match={match}
              top={item.start}
              height={rowHeight}
              onOpen={onOpen}
            />
          );
        })}
      </div>
    </div>
  );
}

function ResultRow({
  match,
  top,
  height,
  onOpen,
}: {
  readonly match: GrepMatch;
  readonly top: number;
  readonly height: number;
  readonly onOpen: (match: GrepMatch) => void;
}): React.JSX.Element {
  // Subscribed rather than read once: the file can be renamed while the results are on screen,
  // and a row naming the old file would send the next click somewhere that no longer exists.
  const node = useNode(match.nodeId);

  return (
    <button
      type="button"
      className="absolute inset-x-0 flex flex-col justify-center gap-0.5 px-2 text-left hover:bg-hover"
      style={{ top, height }}
      onClick={() => {
        onOpen(match);
      }}
    >
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate text-xs text-ink">{node?.name ?? match.nodeId}</span>
        <span className="shrink-0 font-mono text-2xs text-ink-faint">{describeFieldPath(match.fieldPath)}</span>
        {/* A key hit and a value hit are different answers, and only one of them is editable text. */}
        {match.where === "key" && <span className="shrink-0 text-2xs text-ink-faint">key</span>}
      </span>
      <span className="truncate font-mono text-2xs text-ink-dim">{match.preview}</span>
    </button>
  );
}
