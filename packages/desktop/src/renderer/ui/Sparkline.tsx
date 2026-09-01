/**
 * A minute of one number, drawn as a line. The second indicator in this app, and the last one that
 * gets in without an argument of its own.
 *
 * `Progress` said there is exactly one of them, and that rule holds — it is a rule about a
 * *proportion*. `Progress` takes a numerator and a denominator, and its own docblock refuses the
 * cases where the denominator moves. This has no denominator: it is a history, the y axis is scaled
 * to the window it is drawing, and it claims nothing about how far anything has got. That is the
 * distinction to hold the third one to, rather than the count. See `docs/decisions/040`.
 *
 * **It does not animate, and that is what makes it affordable.** The motion rules exist because
 * decision 17's budgets are blocking-time medians and a per-frame tween of a layout property spends
 * them; this is a discrete repaint once a second of a fixed `viewBox` with no transition on it, so
 * nothing interpolates and nothing reflows. `preserveAspectRatio="none"` is what lets the points
 * stay in sample space while the element stretches to whatever width the row gives it, and
 * `vector-effect="non-scaling-stroke"` is what keeps that stretch from distorting the stroke.
 *
 * **It takes its colour from the caller and holds none of its own — not even a default.** Both the
 * stroke and the wash are `currentColor`, so one `text-*` class on the element colours the whole
 * drawing, and the pane passes the row's load band. That is how this follows a theme without
 * knowing that themes exist, exactly as `appearance/apply.ts` requires.
 *
 * The absent default is deliberate and was a bug first. `cn` is a plain join with no
 * `tailwind-merge` — its own docblock says every component owns its classes outright — so a
 * `text-glyph` in here plus a `text-ok` from the caller leaves both on the element and lets the
 * stylesheet's declaration order pick the winner. It happened to pick the caller's, because `ok` is
 * declared after `glyph` in `COLOR_TOKENS`. A caller with no band to pass should pass `text-glyph`
 * itself, that being the tier a non-text affordance belongs to.
 *
 * It is not the accent, in any case: that is "a fill exactly once per pane — the thing you came
 * there to press", and a table of readings has nothing to press.
 *
 * `aria-hidden`, because the number this traces is in text on the same row — the line is a second
 * reading of it, not a second fact, and there is no honest ARIA role for "the shape of the last
 * minute".
 */
import type { ReactElement } from "react";

import {
  SPARKLINE_VIEW_HEIGHT,
  SPARKLINE_VIEW_WIDTH,
  sparklineArea,
  sparklinePoints,
} from "@preman/desktop/renderer/model/resources.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";

const VIEW_BOX = `0 0 ${String(SPARKLINE_VIEW_WIDTH)} ${String(SPARKLINE_VIEW_HEIGHT)}`;
const NO_POINTS = "";
/**
 * In user units, so it is a constant width on screen under `non-scaling-stroke` — which is the
 * point of that attribute: a stroke scaled by `preserveAspectRatio="none"` would be four times
 * thicker vertically than horizontally.
 */
const STROKE_WIDTH = 1.5;
/**
 * Low enough that the wash reads as a tint of the row rather than as a second surface, since it is
 * drawn over `--color-panel` in dark themes and under it in light ones and has to work in both. An
 * opacity rather than a `/15` colour utility because it is an SVG paint, and `fill-opacity` composites
 * without needing the token to be resolvable to a colour space Tailwind can mix in.
 */
const AREA_OPACITY = 0.16;

export function Sparkline({
  series,
  className,
}: {
  readonly series: readonly number[];
  readonly className?: string;
}): ReactElement {
  const points = sparklinePoints(series);
  return (
    <svg aria-hidden="true" viewBox={VIEW_BOX} preserveAspectRatio="none" className={cn("h-full w-full", className)}>
      {/* An empty series renders an empty `svg` rather than nothing at all, so the cell keeps its
          width and the columns beside it do not shift when the first sample lands. */}
      {points === NO_POINTS ? null : (
        <>
          {/* The wash first, so the stroke sits on top of its own fill rather than under it. Both
              are `currentColor`: one class on the `svg` colours the pair, and they cannot drift. */}
          <polygon points={sparklineArea(series)} fill="currentColor" fillOpacity={AREA_OPACITY} stroke="none" />
          <polyline
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE_WIDTH}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
    </svg>
  );
}
