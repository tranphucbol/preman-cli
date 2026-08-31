/**
 * The motion contract, for the two halves of it that are assertable without a window.
 *
 * Everything decision 26 adds is either a CSS transition or a Motion presence, and neither can be
 * observed here. What can is the token block those animations are spelled in, and the one-frame
 * `data-retheme` guard that stops a theme switch from animating sixty properties at once.
 *
 * So the tokens are read out of `app.css` as text. That is a coarse instrument and a deliberate
 * one: the alternative is a CSS parser in a test, and the four things worth pinning here — the
 * three curves exist, no duration is long enough to be in the way, `ease-in` is used nowhere, and
 * the curve that had to be duplicated into TypeScript still agrees with its token — are all
 * questions about the source text.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { applyPreferences } from "@preman/desktop/renderer/appearance/apply.js";
import { DEFAULT_PREFERENCES } from "@preman/desktop/preload/bridge.js";
import { premanDark } from "@preman/desktop/renderer/appearance/themes/preman-dark.js";

const RENDERER_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../packages/desktop/src/renderer");
const APP_CSS = readFileSync(join(RENDERER_DIR, "app.css"), "utf8");

/** The three the app declares. `--ease-in` is deliberately absent, which is what the third case is. */
const EASINGS = ["--ease-out", "--ease-in-out", "--ease-drawer"] as const;

/**
 * Long enough to read as motion, short enough that nobody waits for it. The ceiling is the
 * dialog's, and a token that wanted more than the dialog gets would be a token that has stopped
 * being feedback.
 */
const DURATION_CEILING_MS = 200;

/** `--ease-out`, as the four numbers every restatement of it in TypeScript has to keep matching. */
const EASE_OUT_POINTS = [0.23, 1, 0.32, 1];

/** The attribute `applyPreferences` hangs its suppression on, and the CSS rule that reads it. */
const RETHEME_ATTRIBUTE = "data-retheme";

/** The default theme, only because a theme is needed: the fence is under test here, not the values. */
const SOME_THEME = premanDark;

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/.*$/gm;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const DURATION_TOKEN = /--duration-([a-z]+):\s*([\d.]+)ms/g;
/** `ease-in` as a whole word: `ease-in-out` and `ease-in-expo` are other easings, not this one. */
const EASE_IN = /\bease-in\b(?!-)/;
/**
 * Tailwind's `transition-all`, and any arbitrary transition naming one of the three properties the
 * design system rules out. Not `height`: the console's call detail opens by height and is named in
 * that document as the one exception, so a rule that caught it would be a rule against the docs.
 */
const LAYOUT_TWEEN = /\btransition-\[[^\]]*\b(?:width|top|left|all)\b|\btransition-all\b/;
/**
 * The same rule against the stylesheet, which the scan above cannot see: it reads `.tsx`, so a
 * `transition: width` written in `app.css` would have gone through unremarked. `height` is left out
 * on purpose — `max-height` would trip a word boundary, and the one height animation in the app is
 * the console's call detail, which is Motion and not CSS.
 */
const LAYOUT_TWEEN_CSS = /transition:[^;}]*\b(?:width|top|left|flex-grow|all)\b[^;}]*/g;
/** The exception `docs/design-system.md` names, spelled exactly as the rule that is allowed to be it. */
const SIDEBAR_SLIDE = "transition: flex-grow var(--duration-panel) var(--ease-drawer)";
const MOTION_CURVE = /ease:\s*\[([^\]]+)\]/g;
const CSS_CURVE = /cubic-bezier\(([^)]+)\)/g;

/** The one module allowed to reach for the projection engine, and the price of it in bytes. */
const TAB_MODULE = "ui/Tabs.tsx";
const LAYOUT_PROJECTION = /\blayoutId\b/;
/** A `layoutId` given a literal is a `layoutId` two mounted panes can collide on. */
const LITERAL_LAYOUT_ID = /layoutId=(?:"|\{`|\{")/;
/** What a hand-rolled tab underline looks like: an accent border switched on by Radix's own state. */
const OWN_TAB_UNDERLINE = /data-\[state=active\]:border-accent/;

/** The tree whose rows slide, and the property that is the difference between sliding and not. */
const SIDEBAR_MODULE = "panes/Sidebar.tsx";
const ROW_TRANSFORM = /transform:\s*`translateY\(\$\{offset\}px\)`/;

/** Every hand-written renderer source. The generated themes are colour tables and carry no motion. */
function rendererSources(): readonly { readonly path: string; readonly text: string }[] {
  return readdirSync(RENDERER_DIR, { recursive: true, encoding: "utf8" })
    .filter((entry) => /\.tsx?$/.test(entry) && !entry.includes("appearance/themes/"))
    .map((entry) => ({ path: entry, text: readFileSync(join(RENDERER_DIR, entry), "utf8") }));
}

