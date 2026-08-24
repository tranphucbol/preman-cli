/**
 * The one notice bar. A tone-switched strip that sits above the thing it is about:
 * an unparseable request file, a run that could not start, an environment that could
 * not be written.
 *
 * It lives here because four panes wanted it and three of them had already written
 * their own, with three different class strings for the same idea. A notice that
 * reads differently depending on which pane you are in is not a notice, it is noise.
 */
import type { ReactElement } from "react";

import { WarningIcon } from "@preman/desktop/renderer/ui/icons.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { m } from "@preman/desktop/renderer/ui/motion.js";

/** Only the two tones that mean "read me". `ok` and `neutral` do not warrant a bar. */
export type BannerTone = "danger" | "warn";

const SURFACE_CLASS: Record<BannerTone, string> = {
  danger: "border-danger/40 bg-danger/10",
  warn: "border-warn/40 bg-warn/10",
};

const ICON_CLASS: Record<BannerTone, string> = {
  danger: "text-danger",
  warn: "text-warn",
};

const NO_DETAILS: readonly string[] = [];

/**
 * The banner's arrival and departure. It is a conditional render at every call site, so there is
 * no element left to transition on the way out and CSS cannot do this one.
 *
 * Both numbers are duplicated from `app.css`: these are `--duration-panel` and `--ease-out`'s
 * control points, because a custom property is not readable from a Motion transition. Change the
 * token and change this. It is the only duplicated curve in the app.
 *
 * `translateY(0px)` and not `translateY(0)`, and not the absence of the key: Motion interpolates a
 * `transform` string only when both ends carry the same unit. A composed string rather than `y`
 * because the shorthands are off the compositor path.
 */
const ENTER = { opacity: 1, transform: "translateY(0px)" } as const;
const LEAVE = { opacity: 0, transform: "translateY(-4px)" } as const;
const TIMING = { duration: 0.18, ease: [0.23, 1, 0.32, 1] } as const;

/**
 * Exported because `App.tsx` still carries its own banner - a tone-coloured variant with an action
 * slot that predates this one - and two banners that arrive differently is the noise this component
 * was written to remove. Spread it; do not restate the numbers.
 */
export const BANNER_MOTION = { initial: LEAVE, animate: ENTER, exit: LEAVE, transition: TIMING } as const;

export function Banner({
  tone,
  message,
  detail,
  details = NO_DETAILS,
}: {
  readonly tone: BannerTone;
  readonly message: string;
  /** Beside the message, monospace, truncated: an id or a path, not a second sentence. */
  readonly detail?: string;
  /** Below the message, one line each: the actionable prose a `PremanError` carries. */
  readonly details?: readonly string[];
}): ReactElement {
  return (
    /* `role="alert"` stays on the animated element. On a wrapper it would change what the screen
     * reader announces, and the height is deliberately not animated: the banner's own height is
     * unknown, so animating it would be a layout animation. 4px and opacity read as arrival
     * without measuring anything. */
    <m.div
      role="alert"
      {...BANNER_MOTION}
      className={cn("flex shrink-0 items-start gap-2 border-b px-gutter py-1.5", SURFACE_CLASS[tone])}
    >
      <WarningIcon className={cn("mt-px shrink-0", ICON_CLASS[tone])} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs text-ink">{message}</span>
          {detail === undefined ? null : <span className="truncate font-mono text-2xs text-ink-faint">{detail}</span>}
        </div>
        {details.map((line) => (
          <span key={line} className="text-2xs text-ink-dim">
            {line}
          </span>
        ))}
      </div>
    </m.div>
  );
}
