/**
 * Whether a workspace is on its way in, and what the placeholder that says so looks like.
 *
 * Pure and no React, for the reason every file in `model/` is: the interesting part is a small
 * amount of arithmetic and a three-way decision, and a test should be able to state it without
 * mounting a tree. The renderer cannot be rendered under `environment: "node"`, so logic that
 * lives in a component is logic that is asserted by reading its source - which is a worse test
 * than calling a function. Everything here is therefore deliberately *not* in `Skeleton.tsx` or
 * `Sidebar.tsx`, even though each has exactly one caller.
 *
 * The distinction the whole file exists for: an empty pane and a pane that is *about* to have
 * something in it look identical, and telling the user "No workspace open." while one is opening
 * is a lie the app told for as long as opening took.
 */

/**
 * The four facts that decide it, gathered from two stores plus one pre-port hint.
 *
 * `reopening` is what the main process is already loading when the window appears - known before
 * any engine port exists, which is the only reason the first frame after a cold start can be
 * honest. `sessionRoot` means a client arrived; `catalogRoot` means its catalog landed. `failed`
 * is the escape: a host that died is not opening, it is broken, and the banner says so.
 */
export interface OpeningInputs {
  readonly reopening: string | null;
  readonly sessionRoot: string | null;
  readonly catalogRoot: string | null;
  readonly failed: boolean;
}

/**
 * The workspace that is between "asked for" and "on screen", or `null` if none is.
 *
 * A root and not a boolean, because the two things that ask want both halves of one answer: a pane
 * wants to know whether to draw a placeholder, and the delay in front of it wants an identity to
 * expire against.
 *
 * `sessionRoot ?? reopening` covers the two windows an open crosses with one expression. Before the
 * port there is no session root and the hint is all there is; after it the hint is history and the
 * session root is the truth. A catalog closes both, whichever named the workspace.
 */
export function openingTarget({ reopening, sessionRoot, catalogRoot, failed }: OpeningInputs): string | null {
  // Not defensive. A host that died is not slow, and a placeholder for it would never resolve -
  // `HostBanner` is what that state looks like.
  if (failed) return null;
  if (catalogRoot !== null) return null;
  return sessionRoot ?? reopening;
}

/**
 * What a pane draws.
 *
 * `quiet` is the one that matters: a workspace *is* opening, and we draw nothing at all, because
 * a skeleton that appears and vanishes inside 150ms is a flash of noise and reads as a bug. The
 * committed fixture opens well inside that window, so the common case never paints a skeleton.
 */
export type OpeningState = "idle" | "quiet" | "opening";

/** The two booleans, resolved. Split out from the hook so the three cases are assertable. */
export function openingState(opening: boolean, delayElapsed: boolean): OpeningState {
  if (!opening) return "idle";
  return delayElapsed ? "opening" : "quiet";
}

/**
 * The placeholder row widths, as percentages, cycled.
 *
 * Fixed and not random: a skeleton is re-rendered whenever its container is measured, and
 * `Math.random()` would make the rows twitch on every resize. Uneven on purpose - seven values,
 * co-prime with nothing in particular, so a column of them does not read as a pattern.
 */
const SKELETON_WIDTHS: readonly number[] = [62, 44, 78, 53, 70, 38, 66];

/** One row, always: a zero-row skeleton is the empty pane it was written to replace. */
const SKELETON_MIN_ROWS = 1;

/**
 * A ceiling, so a bad measurement cannot cost thousands of nodes. Above a 4K display's worth of
 * the smallest row height, and nothing is scrolling here anyway.
 */
const SKELETON_MAX_ROWS = 128;

/** How many rows fill a pane. Partial rows count: a clipped row is what a real list does. */
export function skeletonRowCount(heightPx: number, rowHeightPx: number): number {
  if (!(heightPx > 0) || !(rowHeightPx > 0)) return SKELETON_MIN_ROWS;
  const rows = Math.ceil(heightPx / rowHeightPx);
  return Math.min(Math.max(rows, SKELETON_MIN_ROWS), SKELETON_MAX_ROWS);
}

/** The widths for `rows` rows, in order. */
export function skeletonWidths(rows: number): readonly number[] {
  const widths: number[] = [];
  for (let index = 0; index < rows; index += 1) {
    widths.push(SKELETON_WIDTHS[index % SKELETON_WIDTHS.length]!);
  }
  return widths;
}
