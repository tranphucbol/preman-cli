/**
 * The one notice bar. A tone-switched strip that sits above the thing it is about:
 * an unparseable request file, a run that could not start, an environment that could
 * not be written.
 *
 * It lives here because four panes wanted it and three of them had already written
 * their own, with three different class strings for the same idea. A notice that
 * reads differently depending on which pane you are in is not a notice, it is noise.
 *
 * `App.tsx` was the last holdout - a fifth copy with an action slot and a copy button - and it is
 * gone. Both of its extras moved here rather than the other way round, because the shape this file
 * already documented in `design-system.md` is the one the app should have.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import { CheckIcon, CopyIcon, WarningIcon } from "@preman/desktop/renderer/ui/icons.js";
import { IconButton } from "@preman/desktop/renderer/ui/Controls.js";
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
 * The details list scrolls instead of growing.
 *
 * A banner is `shrink-0` and, in `App.tsx`, a sibling of the whole resizable workspace, so an
 * unbounded stack of lines is chrome that steals the window. Picking a gRPC method in a workspace
 * whose `.proto` declarations have gone stale produces one warning per spec - twenty-two of them on
 * the report that prompted this - and half a screen of banner pushed the editor out of view.
 *
 * Bounding the box and not the data: `details` is carried the whole way from core's `PremanError`,
 * the CLI prints all of it, and a GUI that silently drops the last fourteen lines is worse than the
 * CLI. Every line is still in the DOM, still selectable, and still in what the copy button writes.
 *
 * `max-h-32` is 8rem, and `--text-2xs--line-height` is 1rem, so the box is exactly
 * {@link VISIBLE_DETAILS} lines tall. Change one and change the other.
 */
const DETAILS_CLASS = "flex flex-col overflow-y-auto overscroll-contain max-h-32";

/** How many detail lines {@link DETAILS_CLASS} shows before the rest are behind a scroll. */
const VISIBLE_DETAILS = 8;

/** How long the copy button shows "Copied" before it reverts to naming the action. */
const COPY_FEEDBACK_MS = 1500;

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
 * Exported for `RequestEditor`'s `ConflictBanner`, which carries two actions and no icon column and
 * so is its own bar - but a bar that arrives differently is the noise this component was written to
 * remove. Spread it; do not restate the numbers.
 */
export const BANNER_MOTION = { initial: LEAVE, animate: ENTER, exit: LEAVE, transition: TIMING } as const;

export function Banner({
  tone,
  message,
  detail,
  details = NO_DETAILS,
  children,
}: {
  readonly tone: BannerTone;
  readonly message: string;
  /** Beside the message, monospace, truncated: an id or a path, not a second sentence. */
  readonly detail?: string;
  /** Below the message, one line each: the actionable prose a `PremanError` carries. */
  readonly details?: readonly string[];
  /** The one thing to do about it - Retry, Dismiss - to the right of the copy button. */
  readonly children?: ReactNode;
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
          {/* Said only when it is news. A scrollbar is the other half of this and macOS hides it
           * until the pointer moves, so the count is what tells a reader the box is bounded. */}
          {details.length > VISIBLE_DETAILS && (
            <span className="shrink-0 text-2xs text-ink-faint">{details.length} issues</span>
          )}
          {detail === undefined ? null : <span className="truncate font-mono text-2xs text-ink-faint">{detail}</span>}
        </div>
        {details.length > 0 && (
          <div className={DETAILS_CLASS}>
            {details.map((line, index) => (
              // Keyed by position: two specs under the same missing import produce two identical
              // lines, and a key that collides drops one of them. Safe because the list is
              // replaced wholesale or not at all - it never reorders and nothing in it has state.
              <span key={index} className="text-2xs text-ink-dim">
                {line}
              </span>
            ))}
          </div>
        )}
      </div>
      {/* `danger` and not `details.length > 0`: a transport failure or a host crash carries the one
       * string worth pasting into a bug report even when it is a single line, and `warn` - today
       * only "degraded" and unresolved tokens - never does. */}
      {(tone === "danger" || children !== undefined) && (
        <div className="flex shrink-0 items-center gap-1">
          {tone === "danger" && <CopyErrorButton message={message} detail={detail} details={details} />}
          {children}
        </div>
      )}
    </m.div>
  );
}

/**
 * Copies the banner as the reader would want to paste it: one line each, message first. The whole
 * of `details` and not the eight that were on screen - being able to paste what the box could not
 * show is what makes bounding it honest.
 *
 * A timeout rather than a store flag: this is one button's own transient state, and giving it to
 * `useSessionStore` would make every banner re-render when any one of them was clicked.
 */
function CopyErrorButton({
  message,
  detail,
  details,
}: {
  readonly message: string;
  readonly detail: string | undefined;
  readonly details: readonly string[];
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeout.current !== null) clearTimeout(timeout.current);
    };
  }, []);

  const onClick = useCallback(() => {
    const headline = detail === undefined ? message : `${message} ${detail}`;
    void navigator.clipboard.writeText([headline, ...details].join("\n"));
    setCopied(true);
    if (timeout.current !== null) clearTimeout(timeout.current);
    timeout.current = setTimeout(() => {
      setCopied(false);
    }, COPY_FEEDBACK_MS);
  }, [message, detail, details]);

  return (
    <IconButton label={copied ? "Copied" : "Copy error"} onClick={onClick}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  );
}
