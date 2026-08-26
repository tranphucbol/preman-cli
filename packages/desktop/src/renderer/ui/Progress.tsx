/**
 * A bar saying how far something has got, for the one case in this app that has an answer.
 *
 * Not a control and not in the tier table: it takes no input and its height is set here rather than
 * by the caller, the same way `Skeleton` owns its own shape. It is an indicator, and there is
 * exactly one of them.
 *
 * **`total` of `undefined` is a state, not a missing number.** A migration cannot know its own size
 * until it is over (`postman/progress.ts` in core), so the indeterminate form is the honest answer
 * rather than a fallback, and it reuses `.inflight-bar` — the sweep the response pane already draws
 * while a request is open — rather than inventing a second way to say the same thing.
 *
 * The accent fill is allowed here because the design system's "a fill exactly once per pane" holds:
 * while this is on screen the pane has no primary button, and this is the thing the user is
 * watching.
 */
import type { ReactElement } from "react";

import { barScale } from "@preman/desktop/renderer/model/migration.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";

/** Thick enough to be the subject of a dialog; `.inflight-bar` reads it for its sweeping segment. */
const THICKNESS = "4px";
const TRACK_CLASS = "relative h-1 w-full overflow-hidden rounded-full bg-control";
const NOTHING = 0;

export function Progress({
  done,
  total,
  label,
  className,
}: {
  readonly done: number;
  /** `undefined` draws the indeterminate sweep. Never guess a ceiling to avoid it. */
  readonly total: number | undefined;
  /** What is being waited on, announced in place of a number a screen reader cannot use. */
  readonly label: string;
  readonly className?: string;
}): ReactElement {
  if (total === undefined) {
    return (
      <div
        role="progressbar"
        aria-label={label}
        /* No `aria-valuenow`: its absence is how ARIA spells indeterminate, and a zero here would
           be a claim that no progress has been made rather than that none can be measured. */
        className={cn(TRACK_CLASS, "inflight-bar", className)}
        style={{ "--inflight-thickness": THICKNESS } as React.CSSProperties}
      />
    );
  }

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={NOTHING}
      aria-valuemax={total}
      aria-valuenow={done}
      className={cn(TRACK_CLASS, className)}
    >
      {/*
        A full-width fill scaled from its left edge, never an animated `width`: this system animates
        `opacity`, `transform` and colour and nothing else, because the budgets are blocking-time
        medians and a width tween is layout on every frame. The transform is inline because it is a
        runtime number, the same reason `SkeletonBlock` computes its own.

        No radius on the fill — the track already clips it — so the scale cannot squash one.
        `--duration-panel`, because reports land a few times a second and an untweened bar reads as
        a series of jumps rather than as movement.
      */}
      <div
        className="h-full w-full origin-left bg-accent transition-transform duration-(--duration-panel) ease-out"
        style={{ transform: `scaleX(${String(barScale(done, total))})` }}
      />
    </div>
  );
}
