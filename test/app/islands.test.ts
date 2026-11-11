/**
 * The islands window (ADR 058), measured in the built app rather than asserted on class names: the
 * gap and the corner are what the compositor drew, the title bar is the frame's colour, and switching
 * to Classic in Settings changes the tokens without remounting the shell. Gated behind
 * `PREMAN_APP=1`; see `harness.ts`.
 *
 *   bun run test:app          on this machine
 *   bun run test:app:linux    in the Linux box, under Xvfb
 */
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import { frameColors } from "@preman/desktop/renderer/appearance/islands.js";
import { THEMES } from "@preman/desktop/renderer/appearance/themes/index.js";
import { DEFAULT_PREFERENCES, type Density, type WindowStyle } from "@preman/desktop/preload/bridge.js";

import { FIXTURE_WS } from "../helpers.js";
import { APP_TESTS_ENABLED, closeApp, launchApp, LAUNCH_TIMEOUT_MS, type LaunchedApp } from "./harness.js";

const APP_TEST_TIMEOUT_MS = 120_000;
const SWITCH_TIMEOUT_MS = 5_000;
const POLL_MS = 100;

/** ADR 058's island sizes for the two densities measured here. */
const ISLAND_SIZES: Record<Extract<Density, "default" | "compact">, { gap: string; radius: string }> = {
  default: { gap: "5px", radius: "10px" },
  compact: { gap: "4px", radius: "8px" },
};
const CLASSIC_RADIUS = "0px";

const OPEN_TAB_SELECTOR = '[role="tablist"][aria-label="Open requests"] [role="tab"]';
const REQUEST_ROW_SELECTOR = '[role="treeitem"]:not([aria-expanded])';
/** The fixture request with a message body, so its tab opens a message editor. */
const REQUEST = "Echo";
const EDITOR_SELECTOR = ".cm-content";
const SEARCH_LABEL = "Search the workspace";
const SEARCH_SHORTCUT = "ControlOrMeta+Shift+F";
const TYPED_MESSAGE = "islands-probe";
const TYPED_QUERY = "payments refund";
/** A caret placed mid-word, so a remount — which would put it at the end or nowhere — cannot pass. */
const CARET = 4;

/**
 * The page side of these tests. The root program has no `lib.dom`, so what is read from the page is
 * described here rather than typed as a DOM node, and every expression runs as a string.
 */
interface Shell {
  readonly gapVariable: string;
  readonly radiusVariable: string;
  readonly islandRadius: string;
  /** Window edge to island edge: the sidebar's left, the editor's right. */
  readonly leftInset: number;
  readonly rightInset: number;
  readonly titleBar: string;
  readonly frame: string;
  readonly canvas: string;
}

/**
 * Finds the sidebar and editor islands once, in the shell's order — sidebar, editor, console — and
 * keeps them on `window` so a later read can tell the same node from a remounted copy.
 */
const MARK_ISLANDS = `(() => {
  const [sidebar, editor, console] = document.querySelectorAll(".rounded-island");
  const row = document.querySelector('[role="treeitem"]');
  if (!console || !sidebar.contains(row)) throw new Error("the shell is not three islands, the tree's first");
  window.__islands = { editor, sidebar };
  return true;
})()`;

const READ_SHELL = `(() => {
  const root = getComputedStyle(document.documentElement);
  const { editor, sidebar } = window.__islands;
  const resolve = (variable) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(" + variable + ")";
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  };
  return {
    gapVariable: root.getPropertyValue("--spacing-island-gap").trim(),
    radiusVariable: root.getPropertyValue("--radius-island").trim(),
    islandRadius: getComputedStyle(editor).borderTopLeftRadius,
    leftInset: sidebar.getBoundingClientRect().left,
    rightInset: window.innerWidth - editor.getBoundingClientRect().right,
    titleBar: getComputedStyle(document.querySelector("header")).backgroundColor,
    frame: resolve("--color-frame"),
    canvas: resolve("--color-canvas"),
  };
})()`;

const ISLANDS_CONNECTED = `(() => {
  const { editor, sidebar } = window.__islands;
  return editor.isConnected && sidebar.isConnected;
})()`;

let launched: LaunchedApp | undefined;

afterEach(async () => {
  await closeApp(launched);
  launched = undefined;
});

function readShell(page: Page): Promise<Shell> {
  return page.evaluate<Shell>(READ_SHELL);
}

async function nativeBackground(app: LaunchedApp["app"]): Promise<string | undefined> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBackgroundColor());
}

function defaultFrame(): string {
  const theme = THEMES.find((candidate) => candidate.id === DEFAULT_PREFERENCES.themeId);
  if (theme === undefined) throw new Error("the default theme is not bundled");
  return frameColors(theme).frame;
}

/** Through the Settings pane, as a user would: there is no other way to switch the style live. */
async function chooseWindowStyle(page: Page, style: WindowStyle): Promise<void> {
  const label = style === "islands" ? "Islands" : "Classic";
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const group = page.getByRole("radiogroup", { name: "Window style" });
  await group.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await group.getByText(label, { exact: true }).click();
  await waitUntil(async () => (await page.getByRole("radio", { name: new RegExp(`^${label}`) }).isChecked()) === true);
  await page.keyboard.press("Escape");
  await group.waitFor({ state: "detached", timeout: SWITCH_TIMEOUT_MS });
}

