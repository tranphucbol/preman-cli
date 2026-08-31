/**
 * The opening state: the decision, the arithmetic behind the placeholder, and the wiring that
 * puts one on screen.
 *
 * The first two thirds of this file are ordinary function calls, and that is on purpose. There is
 * no window here — `environment: "node"`, and `react` is not even resolvable from `test/` — so
 * anything that lives inside a component is a thing this suite can only read. Every decision was
 * therefore pushed into `renderer/model/opening.ts` and is called here directly, which is why
 * `SKELETON_WIDTHS` is not in `Skeleton.tsx` and the row arithmetic is not in `Sidebar.tsx`.
 *
 * The last third reads the sources as text, in `motion.test.ts`'s manner and for its reason: what
 * is left after the pure part is the shape of a `switch` and the presence of an ARIA attribute,
 * and those are questions about the source. Coarse, and the alternative is a browser.
 *
 * The one thing here that is neither is `markSkeletonShown`, which is real module state and is
 * asserted by driving it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PHASES } from "@preman/desktop/engine/protocol.js";
import { CHANNELS } from "@preman/desktop/preload/bridge.js";
import { markRowsPainted, markSkeletonShown } from "@preman/desktop/renderer/phases.js";
import {
  openingState,
  openingTarget,
  skeletonRowCount,
  skeletonWidths,
  type OpeningInputs,
} from "@preman/desktop/renderer/model/opening.js";

const DESKTOP_SRC = join(dirname(fileURLToPath(import.meta.url)), "../../packages/desktop/src");

function source(relative: string): string {
  return readFileSync(join(DESKTOP_SRC, relative), "utf8");
}

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/.*$/gm;

/** Comments are where the rule is written down, so they cannot be what satisfies it. */
function code(text: string): string {
  return text.replaceAll(BLOCK_COMMENT, "").replaceAll(LINE_COMMENT, "");
}

const SIDEBAR = code(source("renderer/panes/Sidebar.tsx"));
const APP = code(source("renderer/App.tsx"));
const SESSION = code(source("renderer/stores/session.ts"));
const SKELETON = code(source("renderer/ui/Skeleton.tsx"));
const PRELOAD = code(source("preload/preload.ts"));
const MAIN = code(source("main/main.ts"));
const APP_CSS = source("renderer/app.css");

/** The three states, so a pane that handles two of them is a failure and not a lint opinion. */
const OPENING_CASES = ['case "opening":', 'case "quiet":', 'case "idle":'] as const;

const SOME_ROOT = "/tmp/preman-workspace";
const OTHER_ROOT = "/tmp/preman-elsewhere";

/** Nothing open, nothing arriving, nothing broken: a first run. */
const IDLE_INPUTS: OpeningInputs = { reopening: null, sessionRoot: null, catalogRoot: null, failed: false };

const DELAY_ELAPSED = true;
const DELAY_PENDING = false;
const OPENING = true;
const NOT_OPENING = false;

/** The default row height, and two others, so nothing here is arithmetic that only works at 28. */
const ROW_HEIGHT_PX = 28;
const COMPACT_ROW_PX = 24;

const NO_ROWS = 0;
const ONE_ROW = 1;
const TEN_ROWS = 10;
const FULL_PERCENT = 100;

/** Counts of things that are not rows, named so that a `1` in an assertion says what it counts. */
const ONE_MARK = 1;
const ONE_ROLE = 1;
const ONE_WIDTH = 1;

/** The smallest row height there is, so the ceiling is the only thing left that can bound a count. */
const ONE_PIXEL_ROW = 1;

/** A height no pane has, to prove the count is bounded by something other than the caller. */
const ABSURD_HEIGHT_PX = 1_000_000;
const SANE_ROW_CEILING = 1_000;

