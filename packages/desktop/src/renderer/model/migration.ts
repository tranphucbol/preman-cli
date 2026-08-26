import type { MigrationProgress } from "@preman/desktop/preload/bridge.js";

/**
 * The arithmetic and the wording behind a running migration, kept out of the components that draw
 * them.
 *
 * The same split `model/opening.ts` makes for the skeleton, and for the same reason: this is the
 * part worth asserting, and a component under `environment: "node"` cannot be rendered. What is
 * left in `ui/Progress.tsx` and `panes/MigratePane.tsx` is JSX.
 */

const WHOLE = 1;
const NOTHING = 0;
/** Hundredths: finer than a pixel on any bar this app can draw, and it keeps the string short. */
const PRECISION = 100;

/** Between the counts and the read tally. */
const DETAIL_SEPARATOR = " · ";
const READS_LABEL = "reads";

/**
 * How each phase reads, keyed by core's `MigrationPhase`.
 *
 * A phase this file does not know falls back to the caller's sentence rather than being drawn as a
 * raw identifier: core may name a new one, and a released window should still say something true.
 */
const PHASE_MESSAGES: Readonly<Record<string, string>> = {
  connecting: "Asking Postman Desktop for a token…",
  "reading-workspace": "Reading the workspace…",
  "reading-collections": "Reading collections…",
  "reading-environments": "Reading environments…",
  converting: "Converting to workspace files…",
  writing: "Writing files…",
};

/**
 * The filled proportion of a bar, as a scale factor.
 *
 * Floored to a hundredth, so the bar is never visibly complete before the work is: rounding fills
 * the last pixel column at 99.5% and puts a full-looking bar beside an unfinished count. Under-
 * claiming by half a percent is the harmless direction to be wrong in.
 *
 * A phase with nothing in it is complete the moment it begins — a workspace with no environments
 * would otherwise sit at an empty bar and read as stuck.
 */
export function barScale(done: number, total: number): number {
  if (total <= NOTHING) return WHOLE;
  return Math.min(WHOLE, Math.floor((done / total) * PRECISION) / PRECISION);
}

/** What to say about a phase, falling back to the caller's general sentence. */
export function phaseMessage(phase: string, fallback: string): string {
  return PHASE_MESSAGES[phase] ?? fallback;
}

/** `12 of 41 · 327 reads`, or just the reads where there is no proportion to state. */
export function progressDetail(progress: MigrationProgress): string {
  const reads = `${String(progress.calls)} ${READS_LABEL}`;
  if (progress.total === undefined) return reads;
  return `${String(progress.done)} of ${String(progress.total)}${DETAIL_SEPARATOR}${reads}`;
}
