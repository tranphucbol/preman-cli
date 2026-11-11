/**
 * Which Escape a pane may answer.
 *
 * Search, the variable manager and Settings all close on Escape, and a Radix layer or the sidebar's
 * search may already have answered the same press. The predicate is what stops one key closing two
 * things.
 */
import { describe, expect, it } from "vitest";

import { isUnclaimedEscape } from "@preman/desktop/renderer/ui/escape.js";

describe("answering Escape", () => {
  it("givenEscapeNobodyClaimed_whenChecked_thenThePaneMayClose", () => {
    expect(isUnclaimedEscape({ key: "Escape", defaultPrevented: false })).toBe(true);
  });

  it("givenEscapeACloserLayerClaimed_whenChecked_thenThePaneStaysOpen", () => {
    expect(isUnclaimedEscape({ key: "Escape", defaultPrevented: true })).toBe(false);
  });

  it("givenAnotherKey_whenChecked_thenThePaneStaysOpen", () => {
    expect(isUnclaimedEscape({ key: "Enter", defaultPrevented: false })).toBe(false);
  });
});