describe("deciding that a workspace is opening", () => {
  it("givenNothingOpenAndNothingArriving_whenAsked_thenNoTarget", () => {
    expect(openingTarget(IDLE_INPUTS)).toBeNull();
  });

  /**
   * The case the whole feature exists for. No client, no catalog, and the only thing known is what
   * the main process said it was reopening — which is exactly the moment the app used to claim no
   * workspace was open.
   */
  it("givenAReopenHintAndNoClientYet_whenAsked_thenTheHintIsTheTarget", () => {
    expect(openingTarget({ ...IDLE_INPUTS, reopening: SOME_ROOT })).toBe(SOME_ROOT);
  });

  it("givenAClientWhoseCatalogHasNotLanded_whenAsked_thenItsRootIsTheTarget", () => {
    expect(openingTarget({ ...IDLE_INPUTS, sessionRoot: SOME_ROOT })).toBe(SOME_ROOT);
  });

  it("givenACatalogOnScreen_whenAsked_thenNoTarget", () => {
    expect(openingTarget({ ...IDLE_INPUTS, sessionRoot: SOME_ROOT, catalogRoot: SOME_ROOT })).toBeNull();
  });

  /**
   * A hint that outlived its port decides nothing. It names the workspace this launch started
   * with, and a user who has since switched away is looking at a different one.
   */
  it("givenAStaleHintBesideALiveCatalog_whenAsked_thenTheCatalogDecides", () => {
    const settled = { reopening: SOME_ROOT, sessionRoot: OTHER_ROOT, catalogRoot: OTHER_ROOT, failed: false };
    expect(openingTarget(settled)).toBeNull();
    // And while that switch is still in flight, it is the client's root and never the hint's.
    expect(openingTarget({ ...settled, catalogRoot: null })).toBe(OTHER_ROOT);
  });

  /** Both windows, closed by the same fact: a host that died is not slow, and the banner says so. */
  it("givenAHostFailureBeforeThePort_whenAsked_thenNoTarget", () => {
    expect(openingTarget({ ...IDLE_INPUTS, reopening: SOME_ROOT, failed: true })).toBeNull();
  });

  it("givenAHostFailureAfterThePort_whenAsked_thenNoTarget", () => {
    expect(openingTarget({ ...IDLE_INPUTS, sessionRoot: SOME_ROOT, failed: true })).toBeNull();
  });
});

describe("what a pane draws while it waits", () => {
  it("givenNotOpening_whenResolved_thenIdleWhateverTheClockSays", () => {
    expect(openingState(NOT_OPENING, DELAY_PENDING)).toBe("idle");
    expect(openingState(NOT_OPENING, DELAY_ELAPSED)).toBe("idle");
  });

  /** The flash guard: opening, but not for long enough to be worth interrupting the user over. */
  it("givenOpeningInsideTheDelay_whenResolved_thenQuiet", () => {
    expect(openingState(OPENING, DELAY_PENDING)).toBe("quiet");
  });

  it("givenOpeningPastTheDelay_whenResolved_thenOpening", () => {
    expect(openingState(OPENING, DELAY_ELAPSED)).toBe("opening");
  });
});

describe("filling a pane with placeholder rows", () => {
  it("givenAPaneAnExactNumberOfRowsTall_whenCounted_thenThatManyRows", () => {
    expect(skeletonRowCount(ROW_HEIGHT_PX * TEN_ROWS, ROW_HEIGHT_PX)).toBe(TEN_ROWS);
  });

  /** A clipped last row is what a real list does, so the count rounds up rather than down. */
  it("givenAPaneWithHalfARowSpare_whenCounted_thenTheHalfRowCounts", () => {
    expect(skeletonRowCount(ROW_HEIGHT_PX * TEN_ROWS + ROW_HEIGHT_PX / 2, ROW_HEIGHT_PX)).toBe(TEN_ROWS + ONE_ROW);
  });

  it("givenADenserRowHeight_whenCounted_thenMoreRowsFit", () => {
    const height = ROW_HEIGHT_PX * TEN_ROWS;
    expect(skeletonRowCount(height, COMPACT_ROW_PX)).toBeGreaterThan(skeletonRowCount(height, ROW_HEIGHT_PX));
  });

  /** The first render, before the pane has been measured. One bar, never none. */
  it("givenAnUnmeasuredPane_whenCounted_thenOneRow", () => {
    expect(skeletonRowCount(NO_ROWS, ROW_HEIGHT_PX)).toBe(ONE_ROW);
  });

  it("givenANonsensicalRowHeight_whenCounted_thenOneRow", () => {
    expect(skeletonRowCount(ROW_HEIGHT_PX * TEN_ROWS, NO_ROWS)).toBe(ONE_ROW);
    expect(skeletonRowCount(ROW_HEIGHT_PX * TEN_ROWS, -ROW_HEIGHT_PX)).toBe(ONE_ROW);
  });

  /** A bad measurement is a bug; thousands of pulsing nodes because of one is a worse bug. */
  it("givenAnAbsurdHeight_whenCounted_thenTheCountIsBounded", () => {
    expect(skeletonRowCount(ABSURD_HEIGHT_PX, ONE_PIXEL_ROW)).toBeLessThan(SANE_ROW_CEILING);
  });

  it("givenARowCount_whenWidthsAreTaken_thenThereIsOnePerRow", () => {
    expect(skeletonWidths(TEN_ROWS)).toHaveLength(TEN_ROWS);
    expect(skeletonWidths(NO_ROWS)).toHaveLength(NO_ROWS);
  });

  /**
   * Deterministic, and this is the case that says why: a skeleton re-renders on every resize, and
   * widths drawn from `Math.random()` would make the whole column twitch each time the sidebar was
   * dragged. Uneven is the point; unstable is a bug.
   */
  it("givenTheSameRowCountTwice_whenWidthsAreTaken_thenTheyAreIdentical", () => {
    expect(skeletonWidths(TEN_ROWS)).toStrictEqual(skeletonWidths(TEN_ROWS));
  });

  it("givenManyRows_whenWidthsAreTaken_thenTheyVaryAndStayOnThePane", () => {
    const widths = skeletonWidths(TEN_ROWS);
    expect(new Set(widths).size).toBeGreaterThan(ONE_WIDTH);
    for (const width of widths) {
      expect(width).toBeGreaterThan(NO_ROWS);
      expect(width).toBeLessThanOrEqual(FULL_PERCENT);
    }
  });
});

