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
    <div role="alert" className={cn("flex shrink-0 items-start gap-2 border-b px-gutter py-1.5", SURFACE_CLASS[tone])}>
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
    </div>
  );
}
