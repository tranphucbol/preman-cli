/**
 * What the Body tab shows when there is no body because the request failed - either
 * the server refused it, or preman could not build it in the first place.
 *
 * The shape is a mark, a headline naming the failure class, one line of guidance, then
 * the server's own words verbatim. The status name on the summary row is for the reader
 * who already knew what `FAILED_PRECONDITION` means; this is for the one who did not.
 *
 * Centred, and centred with `m-auto` rather than `items-center`: a cross-axis-centred
 * flex child in an `overflow-auto` container has a top the reader cannot scroll back to,
 * so with the trailers open the headline would leave and not return. Auto margins absorb
 * the free space when there is any and collapse to zero when there is not, which is the
 * same composition without the trap.
 *
 * No illustration. At the sizes this app is built for a 200px drawing would push the
 * one informative line below the fold, and it would be the same drawing for every
 * failure, so it would carry nothing.
 */
import type { ReactElement } from "react";

import { failureCopy, type HeaderPairs, type ResponseFailure } from "@preman/desktop/renderer/model/response.js";
import { CaretRightIcon, FailIcon } from "@preman/desktop/renderer/ui/icons.js";
import { StatusTag } from "@preman/desktop/renderer/ui/StatusTag.js";

/** The heading's mark, not a control's, so it is sized well above `ICON_DEFAULTS`. */
const MARK_SIZE = 24;
const NO_ROWS = 0;
const SINGLE_ROW = 1;

const COLUMN_CLASS = "flex min-h-0 flex-1 flex-col overflow-auto p-gutter";
/** Caps the measure. Prose at `text-xs` runs long on a wide window, centred or not. */
const STACK_CLASS = "m-auto flex w-full max-w-lg flex-col items-center py-6";

export function ResponseFailure({
  status,
  failure,
}: {
  /** From `response-head`. Undefined when no response arrived, and on every build failure. */
  readonly status: number | string | undefined;
  readonly failure: ResponseFailure;
}): ReactElement {
  const copy = failureCopy(failure.stage, status);
  return (
    <div className={COLUMN_CLASS}>
      <div className={STACK_CLASS}>
        {/*
         * The mark and the report below stay danger whatever the status is. This pane only
         * renders when there is no response, so that tone is a constant and carries no
         * information; the graded one is on the tag, where it tells the reader whether the
         * call is theirs to fix. Tinting the whole block amber for a `NOT_FOUND` would make
         * two identical outcomes - nothing came back - look like different kinds of event.
         */}
        <FailIcon size={MARK_SIZE} className="text-danger/70" />
        <div className="mt-2 flex max-w-full items-center gap-2">
          <p className="min-w-0 truncate text-sm text-ink">{copy.title}</p>
          {/*
           * The summary row already carries this, but it sits at the far right of the tab
           * strip, which on a wide window is a long way from the sentence it belongs to.
           * The same tag in both places is how the reader knows it is the same fact.
           */}
          {status === undefined ? null : <StatusTag status={status} />}
        </div>
        <p className="mt-1 text-center text-xs text-ink-dim">{copy.hint}</p>
        <Report message={failure.message} details={failure.details} />
        <Trailers trailers={failure.trailers} />
      </div>
    </div>
  );
}

/**
 * The message and the `PremanError` details are one object, not two stacked ones: on a
 * build failure the details are the actionable half - the path that did not resolve -
 * and floating them below the block would read as metadata about it.
 *
 * Left-aligned inside a centred block, because it is the one part a reader parses
 * character by character rather than reads.
 *
 * `select-text` is a deliberate local exception to the app-wide `select-none` in
 * `app.css`: these are the strings the reader wants in their clipboard.
 */
function Report({ message, details }: { readonly message: string; readonly details: readonly string[] }): ReactElement {
  return (
    <div className="mt-3 w-full rounded-sm border border-danger/30 bg-danger/10">
      <p className="px-2 py-1.5 font-mono text-2xs break-words text-danger select-text">{message}</p>
      {details.length === NO_ROWS ? null : (
        <div className="border-t border-danger/20 px-2 py-1.5">
          {details.map((line) => (
            <p key={line} className="font-mono text-2xs break-all text-ink-dim select-text">
              {line}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Collapsed, because most of what a server attaches to a rejection is `date`, `server`
 * and `content-type`, and five rows of that under a one-line error bury the error. The
 * reader who wants `grpc-status-details-bin` knows to look.
 *
 * A native `<details>`: no state, no dependency, and it is already keyboard-operable.
 */
function Trailers({ trailers }: { readonly trailers: HeaderPairs }): ReactElement | null {
  if (trailers.length === NO_ROWS) return null;
  const label = trailers.length === SINGLE_ROW ? "1 trailer" : `${String(trailers.length)} trailers`;
  return (
    <details className="group mt-3 w-full border-t border-line pt-2">
      <summary className="mx-auto flex w-fit cursor-default list-none items-center gap-1 text-2xs text-ink-faint hover:text-ink-dim [&::-webkit-details-marker]:hidden">
        <CaretRightIcon className="shrink-0 text-glyph group-open:rotate-90" />
        {label}
      </summary>
      <dl className="mt-1.5 text-2xs">
        {trailers.map(([name, value], index) => (
          <div key={`${name}:${String(index)}`} className="flex gap-3">
            <dt className="w-32 shrink-0 truncate text-ink-faint">{name}</dt>
            <dd className="min-w-0 font-mono break-all text-ink-dim select-text">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