/**
 * The one mark this file drives rather than reads.
 *
 * Module state, so it is asserted once and in one case: a second case would find the flag already
 * spent. `requestAnimationFrame` is shimmed because there is no window, which also makes the
 * deferral itself observable — the mark is supposed to land after the paint it reports, so a
 * version that marked inline would show up here as a frame that was never queued.
 */
describe("marking that a placeholder was painted", () => {
  it("givenBothMarksCalledTwice_whenFramesAreCounted_thenEachQueuedExactlyOne", () => {
    const frames: (() => void)[] = [];
    const host = globalThis as { requestAnimationFrame?: unknown };
    host.requestAnimationFrame = (callback: () => void): number => frames.push(callback);

    try {
      markSkeletonShown();
      markSkeletonShown();
      // Its own flag, not a shared one: two facts about one open, and the first must not silence
      // the second.
      markRowsPainted();
      markRowsPainted();

      expect(frames).toHaveLength(2);
      for (const frame of frames) frame();
      expect(performance.getEntriesByName(PHASES.rendererSkeletonShown, "mark")).toHaveLength(ONE_MARK);
      expect(performance.getEntriesByName(PHASES.rendererRowsPainted, "mark")).toHaveLength(ONE_MARK);
    } finally {
      delete host.requestAnimationFrame;
    }
  });
});

/**
 * The wiring, read as text.
 *
 * Everything below is a question the pure cases above cannot reach: which component a state
 * resolves to, whether a screen reader is told about rows that do not exist, and whether the two
 * processes that carry the pre-port hint spell the same channel.
 */
