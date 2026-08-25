/**
 * The drag affordance on a resizable pane boundary.
 *
 * One element, one pixel. A visible 4px gutter between two panes is 4px of nothing, fifty times a
 * day, so the boundary is a hairline; and `react-resizable-panels` already widens the *grab* to a
 * 9px band around it, which was measured rather than assumed — the pointer 4px clear of the line
 * still reports `data-separator="hover"` with no help from us.
 *
 * That measurement is the whole reason this module exists. Each of the four boundaries used to
 * carry an absolutely-positioned child spanning `-inset-y-1`, and the belief was that the child
 * was the hit area. It was not. Its only effect was to make CSS `:hover` match across the band
 * instead of on the line, and it painted `bg-accent/40` while doing so — so hovering anywhere near
 * the request/response boundary drew a full-width nine-pixel translucent accent bar directly
 * beneath the code editor, which reads as that editor's horizontal scrollbar and not as a
 * boundary you can drag. Deleting the child costs nothing and fixes it.
 *
 * So the paint is driven by `data-separator` instead, which the library sets to `inactive`,
 * `hover` or `active` and is the only thing that knows where its own hit area is. `bg-glyph` for
 * hover because `docs/design-system.md` names `glyph` for a drag handle and gives it 3:1; the
 * accent stays out of it until `active`, where the handle is the thing being manipulated and there
 * is nothing left to confuse it with. `--color-accent` has no dimmed variant on purpose, and the
 * accent is a fill exactly once per pane — beside an editor that fill is Send.
 *
 * `data-[state=drag]` is what the old markup tested for, and it never matched anything; the drag
 * feedback had been dead for as long as the hover band had been loud, which is likely why it was.
 */
import { Separator } from "react-resizable-panels";

import { cn } from "./cn.js";

/** The line across the boundary, and the cursor that says which way it moves. */
const AXIS_CLASS = {
  horizontal: "h-px cursor-row-resize",
  vertical: "w-px cursor-col-resize",
} as const;

/** `relative` is not for a child; it is what makes `z-handle` apply at all. */
const PAINT_CLASS =
  "relative z-handle shrink-0 bg-line transition-colors duration-(--duration-glyph) ease-out data-[separator=hover]:bg-glyph data-[separator=active]:bg-accent";

export type HandleAxis = keyof typeof AXIS_CLASS;

export interface HandleProps {
  /** `horizontal` for a boundary you drag up and down, `vertical` for one you drag left and right. */
  readonly axis: HandleAxis;
}

export function Handle({ axis }: HandleProps) {
  return <Separator className={cn(PAINT_CLASS, AXIS_CLASS[axis])} />;
}