/** Comments say `ease-in` on purpose - they are where the rule is written down. */
function code(text: string): string {
  return text.replaceAll(BLOCK_COMMENT, "").replaceAll(LINE_COMMENT, "");
}

function numbers(list: string): number[] {
  return list.split(",").map((part) => Number(part.trim()));
}

/**
 * Only the surface `applyPreferences` touches, recording whether the guard was still on at the
 * moment of the forced flush — which is the ordering that makes the guard work at all, and the one
 * thing a before-and-after assertion cannot see.
 */
function guardWitness(): { readonly attributes: Set<string>; readonly held: boolean[]; readonly element: HTMLElement } {
  const attributes = new Set<string>();
  const held: boolean[] = [];
  const element = {
    style: {
      setProperty(): void {
        /* The values are `appearance.test.ts`'s subject, not this file's. */
      },
      removeProperty(): void {
        /* As above. */
      },
    },
    setAttribute(name: string): void {
      attributes.add(name);
    },
    removeAttribute(name: string): void {
      attributes.delete(name);
    },
    getBoundingClientRect(): DOMRect {
      held.push(attributes.has(RETHEME_ATTRIBUTE));
      return {} as DOMRect;
    },
  };
  return { attributes, held, element: element as unknown as HTMLElement };
}

/** A root that cannot be written to, to prove the `finally` and not the happy path. */
function hostileRoot(): { readonly attributes: Set<string>; readonly element: HTMLElement } {
  const attributes = new Set<string>();
  const element = {
    style: {
      setProperty(): never {
        throw new Error("no");
      },
      removeProperty(): void {
        /* Never reached: the first colour is written before the first font is cleared. */
      },
    },
    setAttribute(name: string): void {
      attributes.add(name);
    },
    removeAttribute(name: string): void {
      attributes.delete(name);
    },
    getBoundingClientRect(): DOMRect {
      return {} as DOMRect;
    },
  };
  return { attributes, element: element as unknown as HTMLElement };
}

describe("the motion tokens", () => {
  it("givenAppCss_whenParsed_thenDeclaresTheThreeEasingTokens", () => {
    for (const easing of EASINGS) {
      expect(APP_CSS).toContain(`${easing}: cubic-bezier(`);
    }
  });

  it("givenAppCss_whenParsed_thenEveryDurationTokenIsAtMost200ms", () => {
    const durations = [...APP_CSS.matchAll(DURATION_TOKEN)].map(([, name, value]) => [name, Number(value)] as const);

    // The scale exists, or the loop below asserts nothing at all.
    expect(durations.length).toBeGreaterThan(0);
    for (const [name, ms] of durations) {
      expect(ms, `--duration-${name ?? ""}`).toBeLessThanOrEqual(DURATION_CEILING_MS);
    }
  });

  it("givenAppCss_whenParsed_thenNoRuleUsesEaseIn", () => {
    expect(APP_CSS.replaceAll(CSS_COMMENT, "")).not.toMatch(EASE_IN);
  });

  /*
   * The case above cannot fail on its own: `app.css` never declares `--ease-in`, so a stray
   * `ease-in` would arrive as a Tailwind utility in a component instead. Both halves of the rule
   * are one rule, so both are asserted.
   */
  it("givenTheRenderer_whenScanned_thenNothingUsesTheEaseInUtility", () => {
    const offenders = rendererSources()
      .filter((source) => EASE_IN.test(code(source.text)))
      .map((source) => source.path);

    expect(offenders).toEqual([]);
  });

  /*
   * A Motion transition cannot read a custom property, so three modules restate `--ease-out` as
   * numbers. Their comments say to change the token and change them; this is what makes that true.
   */
  it("givenTheRenderer_whenScanned_thenEveryRestatedCurveIsTheEaseOutToken", () => {
    expect(APP_CSS).toContain(`--ease-out: cubic-bezier(${EASE_OUT_POINTS.join(", ")})`);

    const restated = rendererSources().flatMap((source) => {
      const source_ = code(source.text);
      return [...source_.matchAll(MOTION_CURVE), ...source_.matchAll(CSS_CURVE)].map(([, list]) => ({
        path: source.path,
        points: numbers(list ?? ""),
      }));
    });

    expect(restated.length).toBeGreaterThan(0);
    for (const curve of restated) {
      expect(curve.points, curve.path).toEqual(EASE_OUT_POINTS);
    }
  });

  /*
   * `docs/design-system.md` says `width`, `top` and `all` animate nowhere, because the budgets in
   * decision 17 are blocking-time medians and those three are layout on every frame. It said so
   * for a while before anything checked, and the first progress bar written here animated `width`
   * — which is the argument for this case rather than against it. A fill scales from its origin.
   */
  it("givenTheRenderer_whenScanned_thenNothingTweensALayoutProperty", () => {
    const offenders = rendererSources()
      .filter((source) => LAYOUT_TWEEN.test(code(source.text)))
      .map((source) => source.path);

    expect(offenders).toEqual([]);
  });

  /*
   * And the one place the rule is broken, held to being exactly one place. A horizontally
   * collapsing pane has no transform that expresses it — translate and it covers the editor, scale
   * and the text distorts — so decision 34 spends layout on it and bounds the spend: one pane,
   * 180ms, armed only for a toggle. This case is what stops the second one being written by
   * pointing at the first.
   */
  it("givenAppCss_whenParsed_thenTheOnlyLayoutTweenIsTheSidebarSlide", () => {
    const tweens = [...APP_CSS.replaceAll(CSS_COMMENT, "").matchAll(LAYOUT_TWEEN_CSS)].map(([rule]) => rule.trim());

    expect(tweens).toEqual([SIDEBAR_SLIDE]);
  });
});