describe("the panes that draw the wait", () => {
  it("givenTheSidebar_whenItHasNoTree_thenItHandlesAllThreeOpeningStates", () => {
    expect(SIDEBAR).toContain("useOpening()");
    for (const branch of OPENING_CASES) expect(SIDEBAR, branch).toContain(branch);
    expect(SIDEBAR).toContain("<SkeletonTree />");
    // The sentence the whole plan is about is still there, and now only on the idle branch.
    expect(SIDEBAR).toContain("No workspace open.");
  });

  it("givenTheEditor_whenItHasNoTab_thenItHandlesAllThreeOpeningStates", () => {
    expect(APP).toContain("useOpening()");
    for (const branch of OPENING_CASES) expect(APP, branch).toContain(branch);
    expect(APP).toContain("<SkeletonEditor />");
    expect(APP).toContain("No request open.");
  });

  /**
   * The placeholder rows must not be tree items. `perf.app.test.ts` waits for the first
   * `[role="treeitem"]` to decide a workspace is open, so a skeleton row wearing that role would
   * make every launch in that suite return on a bar that holds nothing.
   */
  it("givenThePlaceholder_whenRead_thenItsRowsAreNeitherTreeItemsNorAnnounced", () => {
    expect(SKELETON).not.toContain("treeitem");
    expect(SKELETON).toContain('aria-busy="true"');
    expect(SKELETON).toContain('aria-hidden="true"');
    // One live line for the whole region, and it is the only `role` in the file.
    expect(SKELETON).toContain('role="status"');
    expect(SKELETON.match(/role="/g)).toHaveLength(ONE_ROLE);
  });

  it("givenThePlaceholder_whenMounted_thenItMarksThePhase", () => {
    expect(SKELETON).toContain("markSkeletonShown()");
  });

  /** Density owns the row height, here as everywhere: a virtualizer's number is not a literal. */
  it("givenThePlaceholderTree_whenSized_thenItReadsDensityAndMeasuresThePane", () => {
    expect(SIDEBAR).toContain("useDensityTokens().row");
    expect(SIDEBAR).toContain("skeletonRowCount(");
    expect(SIDEBAR).toContain("ResizeObserver");
  });
});

/**
 * The opening state's one unbounded escape, closed.
 *
 * Plan 021 refused to bound this state with a timeout on the grounds that "a hang with neither is
 * a broken host registry" — and it was reachable, because a host that died while serving settled
 * nothing. Both halves are asserted: the model already leaves `opening` on a failure, and the
 * session is now the thing that produces one when the port dies.
 */
describe("an engine that dies while a workspace is opening", () => {
  it("givenAnOpeningWorkspace_whenTheEngineDies_thenTheSkeletonGivesWayToTheBanner", () => {
    const opening = { ...IDLE_INPUTS, sessionRoot: SOME_ROOT };
    expect(openingState(openingTarget(opening) !== null, DELAY_ELAPSED)).toBe("opening");

    // The one thing that changed is the failure, and it is the only thing that had to.
    const died = { ...opening, failed: true };
    expect(openingState(openingTarget(died) !== null, DELAY_ELAPSED)).toBe("idle");
  });

  /** Where the failure comes from now. Nothing else in the renderer subscribes to a dead port. */
  it("givenTheSession_whenAPortArrives_thenItSubscribesToTheClosureThatEndsTheWait", () => {
    const handler = /client\.onClose\(\(\) => \{([\s\S]*?)\n {4}\}\);/.exec(SESSION);
    expect(handler).not.toBeNull();
    expect(handler?.[1] ?? "").toContain("setHostFailure({");
  });
});

describe("the pre-port hint", () => {
  it("givenTheSession_whenItConnects_thenItReadsTheHintAndDropsItOnAPort", () => {
    expect(SESSION).toContain("bridge.reopening()");
    expect(SESSION).toContain("setReopening(null)");
  });

  /** Both sides of the channel, from the record both of them import. */
  it("givenTheHintChannel_whenTheProcessesAreRead_thenBothSpellItFromTheRecord", () => {
    expect(CHANNELS.readReopening).toBe("preman:read-reopening");
    expect(PRELOAD).toContain("CHANNELS.readReopening");
    expect(MAIN).toContain("CHANNELS.readReopening");
  });

  /**
   * Asynchronous on purpose. Decision 022 argues for exactly one blocking channel, and this is not
   * a second one — so a `sendSync` appearing beside it is a change to that decision and not a
   * detail.
   */
  it("givenTheHintChannel_whenThePreloadIsRead_thenItIsNotSynchronous", () => {
    expect(PRELOAD).not.toMatch(/sendSync\([^)]*readReopening/);
  });
});

describe("the placeholder's motion", () => {
  it("givenTheStylesheet_whenRead_thenThePulseIsDeclaredAndClassed", () => {
    expect(APP_CSS).toContain("@keyframes skeleton-pulse");
    expect(APP_CSS).toContain(".skeleton-block");
  });

  /**
   * Opacity and nothing else. A skeleton is a promise about where things will be, and a bar that
   * also slides or grows breaks that promise once a second — which is also why this is not simply
   * a second `inflight-sweep`.
   */
  it("givenThePulse_whenRead_thenItAnimatesOpacityAlone", () => {
    const pulse = /@keyframes skeleton-pulse\s*\{([\s\S]*?)\n {2}\}/.exec(APP_CSS);
    expect(pulse).not.toBeNull();
    const body = pulse?.[1] ?? "";
    expect(body).toContain("opacity");
    expect(body).not.toContain("transform");
    expect(body).not.toContain("width");
  });

  /** A colour is a token, never a hex, and a placeholder bar is no exception. */
  it("givenThePlaceholderClass_whenRead_thenItsColourIsAToken", () => {
    const block = /\.skeleton-block\s*\{([\s\S]*?)\n {2}\}/.exec(APP_CSS);
    expect(block).not.toBeNull();
    const body = block?.[1] ?? "";
    expect(body).toContain("var(--color-line)");
    expect(body).not.toMatch(/#[0-9a-f]{3,8}/i);
  });
});
