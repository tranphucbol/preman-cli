/**
 * The renderer's half of the phase instrument: the one mark a pane would otherwise have to own
 * state for, and the seam that lets a profiler read the engine's marks too.
 *
 * This is not a view and it is not a store. It exists so `Sidebar.tsx` gains one call and no
 * state, and so nothing in `panes/` grows a performance concern of its own. Decision 027.
 */
import { markPhase, PHASES, readPhases, type PhaseReport } from "@preman/desktop/engine/protocol.js";

/**
 * Where the cross-process reader is parked, so a profiler and `test/renderer/perf.app.test.ts`
 * agree on one name.
 *
 * It is on `window` rather than on `PremanBridge` because the bridge cannot reach the engine: the
 * port is transferred into the page, and this window is the only place both reports are in hand.
 * A reader is not a view, so decision 12's "no UI reads the marks" still holds.
 */
export const PHASE_READER_KEY = "premanPhases";

export interface PhaseReports {
  renderer: PhaseReport;
  /** The engine host's own, fetched over the port. */
  engine: PhaseReport;
}

export type PhaseReader = () => Promise<PhaseReports>;

/** `window`, seen as the thing that carries the reader. */
export type PhaseWindow = Record<typeof PHASE_READER_KEY, PhaseReader | undefined>;

/**
 * Park a reader for the workspace that just connected.
 *
 * Called with the live client's own `phases` request, so a reader always answers for the host the
 * window is actually attached to. Replaced on every port, because a workspace switch means the
 * previous host's timings are no longer the ones anybody is asking about.
 */
export function publishPhaseReader(engine: () => Promise<PhaseReport>): void {
  (window as unknown as PhaseWindow)[PHASE_READER_KEY] = async () => ({
    renderer: readPhases(),
    engine: await engine(),
  });
}

/** Once per document. A second "first paint" is not a thing, and a timeline with two is a lie. */
let painted = false;

/**
 * The tree is on screen.
 *
 * Deferred by one animation frame so the mark lands after the commit it is reporting rather than
 * inside it: an effect runs before the browser has painted, and the phase this closes is the paint.
 */
export function markRowsPainted(): void {
  if (painted) return;
  painted = true;
  requestAnimationFrame(() => {
    markPhase(PHASES.rendererRowsPainted);
  });
}

/**
 * Once per document, for the same reason and with a flag of its own: the two phases are separate
 * facts about one open, and sharing a flag would let whichever happened first silence the other.
 */
let skeletonShown = false;

/**
 * The app admitted it is opening something.
 *
 * Marked from the sidebar's placeholder and not the editor's, because one open must produce one
 * mark and both panes mount their own. Deferred a frame for `markRowsPainted`'s reason: what is
 * being reported is a paint, and an effect runs before one.
 */
export function markSkeletonShown(): void {
  if (skeletonShown) return;
  skeletonShown = true;
  requestAnimationFrame(() => {
    markPhase(PHASES.rendererSkeletonShown);
  });
}
