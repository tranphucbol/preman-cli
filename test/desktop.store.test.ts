/**
 * What survives a restart, and what a state file from another build costs.
 *
 * The interesting case is the one that has no version bump behind it. Preferences were added to a
 * shape that was already at version 1 and already on disk, so every existing install reads a file
 * with no `preferences` key at all. That has to come back as the defaults with the workspaces
 * intact — filling in a new field is not a migration, and treating it as one would trade someone's
 * whole workspace list for a colour they never chose.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAppStore, type AppState } from "@preman/desktop/main/store.js";
import { DEFAULT_PREFERENCES, type Preferences, type SessionTab } from "@preman/desktop/preload/bridge.js";

const STATE_FILE = "state.json";
const ENCODING = "utf8";
const CURRENT_VERSION = 1;
const FUTURE_VERSION = 99;
const A_ROOT = "/tmp/some-workspace";
const A_NODE = "postman/Demo.postman_collection/Ping.grpc";

const dirs: string[] = [];

function userData(): string {
  const dir = mkdtempSync(join(tmpdir(), "preman-store-"));
  dirs.push(dir);
  return dir;
}

function seed(dir: string, raw: unknown): void {
  writeFileSync(join(dir, STATE_FILE), JSON.stringify(raw), ENCODING);
}

function stored(dir: string): AppState {
  return JSON.parse(readFileSync(join(dir, STATE_FILE), ENCODING)) as AppState;
}

const CHOSEN: Preferences = {
  themeId: "nord-dark",
  density: "compact",
  editorFontSize: 14,
  fontMono: "Iosevka",
  fontSans: null,
  canvas: "#2e3440",
  barHeightPx: 36,
  sharedProtoRoot: null,
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("app store preferences", () => {
  it("givenNoStateFile_whenRead_thenPreferencesAreTheDefaults", () => {
    expect(createAppStore(userData()).read().preferences).toEqual(DEFAULT_PREFERENCES);
  });

  it("givenAVersionOneFileWithoutPreferences_whenRead_thenDefaultsFillInAndWorkspacesSurvive", () => {
    const dir = userData();
    seed(dir, {
      version: CURRENT_VERSION,
      window: { x: null, y: null, width: 1440, height: 900 },
      activeRoot: A_ROOT,
      workspaces: [{ root: A_ROOT, lastOpenedAt: 1, activeNodeId: null, collapsedIds: [], tabs: [], drafts: [] }],
    });

    const state = createAppStore(dir).read();
    expect(state.preferences).toEqual(DEFAULT_PREFERENCES);
    expect(state.activeRoot).toBe(A_ROOT);
    expect(state.workspaces).toHaveLength(1);
  });

  it("givenPreferencesWereSaved_whenReopened_thenTheyComeBackUnchanged", () => {
    const dir = userData();
    createAppStore(dir).update((state) => {
      state.preferences = CHOSEN;
    });

    expect(createAppStore(dir).read().preferences).toEqual(CHOSEN);
    expect(stored(dir).preferences).toEqual(CHOSEN);
  });

  it("givenAPartialPreferenceRecord_whenRead_thenOnlyTheMissingFieldsFallBack", () => {
    const dir = userData();
    seed(dir, {
      version: CURRENT_VERSION,
      window: { x: null, y: null, width: 1440, height: 900 },
      preferences: { themeId: "gruvbox-light", density: "comfortable" },
      activeRoot: null,
      workspaces: [],
    });

    expect(createAppStore(dir).read().preferences).toEqual({
      ...DEFAULT_PREFERENCES,
      themeId: "gruvbox-light",
      density: "comfortable",
    });
  });

  // A version this build does not know is the one case where the whole file is discarded. That is
  // the existing contract and it is why adding a field must not bump the number.
  it("givenAFileFromAnotherVersion_whenRead_thenEverythingIsDefaulted", () => {
    const dir = userData();
    seed(dir, { version: FUTURE_VERSION, preferences: CHOSEN, activeRoot: A_ROOT, workspaces: [{ root: A_ROOT }] });

    const state = createAppStore(dir).read();
    expect(state.preferences).toEqual(DEFAULT_PREFERENCES);
    expect(state.workspaces).toEqual([]);
  });

  it("givenACorruptFile_whenRead_thenTheAppStillStarts", () => {
    const dir = userData();
    writeFileSync(join(dir, STATE_FILE), "{ not json", ENCODING);

    expect(createAppStore(dir).read().preferences).toEqual(DEFAULT_PREFERENCES);
  });
});

describe("what a saved tab carries", () => {
  it("givenTabInPreview_whenPersisted_thenOnlyNodeIdAndSubTabAreWritten", () => {
    const dir = userData();

    // `saveSession` copies a tab field by field rather than spreading it, which is what keeps a
    // view state out of app data. Sent here with a `bodyView` on it — the shape the renderer's
    // `Tab` has and its `SessionTab` deliberately does not — so the copy is the thing under test
    // and not the type that usually stops this.
    createAppStore(dir).saveSession(A_ROOT, {
      activeEnvironment: null,
      activeNodeId: A_NODE,
      collapsedIds: [],
      tabs: [{ nodeId: A_NODE, subTab: "body", bodyView: "preview" } as SessionTab],
      drafts: [],
    });

    const [tab] = stored(dir).workspaces[0]?.tabs ?? [];
    expect(tab).toEqual({ nodeId: A_NODE, subTab: "body" });
    // The assertion that matters: the key is gone, not merely undefined. Reopening the workspace
    // therefore has nothing to restore and the tab comes back in Edit.
    expect(Object.keys(tab ?? {})).toEqual(["nodeId", "subTab"]);
  });
});
