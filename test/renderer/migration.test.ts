import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { barScale, phaseMessage, progressDetail } from "@preman/desktop/renderer/model/migration.js";
import type { MigrationProgress } from "@preman/desktop/preload/bridge.js";

/**
 * The migration pane's arithmetic and wording, asserted where they live rather than through a
 * component nothing here can render — the same split `opening.test.ts` makes for the skeleton.
 *
 * The last third reads the two sources as text, in that file's manner and for its reason: what is
 * left after the pure part is the presence of an ARIA attribute, and both of the ones below are
 * load-bearing enough that losing one silently would be a real regression for one reader.
 */

const FALLBACK = "Migrating…";

const RENDERER_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../packages/desktop/src/renderer");
const PROGRESS_SOURCE = readFileSync(join(RENDERER_DIR, "ui/Progress.tsx"), "utf8");
const PANE_SOURCE = readFileSync(join(RENDERER_DIR, "panes/MigratePane.tsx"), "utf8");
const NOT_FOUND = -1;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/.*$/gm;

/**
 * The slice of a source between two anchors, failing loudly rather than asserting over "".
 *
 * Comments are stripped first, the way `motion.test.ts` does it: every attribute below is named in
 * the prose explaining why it is or is not there, and a case that matched the explanation instead
 * of the code would pass with the code deleted.
 */
function between(source: string, from: string, to: string): string {
  const code = source.replaceAll(BLOCK_COMMENT, "").replaceAll(LINE_COMMENT, "");
  const start = code.indexOf(from);
  const end = code.indexOf(to);
  expect(start, from).not.toBe(NOT_FOUND);
  expect(end, to).toBeGreaterThan(start);
  return code.slice(start, end);
}

const at = (over: Partial<MigrationProgress>): MigrationProgress => ({
  phase: "reading-collections",
  done: 0,
  total: undefined,
  calls: 0,
  ...over,
});

describe("barScale", () => {
  it("givenNoProgress_whenScaled_thenTheBarIsEmpty", () => {
    expect(barScale(0, 41)).toBe(0);
  });

  it("givenAlmostEveryUnit_whenScaled_thenItIsShortOfWhole", () => {
    // The invariant: a visibly complete bar must mean completed work. Rounding would break it here.
    expect(barScale(675, 684)).toBeLessThan(1);
    expect(barScale(683, 684)).toBeLessThan(1);
  });

  it("givenEveryUnit_whenScaled_thenItIsWhole", () => {
    expect(barScale(41, 41)).toBe(1);
  });

  it("givenNoUnitsAtAll_whenScaled_thenItIsWhole", () => {
    // A workspace with no environments. An empty bar there would read as stuck forever.
    expect(barScale(0, 0)).toBe(1);
  });

  it("givenMoreDoneThanTotal_whenScaled_thenItStopsAtWhole", () => {
    // Cannot happen from core today, and a bar overflowing its track is not how it should show up.
    expect(barScale(50, 41)).toBe(1);
  });
});

describe("phaseMessage", () => {
  it("givenAKnownPhase_whenAsked_thenItReadsAsASentence", () => {
    expect(phaseMessage("reading-collections", FALLBACK)).toBe("Reading collections…");
  });

  it("givenAPhaseThisWindowPredates_whenAsked_thenItFallsBackRatherThanShowingAnIdentifier", () => {
    expect(phaseMessage("reticulating-splines", FALLBACK)).toBe(FALLBACK);
  });
});

describe("progressDetail", () => {
  it("givenAKnownTotal_whenDescribed_thenBothCountsAreThere", () => {
    expect(progressDetail(at({ done: 12, total: 41, calls: 327 }))).toBe("12 of 41 · 327 reads");
  });

  it("givenAnUnknowableTotal_whenDescribed_thenOnlyTheReadsAreClaimed", () => {
    // No "0 of 0", which would be a proportion invented to fill the space.
    expect(progressDetail(at({ phase: "converting", calls: 1245 }))).toBe("1245 reads");
  });
});

describe("what the pane says to a screen reader", () => {
  it("givenAnUnknowableTotal_whenDrawn_thenTheBarClaimsNoValue", () => {
    // The absence of `aria-valuenow` is how ARIA spells indeterminate. A zero there would be a
    // claim that no progress has been made, rather than that none can be measured.
    const indeterminate = between(PROGRESS_SOURCE, "if (total === undefined)", "aria-valuemin");

    expect(indeterminate).toContain('role="progressbar"');
    expect(indeterminate).not.toContain("aria-valuenow");
  });

  it("givenAMigration_whenRunning_thenThePhaseIsLiveAndTheCountsAreNot", () => {
    // One sentence per phase is a report. A live region reading out a number that changes a
    // hundred times is a barrage, and the counts are already on the `progressbar` for anyone who
    // wants them.
    const counts = between(PANE_SOURCE, "{progress !== undefined &&", "progressDetail(progress)");

    expect(PANE_SOURCE).toContain('aria-live="polite"');
    expect(counts).toContain('aria-hidden="true"');
  });
});
