/**
 * The shell's surfaces under both window styles (ADR 058).
 *
 * What a class string looks like on screen is proved by eye; what is proved here is the choice -
 * that Classic gets exactly what it had before Islands existed, and that Islands reaches only for
 * tokens the theme defines.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// Both components read the window style from the appearance store, which reads the preload's
// preferences when it is created; these tests call only the pure halves, so an empty bridge will do.
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = { preman: { preferences: {} } };
});

import { handleClass } from "@preman/desktop/renderer/ui/Handle.js";
import { FRAME_SURFACE, ISLAND_SURFACE, islandClass } from "@preman/desktop/renderer/ui/Island.js";

const APP_CSS = readFileSync(new URL("../../packages/desktop/src/renderer/app.css", import.meta.url), "utf8");
const AXES = ["horizontal", "vertical"] as const;
const CLASSIC_COLUMN = "flex min-h-0 min-w-0 flex-1 flex-col";
const PLACEMENT = "ml-island-gap";

function classes(value: string): string[] {
  return value.split(/\s+/).filter((name) => name.length > 0);
}

describe("the island", () => {
  it("givenClassic_whenAnIslandIsDrawn_thenItIsThePlainColumnThePanesHadBefore", () => {
    expect(islandClass(false)).toBe(CLASSIC_COLUMN);
  });

  it("givenIslands_whenAnIslandIsDrawn_thenItIsTheRoundedCanvasCardWithAnInsetEdge", () => {
    const names = classes(islandClass(true));
    for (const name of ["rounded-island", "border", "border-island-edge", "bg-canvas", "overflow-hidden"])
      expect(names).toContain(name);
    expect(names).not.toContain("ring");
  });

  it("givenIslands_whenAnIslandIsDrawn_thenPanelIsRepointedToCanvasAndFocusOutlinesDrawInward", () => {
    const names = classes(ISLAND_SURFACE);
    expect(names).toContain("[--color-panel:var(--color-canvas)]");
    expect(names).toContain("[&_:focus-visible]:-outline-offset-2");
  });

  it("givenEitherStyle_whenAPlacementIsPassed_thenItIsAddedAndTheColumnKept", () => {
    for (const islands of [true, false]) {
      const names = classes(islandClass(islands, PLACEMENT));
      expect(names.at(-1)).toBe(PLACEMENT);
      for (const name of classes(CLASSIC_COLUMN)) expect(names).toContain(name);
    }
  });
});

describe("the frame surface", () => {
  it("givenTheFrameSurface_whenRead_thenPanelAndHoverAreRepointedToTheFrameTokens", () => {
    const names = classes(FRAME_SURFACE);
    expect(names).toContain("bg-panel");
    expect(names).toContain("[--color-panel:var(--color-frame)]");
    expect(names).toContain("[--color-hover:var(--color-frame-raised)]");
  });

  it("givenTheTokensTheShellNames_whenAppCssIsRead_thenEachIsDefined", () => {
    for (const token of ["--color-frame", "--color-frame-raised", "--color-island-edge", "--radius-island"])
      expect(APP_CSS).toContain(`${token}:`);
  });
});

describe("the pane boundary", () => {
  it.each(AXES.map((axis) => [axis] as const))(
    "givenClassic_whenTheBoundaryIsAGutter_%s_thenItIsStillTheOnePixelLine",
    (axis) => {
      expect(handleClass(axis, true, false)).toBe(handleClass(axis, false, false));
      expect(classes(handleClass(axis, true, false))).toContain(axis === "horizontal" ? "h-px" : "w-px");
    },
  );

  it.each(AXES.map((axis) => [axis] as const))(
    "givenIslands_whenTheBoundaryIsInsideAPane_%s_thenItIsStillTheOnePixelLine",
    (axis) => {
      expect(handleClass(axis, false, true)).toBe(handleClass(axis, false, false));
    },
  );

  it.each(AXES.map((axis) => [axis] as const))(
    "givenIslands_whenTheBoundaryIsAGutter_%s_thenItIsTheTransparentGapWithACentredBar",
    (axis) => {
      const names = classes(handleClass(axis, true, true));
      expect(names).toContain(axis === "horizontal" ? "h-island-gap" : "w-island-gap");
      expect(names).toContain(axis === "horizontal" ? "after:h-0.5" : "after:w-0.5");
      expect(names).not.toContain("bg-line");
      expect(names).toContain("data-[separator=hover]:after:bg-glyph");
      expect(names).toContain("data-[separator=active]:after:bg-accent");
      expect(names).toContain("focus-visible:after:bg-accent");
    },
  );
});
