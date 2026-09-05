/**
 * The banner's one structural promise: it never grows past the box it declares.
 *
 * The bug this file exists to stop is not subtle and was not caught by anything. Opening the gRPC
 * method picker against a workspace whose `.proto` declarations had gone stale produced twenty-two
 * warnings, `Banner` rendered twenty-two lines into a `shrink-0` strip that is a sibling of the
 * whole resizable workspace, and roughly five hundred pixels of notice pushed the editor and the
 * console off screen. A banner is chrome; chrome that can eat the window is a layout bug waiting
 * for a long enough list.
 *
 * Read as source text, for the reason `motion.test.ts` gives: the suite runs in `node` with no DOM,
 * so nothing here can render a component, and the three things worth pinning - the list scrolls,
 * the constant that describes how tall it is still agrees with the class that makes it so, and the
 * copy button that makes bounding it honest exists exactly once - are all questions about the text.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const RENDERER_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../packages/desktop/src/renderer");
const BANNER_MODULE = "ui/Banner.tsx";
const BANNER = readFileSync(join(RENDERER_DIR, BANNER_MODULE), "utf8");
const APP_CSS = readFileSync(join(RENDERER_DIR, "app.css"), "utf8");

/** Tailwind's default spacing step. `app.css` declares no `--spacing`, so `max-h-32` is 32 of these. */
const SPACING_REM = 0.25;

const DETAILS_CLASS = /const DETAILS_CLASS = "([^"]+)"/;
const VISIBLE_DETAILS = /const VISIBLE_DETAILS = (\d+)/;
const MAX_HEIGHT = /max-h-(\d+)/;
const DETAIL_LINE_HEIGHT = /--text-2xs--line-height:\s*([\d.]+)rem/;

/** What a bounded list is made of. Either one without the other is a class that does nothing. */
const SCROLLS = ["overflow-y-auto", "max-h-"] as const;

/**
 * The copy button's label, as the one string that identifies it. It is the escape hatch that makes
 * capping the visible list defensible - every detail line is still in what it writes - so a second
 * declaration of it means a second banner, which means a second thing to remember to cap.
 */
const COPY_LABEL = '"Copy error"';

function rendererSources(): readonly { readonly path: string; readonly text: string }[] {
  return readdirSync(RENDERER_DIR, { recursive: true, encoding: "utf8" })
    .filter((entry) => /\.tsx?$/.test(entry) && !entry.includes("appearance/themes/"))
    .map((entry) => ({ path: entry, text: readFileSync(join(RENDERER_DIR, entry), "utf8") }));
}

function captured(source: string, pattern: RegExp): string {
  const match = pattern.exec(source);
  expect(match?.[1], String(pattern)).toBeDefined();
  return match?.[1] ?? "";
}

describe("the banner's detail list", () => {
  it("givenTheBannerModule_whenParsed_thenTheDetailListScrolls", () => {
    const declared = captured(BANNER, DETAILS_CLASS);

    for (const part of SCROLLS) {
      expect(declared, part).toContain(part);
    }
    // The scroller is the inner list and not the strip: the strip carries `role="alert"` and the
    // action, and an action that scrolls out of reach is worse than the overflow it was capping.
    expect(BANNER).toContain("className={DETAILS_CLASS}");
  });

  /*
   * `VISIBLE_DETAILS` is a number describing a class, which is the same restatement problem the
   * duplicated easing curve has, and it fails the same way: silently, by disagreeing. The count
   * beside the message is drawn from it, so a drift means the banner says "12 issues" while showing
   * eleven of them, or stays silent while hiding three.
   */
  it("givenTheBannerModule_whenParsed_thenTheVisibleCountMatchesTheCappedHeight", () => {
    const heightRem = Number(captured(captured(BANNER, DETAILS_CLASS), MAX_HEIGHT)) * SPACING_REM;
    const lineRem = Number(captured(APP_CSS, DETAIL_LINE_HEIGHT));

    expect(lineRem).toBeGreaterThan(0);
    expect(heightRem / lineRem).toBe(Number(captured(BANNER, VISIBLE_DETAILS)));
  });
});

describe("the one banner", () => {
  /*
   * `App.tsx` carried a fifth copy of this component for a while - same idea, different class
   * string, its own unbounded stack - and capping only the shared one would have left the copy that
   * was actually on screen when this was reported. They are one component now. This is what stops
   * the sixth: a banner with its own copy button is a banner with its own everything else.
   */
  it("givenTheRenderer_whenScanned_thenOnlyTheBannerModuleDeclaresACopyButton", () => {
    const declarers = rendererSources()
      .filter((source) => source.text.includes(COPY_LABEL))
      .map((source) => source.path);

    expect(declarers).toEqual([BANNER_MODULE]);
  });
});
