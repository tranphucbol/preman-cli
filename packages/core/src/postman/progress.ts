/**
 * What a migration says about itself while it is running.
 *
 * The denominator is the whole of this file. A migration's total cost is *unknowable* until it is
 * over: the walk in `fetch.ts` learns a node's children only from that node's own detail, four
 * levels deep, so "read 412 of 822" cannot be said at read 412 — the 822 is not known yet. A bar
 * driven by calls-discovered-so-far would slide backwards every time a folder opened, which is the
 * one thing a progress indicator must never do.
 *
 * What *is* exact, from the first reply onward and forever after, is the number of collections and
 * the number of environments. Each collection is an independent subtree that resolves as a unit, so
 * `12 of 41` is true, monotonic and never revised. It is also coarse — one collection can be a
 * hundred requests — so a raw count of completed reads rides along beside it. That number has no
 * ceiling and is not drawn as a proportion; it exists to prove the thing is alive inside a
 * collection that is taking a while.
 *
 * A plain callback rather than the `RunEventSink` shape next door: that interface exists to own a
 * `runId` so two concurrent runs cannot interleave (`api/events.ts`), and a migration has no such
 * correlation problem — the desktop refuses a second one while the first is in flight, and the CLI
 * is one process doing one thing.
 */

/**
 * Where a migration has got to. Ordered as they occur, and each one happens at most once except
 * `reading-collections`, which reports again as each collection lands.
 */
export type MigrationPhase =
  "connecting" | "reading-workspace" | "reading-collections" | "reading-environments" | "converting" | "writing";

export interface MigrationProgress {
  readonly phase: MigrationPhase;
  /** Units of this phase finished. Meaningless where `total` is `undefined`; then it is zero. */
  readonly done: number;
  /**
   * How many units this phase has, when that is known exactly and will not be revised.
   * `undefined` is the truth about a phase whose size cannot be stated, not a missing value —
   * a reader must draw indeterminate rather than guess a ceiling.
   */
  readonly total: number | undefined;
  /**
   * Proxy reads completed since the migration began, across every phase. Rises without a ceiling.
   * Never a proportion; the liveness signal for a phase whose units are coarse.
   */
  readonly calls: number;
}

export type MigrationReporter = (progress: MigrationProgress) => void;

/**
 * The running state behind one migration's reports.
 *
 * Stateful because `calls` has to be counted somewhere and the alternative is threading a mutable
 * number through the walk. One tracker per migration; the two entry points in `api/migrate.ts`
 * each build exactly one.
 */
export interface ProgressTracker {
  /** Enter a phase, or report movement inside it. Always reported. */
  at(phase: MigrationPhase, done?: number, total?: number): void;
  /** One proxy read finished. Reported every `PROGRESS_CALL_INTERVAL`th time. */
  read(): void;
}

const NOTHING = 0;

/**
 * How many reads pass between two liveness reports.
 *
 * The driving workspace is 822 reads, so this is roughly thirty reports over forty seconds —
 * on top of one per phase and one per collection, which is about a hundred in total. Small enough
 * that neither front end needs a throttle of its own, which is the point: a throttle in the window
 * and a different one in the terminal is two places for the last event to be dropped.
 */
const PROGRESS_CALL_INTERVAL = 25;

/** For a caller that asked for no reports. Holds no state, so it cannot accumulate any. */
export const NO_PROGRESS: ProgressTracker = {
  at: () => undefined,
  read: () => undefined,
};

export function migrationProgress(report: MigrationReporter | undefined): ProgressTracker {
  if (report === undefined) return NO_PROGRESS;

  let phase: MigrationPhase = "connecting";
  let done = NOTHING;
  let total: number | undefined;
  let calls = NOTHING;
  const emit = (): void => {
    report({ phase, done, total, calls });
  };

  return {
    at(next, nextDone = NOTHING, nextTotal) {
      phase = next;
      done = nextDone;
      total = nextTotal;
      emit();
    },
    read() {
      calls += 1;
      if (calls % PROGRESS_CALL_INTERVAL === NOTHING) emit();
    },
  };
}