describe("the tab underline", () => {
  /*
   * `domMax` costs 46,815 bytes over `domAnimation`, and it was bought for one underline. Four
   * `layoutId`s later that is a different decision, made by nobody. This is where that surfaces.
   */
  it("givenTheRenderer_whenScanned_thenOnlyTheTabModuleUsesLayoutId", () => {
    const users = rendererSources()
      .filter((source) => LAYOUT_PROJECTION.test(code(source.text)))
      .map((source) => source.path);

    expect(users).toEqual([TAB_MODULE]);
  });

  /*
   * The identity has to come from `useId`, per instance. A literal fails invisibly - two mounted
   * `ResponseView`s, which is what an open collection runner is, would share one underline and
   * slide it across the window between panes. No test failure, no error, just a bug.
   */
  it("givenTheTabModule_whenParsed_thenTheUnderlineIdComesFromUseId", () => {
    const tabs = rendererSources().find((source) => source.path === TAB_MODULE);

    expect(tabs, TAB_MODULE).toBeDefined();
    expect(code(tabs?.text ?? "")).toContain("return useId();");
    for (const source of rendererSources()) {
      expect(code(source.text), source.path).not.toMatch(LITERAL_LAYOUT_ID);
    }
  });

  /*
   * Three tab groups used to declare the same trigger class in two files. They share one module
   * now, and a travelling underline only works if they do: the outgoing and incoming boxes have to
   * be measured off the same geometry. A fourth copy would look right and not move.
   */
  it("givenTheRenderer_whenScanned_thenNoPaneDeclaresItsOwnTabTriggerClass", () => {
    const offenders = rendererSources()
      .filter((source) => OWN_TAB_UNDERLINE.test(code(source.text)))
      .map((source) => source.path);

    expect(offenders).toEqual([]);
  });
});

describe("the sidebar row offset", () => {
  /*
   * The row slides on a toggle because its offset is a transform. Written as `top` it would still
   * arrive in the right place and animate nothing, and a `transition-transform` left behind on a
   * row positioned by `top` is a class that reads as motion and produces none. The two have to
   * agree, so this asserts on the style rather than on the class.
   */
  it("givenTheSidebar_whenParsed_thenARowIsPositionedByTransform", () => {
    const sidebar = rendererSources().find((source) => source.path === SIDEBAR_MODULE);

    expect(sidebar, SIDEBAR_MODULE).toBeDefined();
    expect(code(sidebar?.text ?? "")).toMatch(ROW_TRANSFORM);
  });

  /*
   * A density change moves every offset at once, and that is not a toggle. The list is remounted
   * on the row height so the new offsets have no previous transform to animate from; drop the key
   * and changing density in Settings slides the whole tree, which reads as a bug rather than as a
   * setting. Decision 26.
   */
  it("givenTheSidebar_whenParsed_thenTheListIsKeyedByRowHeight", () => {
    const sidebar = rendererSources().find((source) => source.path === SIDEBAR_MODULE);

    expect(code(sidebar?.text ?? "")).toContain("key={rowHeight}");
  });
});

describe("the theme-switch transition guard", () => {
  it("givenApplyPreferences_whenCalled_thenSetsAndRemovesTheRethemeAttribute", () => {
    const root = guardWitness();

    applyPreferences(SOME_THEME, DEFAULT_PREFERENCES, root.element);

    // Set for the writes, flushed while it was still set, and gone by the time the call returns:
    // a guard that outlived the call would turn every transition in the app off for good.
    expect(root.held).toEqual([true]);
    expect(root.attributes.has(RETHEME_ATTRIBUTE)).toBe(false);
  });

  it("givenApplyPreferences_whenItThrows_thenTheRethemeAttributeIsStillRemoved", () => {
    const root = hostileRoot();

    expect(() => {
      applyPreferences(SOME_THEME, DEFAULT_PREFERENCES, root.element);
    }).toThrow();

    // The case that matters: a leaked attribute here presents as "the animations stopped working
    // sometimes", which is a bug nobody traces back to a theme switch that failed once.
    expect(root.attributes.has(RETHEME_ATTRIBUTE)).toBe(false);
  });
});
