/**
 * The command palette: one box that reaches every request, every environment and every command.
 *
 * Built on the Radix `Dialog` this app already has plus TanStack Virtual, not on `cmdk`. cmdk owns
 * the scoring *and* the rendering, and it scores by mounting every item: a workspace with five
 * thousand requests would mount five thousand nodes on the first keystroke, which is exactly what
 * decision 10 exists to prevent. The ranking is in `model/palette.ts` where a test can read it,
 * and the list is virtualized like every other long list in this app.
 *
 * Keyboard-only by design. The pointer works, but the palette exists so that the hand never
 * leaves the keyboard, so Up, Down, Enter and Escape are the whole contract.
 */
import * as Primitive from "@radix-ui/react-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";

import { paletteRowHeight } from "@preman/desktop/renderer/appearance/density.js";
import {
  rankPalette,
  type PaletteItem,
  type PaletteKind,
  type PaletteRow,
} from "@preman/desktop/renderer/model/palette.js";
import { useDensity, useRemeasure } from "@preman/desktop/renderer/stores/appearance.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import {
  CollectionIcon,
  EnvironmentIcon,
  PaletteIcon,
  RequestIcon,
  type Icon,
} from "@preman/desktop/renderer/ui/icons.js";

const OVERLAY_CLASS = "fixed inset-0 z-menu bg-black/50";
const CONTENT_CLASS =
  "fixed left-1/2 top-24 z-menu w-[36rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-lg border border-line-strong bg-panel shadow-2xl shadow-black/60";

const OVERSCAN = 6;
/** The list's own height. Ten rows: enough to choose from, short enough to read at a glance. */
const VISIBLE_ROWS = 10;
const FIRST_ROW = 0;

const KIND_ICON: Record<PaletteKind, Icon> = {
  request: RequestIcon,
  environment: EnvironmentIcon,
  command: PaletteIcon,
  method: CollectionIcon,
};

export interface CommandPaletteProps {
  readonly open: boolean;
  /** Ties are broken by this order, so pass the kinds in the order they should surface. */
  readonly items: readonly PaletteItem[];
  /** What the box says before anything is typed. The picker's only clue about what it picks. */
  readonly placeholder: string;
  /** The dialog's accessible name, since it has no visible title. */
  readonly label: string;
  readonly onDismiss: () => void;
  readonly onChoose: (item: PaletteItem) => void;
}

export function CommandPalette({
  open,
  items,
  placeholder,
  label,
  onDismiss,
  onChoose,
}: CommandPaletteProps): React.JSX.Element {
  return (
    <Primitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <Primitive.Portal>
        <Primitive.Overlay className={OVERLAY_CLASS} />
        <Primitive.Content className={CONTENT_CLASS} aria-describedby={undefined} aria-label={label}>
          <Primitive.Title className="sr-only">{label}</Primitive.Title>
          {/* Mounted only while open, so the query and the highlight start fresh every time. */}
          {open && <Body items={items} placeholder={placeholder} onDismiss={onDismiss} onChoose={onChoose} />}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

function Body({
  items,
  placeholder,
  onDismiss,
  onChoose,
}: {
  readonly items: readonly PaletteItem[];
  readonly placeholder: string;
  readonly onDismiss: () => void;
  readonly onChoose: (item: PaletteItem) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(FIRST_ROW);
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => rankPalette(items, query), [items, query]);

  const rowHeight = paletteRowHeight(useDensity());
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
  });
  useRemeasure(virtualizer, rowHeight);

  // The highlight has to be inside the viewport for the arrow keys to be navigation rather than
  // a game of guessing which invisible row is selected.
  useEffect(() => {
    if (rows.length > 0) virtualizer.scrollToIndex(active);
  }, [active, rows.length, virtualizer]);

  function choose(index: number): void {
    const row = rows[index];
    if (row === undefined) return;
    onDismiss();
    onChoose(row.item);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, rows.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, FIRST_ROW));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(active);
    }
  }

  return (
    <>
      <input
        autoFocus
        spellCheck={false}
        value={query}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full border-b border-line bg-transparent px-3 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(FIRST_ROW);
        }}
        onKeyDown={onKeyDown}
      />
      {rows.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-ink-faint">Nothing matches.</p>
      ) : (
        <div
          ref={scrollRef}
          className="overflow-y-auto overscroll-contain"
          style={{ height: Math.min(rows.length, VISIBLE_ROWS) * rowHeight }}
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (row === undefined) return null;
              return (
                <PaletteRowView
                  key={`${row.item.kind}:${row.item.id}`}
                  row={row}
                  top={item.start}
                  height={rowHeight}
                  active={item.index === active}
                  onChoose={() => {
                    choose(item.index);
                  }}
                />
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

function PaletteRowView({
  row,
  top,
  height,
  active,
  onChoose,
}: {
  readonly row: PaletteRow;
  readonly top: number;
  readonly height: number;
  readonly active: boolean;
  readonly onChoose: () => void;
}): React.JSX.Element {
  const Icon = KIND_ICON[row.item.kind];
  return (
    <button
      type="button"
      className={cn(
        "absolute inset-x-0 flex items-center gap-2 px-3 text-left",
        active ? "bg-selected" : "hover:bg-hover",
      )}
      style={{ top, height }}
      // `onMouseDown` rather than `onClick`: the input holds focus, and a click would blur it
      // first, which on some platforms closes the dialog before the choice lands.
      onMouseDown={(event) => {
        event.preventDefault();
        onChoose();
      }}
    >
      <Icon className="shrink-0 text-ink-faint" />
      <span className="min-w-0 flex-1 truncate text-xs text-ink">
        <Highlighted label={row.item.label} hits={row.hits} />
      </span>
      {row.item.detail !== undefined && (
        <span className="max-w-56 shrink-0 truncate font-mono text-2xs text-ink-faint">
          <Highlighted label={row.item.detail} hits={row.detailHits} />
        </span>
      )}
    </button>
  );
}

/**
 * The matched characters, emphasised.
 *
 * Not decoration: a subsequence match is often not obvious from the result alone, and showing
 * which letters were used is what makes a fuzzy list trustworthy rather than magic.
 */
function Highlighted({ label, hits }: { readonly label: string; readonly hits: readonly number[] }): React.JSX.Element {
  if (hits.length === 0) return <>{label}</>;
  const marked = new Set(hits);
  return (
    <>
      {[...label].map((character, index) =>
        marked.has(index) ? (
          // The index is the identity here: two identical letters in one label are two positions.
          <span key={index} className="font-medium text-accent">
            {character}
          </span>
        ) : (
          <span key={index}>{character}</span>
        ),
      )}
    </>
  );
}