describe.runIf(APP_TESTS_ENABLED)("the islands window", () => {
  it.each(["default", "compact"] as const)(
    "given%sDensity_whenLaunched_thenTheIslandsSitTheirGapFromTheWindowEdgeWithTheirRadius",
    async (density) => {
      launched = await launchApp(FIXTURE_WS, { preferences: { density } });
      const { page } = launched;
      await page.evaluate(MARK_ISLANDS);
      const shell = await readShell(page);

      expect(shell.gapVariable).toBe(ISLAND_SIZES[density].gap);
      expect(shell.radiusVariable).toBe(ISLAND_SIZES[density].radius);
      expect(shell.islandRadius).toBe(ISLAND_SIZES[density].radius);
      expect(`${String(shell.leftInset)}px`).toBe(ISLAND_SIZES[density].gap);
      expect(`${String(shell.rightInset)}px`).toBe(ISLAND_SIZES[density].gap);
    },
    APP_TEST_TIMEOUT_MS,
  );

  it(
    "givenIslands_whenLaunched_thenTheTitleBarAndTheNativeWindowPaintTheFrame",
    async () => {
      launched = await launchApp(FIXTURE_WS);
      await launched.page.evaluate(MARK_ISLANDS);
      const shell = await readShell(launched.page);

      expect(shell.frame).not.toBe(shell.canvas);
      expect(shell.titleBar).toBe(shell.frame);
      expect((await nativeBackground(launched.app))?.toLowerCase()).toBe(defaultFrame().toLowerCase());
    },
    APP_TEST_TIMEOUT_MS,
  );

  /**
   * Settings replaces the editor while it is open, so the message editor is remounted by opening it
   * whatever the style does; what it can prove is that the typed text is still the tab's. The search
   * field in the sidebar island stays mounted throughout, and its uncommitted text and caret live
   * only in the DOM, so it is the probe for "switching the style remounts nothing".
   */
  it(
    "givenTypedTextAndACaret_whenTheStyleGoesToClassicAndBack_thenTheShellIsTheSameNodesAndKeepsThem",
    async () => {
      launched = await launchApp(FIXTURE_WS);
      const { page } = launched;
      // Before search swaps the tree out of the sidebar island; the island itself stays.
      await page.evaluate(MARK_ISLANDS);

      await page.locator(REQUEST_ROW_SELECTOR, { hasText: REQUEST }).first().click();
      await page.locator(OPEN_TAB_SELECTOR, { hasText: REQUEST }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const message = page.locator(EDITOR_SELECTOR).first();
      await message.click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type(TYPED_MESSAGE);

      await page.keyboard.press(SEARCH_SHORTCUT);
      const search = page.getByLabel(SEARCH_LABEL);
      await search.fill(TYPED_QUERY);
      await search.evaluate((input: ProbeInput, caret: number) => {
        input.dataset["probe"] = "kept";
        input.setSelectionRange(caret, caret);
      }, CARET);

      await chooseWindowStyle(page, "classic");
      await expectNothingRemounted(page, message);
      const classic = await readShell(page);

      expect(classic.radiusVariable).toBe(CLASSIC_RADIUS);
      expect(classic.islandRadius).toBe(CLASSIC_RADIUS);
      expect(classic.titleBar).toBe(classic.canvas);

      await chooseWindowStyle(page, "islands");
      await expectNothingRemounted(page, message);
      const islands = await readShell(page);

      expect(islands.radiusVariable).toBe(ISLAND_SIZES.default.radius);
      expect(islands.islandRadius).toBe(ISLAND_SIZES.default.radius);
      expect(islands.titleBar).toBe(islands.frame);
      expect((await nativeBackground(launched.app))?.toLowerCase()).toBe(defaultFrame().toLowerCase());
    },
    APP_TEST_TIMEOUT_MS,
  );
});

interface Probe {
  readonly kept: string | undefined;
  readonly value: string;
  readonly caret: number | null;
}

/** Checked before anything is measured: a remounted island would be measured detached, and read as `''`. */
async function expectNothingRemounted(page: Page, message: Locator): Promise<void> {
  await expect(page.evaluate<boolean>(ISLANDS_CONNECTED)).resolves.toBe(true);
  await expect(probeOf(page)).resolves.toStrictEqual({ kept: "kept", value: TYPED_QUERY, caret: CARET });
  await expect(message.textContent()).resolves.toContain(TYPED_MESSAGE);
}

/** The slice of an `<input>` the probe touches; the root program has no `lib.dom` to name it. */
interface ProbeInput {
  readonly dataset: Record<string, string | undefined>;
  readonly value: string;
  readonly selectionStart: number | null;
  setSelectionRange(start: number, end: number): void;
}

/** The search field's marker, text and caret; a remounted field has no marker and an empty box. */
function probeOf(page: Page): Promise<Probe> {
  return page.getByLabel(SEARCH_LABEL).evaluate((input: ProbeInput) => ({
    kept: input.dataset["probe"],
    value: input.value,
    caret: input.selectionStart,
  }));
}

/** `playwright-core` has no retrying `expect`, so a condition is polled. */
async function waitUntil(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + SWITCH_TIMEOUT_MS;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("The condition never held.");
    await new Promise((settled) => setTimeout(settled, POLL_MS));
  }
}
