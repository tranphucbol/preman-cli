/**
 * The appearance store's one job beyond holding values: every change is written to the document,
 * told to the native window and persisted, in that order, and all three agree on the window style.
 *
 * The store reads the bridge when its module is evaluated, so `window` and `document` are stubbed in
 * `vi.hoisted` — ahead of the import — rather than in a `beforeEach`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { densityTokens } from "@preman/desktop/renderer/appearance/density.js";
import { frameColors } from "@preman/desktop/renderer/appearance/islands.js";
import { useAppearanceStore } from "@preman/desktop/renderer/stores/appearance.js";
import type { Preferences, WindowChrome } from "@preman/desktop/preload/bridge.js";

const stub = vi.hoisted(() => {
  const calls: string[] = [];
  const written = new Map<string, string>();
  const chrome: WindowChrome[] = [];
  const saved: Preferences[] = [];
  const documentElement = {
    style: {
      setProperty(name: string, value: string): void {
        if (name === "--radius-island") calls.push("apply");
        written.set(name, value);
      },
      removeProperty(name: string): void {
        written.delete(name);
      },
    },
    setAttribute(): void {},
    removeAttribute(): void {},
    getBoundingClientRect(): object {
      return {};
    },
  };
  const bridge = {
    // A value no build of the app has written: a record from a newer build, or a hand-edited one.
    preferences: { windowStyle: "floating" },
    setWindowChrome(next: WindowChrome): void {
      calls.push("chrome");
      chrome.push(next);
    },
    savePreferences(next: Preferences): Promise<void> {
      calls.push("save");
      saved.push(next);
      return Promise.resolve();
    },
  };
  (globalThis as { window?: unknown }).window = { preman: bridge };
  (globalThis as { document?: unknown }).document = { documentElement };
  return { calls, written, chrome, saved };
});

beforeEach(() => {
  stub.calls.length = 0;
  stub.chrome.length = 0;
  stub.saved.length = 0;
  stub.written.clear();
});

describe("the appearance store's window style", () => {
  it("givenAStoredUnknownWindowStyle_whenTheStoreIsCreated_thenItHoldsIslands", () => {
    expect(useAppearanceStore.getState().preferences.windowStyle).toBe("islands");
  });

  it("givenIslands_whenClassicIsChosen_thenTheDocumentTheWindowAndTheRecordAgreeInThatOrder", () => {
    useAppearanceStore.getState().setWindowStyle("classic");
    const { theme, preferences } = useAppearanceStore.getState();
    const expected: WindowChrome = {
      background: theme.colors.canvas,
      barHeightPx: densityTokens(preferences.density).bar,
    };

    expect(stub.calls).toStrictEqual(["apply", "chrome", "save"]);
    expect(stub.written.get("--radius-island")).toBe("0px");
    expect(stub.chrome).toStrictEqual([expected]);
    expect(stub.saved).toStrictEqual([{ ...preferences, ...expected }]);
    expect(preferences.windowStyle).toBe("classic");
  });

  it("givenClassic_whenIslandsIsChosenAgain_thenTheWindowPaintsTheFrame", () => {
    useAppearanceStore.getState().setWindowStyle("classic");
    useAppearanceStore.getState().setWindowStyle("islands");
    const { theme, preferences } = useAppearanceStore.getState();

    expect(stub.written.get("--radius-island")).toBe(`${String(densityTokens(preferences.density).islandRadius)}px`);
    expect(stub.chrome.at(-1)?.background).toBe(frameColors(theme).frame);
    expect(stub.saved.at(-1)).toMatchObject({ windowStyle: "islands", background: frameColors(theme).frame });
  });
});
