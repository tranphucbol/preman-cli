/**
 * The placeholder shapes shown while a workspace is opening.
 *
 * Two primitives and no logic: the arithmetic that decides how many rows and how wide each one is
 * lives in `model/opening.ts`, because it is the part worth asserting and a component under
 * `environment: "node"` cannot be rendered.
 *
 * A skeleton is a promise about layout, so these are deliberately dumb: a bar is a bar, the caller
 * owns the geometry, and the pulse is one CSS class that `prefers-reduced-motion` already
 * neutralises. Nothing here is a spinner - a spinner says "wait", a skeleton says "here is where
 * the thing goes", and the second is the only one that survives the thing arriving.
 */
import { useEffect, type ReactElement } from "react";

import { markSkeletonShown } from "@preman/desktop/renderer/phases.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { skeletonWidths } from "@preman/desktop/renderer/model/opening.js";

/**
 * One bar. `width` is a percentage of the container and goes inline because it is computed at
 * render time; a Tailwind arbitrary value cannot take a runtime number. Every other dimension is
 * the caller's `className`, so this component owns exactly one thing.
 */
export function SkeletonBlock({
  width,
  className,
}: {
  readonly width?: number;
  readonly className?: string;
}): ReactElement {
  return (
    <div className={cn("skeleton-block", className)} style={width === undefined ? undefined : { width: `${width}%` }} />
  );
}

/**
 * A tree's worth of bars, one per row, at the row height the density is currently using.
 *
 * The rows are `aria-hidden` and carry no `role`: a screen reader must not be told there are
 * eighteen tree items, because there are none yet. `label` is announced once instead, from the
 * one live line, and `aria-busy` marks the region as unfinished for anything that asks.
 */
export function SkeletonList({
  rows,
  rowHeight,
  label,
}: {
  readonly rows: number;
  readonly rowHeight: number;
  readonly label: string;
}): ReactElement {
  // The phase, marked from here and not from the editor's placeholder: one open has to produce one
  // mark, and both panes mount their own skeleton.
  useEffect(() => {
    markSkeletonShown();
  }, []);

  return (
    <div aria-busy="true" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <span role="status" className="sr-only">
        {label}
      </span>
      {skeletonWidths(rows).map((width, index) => (
        /* The index is the identity. These are positions, not things - there is nothing else
         * about a placeholder row to key on, and re-keying them on resize would restart every
         * pulse. */
        <div
          key={index}
          aria-hidden="true"
          className="flex shrink-0 items-center px-gutter"
          style={{ height: rowHeight }}
        >
          <SkeletonBlock width={width} className="h-2" />
        </div>
      ))}
    </div>
  );
}
