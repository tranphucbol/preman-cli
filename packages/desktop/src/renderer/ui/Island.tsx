/**
 * One of the shell's panes — the sidebar, the editor, the console — as an island on the frame.
 *
 * The same `<div>` under both window styles, and only its classes differ, so switching the style in
 * Settings never remounts what is inside: the editor keeps its cursor, the tree its scroll. Under
 * Classic it is a plain column that adds nothing to the layout the panes had before it existed.
 *
 * Under Islands it is a rounded `canvas` card. Three things about it are deliberate:
 *
 * - **It re-points `--color-panel` to canvas.** An island shares the editor's surface, so the
 *   sidebar and the console, which paint `bg-panel`, draw on canvas inside one without either of
 *   them asking which style is on. Decision 58.
 * - **Its edge is a border, not a ring.** `border-box` keeps the edge inside the island's own box,
 *   so it moves every sidebar row by the same pixel and the column invariant holds; an inset ring
 *   would be painted under the rows' own backgrounds and vanish behind every selected one, which in
 *   the four themes whose edge is `line` is the only separation there is.
 * - **It clips, so focus outlines inside it draw inward.** The corner is an `overflow-hidden`
 *   clip, and the app's 2px outline sits 1px outside whatever it rings; at the island's edge that
 *   would be cut in half. `-outline-offset-2` puts it wholly inside the focused element instead.
 */
import type { ReactNode } from "react";

import { useIslands } from "@preman/desktop/renderer/stores/appearance.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";

/**
 * The column every shell pane already was: a flex child that fills its panel and lays its own
 * children out top to bottom, so a pane's rows lay out exactly as they did with no island around it.
 */
const COLUMN_CLASS = "flex min-h-0 min-w-0 flex-1 flex-col";

/** Whole class names, so Tailwind finds them when it scans the source. */
export const ISLAND_SURFACE = cn(
  COLUMN_CLASS,
  "overflow-hidden rounded-island border border-island-edge bg-canvas [--color-panel:var(--color-canvas)] [&_:focus-visible]:-outline-offset-2",
);

const CLASSIC_SURFACE = COLUMN_CLASS;

/**
 * The surface of the chrome that sits on the frame — the title bar and the status bar under Islands.
 * Their `bg-panel` reads as the frame and their buttons' `bg-hover` as `frame-raised`, and every
 * descendant inherits the remap, so the controls in them need no variant of their own.
 */
export const FRAME_SURFACE = "bg-panel [--color-panel:var(--color-frame)] [--color-hover:var(--color-frame-raised)]";

export interface IslandProps {
  readonly children: ReactNode;
  /** Classes for both styles, merged last: where this island sits in the shell rather than what it is. */
  readonly className?: string | undefined;
}

/** Which classes an island wears; pure so the choice is testable without a window. */
export function islandClass(islands: boolean, className?: string): string {
  return cn(islands ? ISLAND_SURFACE : CLASSIC_SURFACE, className);
}

export function Island({ children, className }: IslandProps): React.JSX.Element {
  const islands = useIslands();
  return <div className={islandClass(islands, className)}>{children}</div>;
}
