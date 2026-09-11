/**
 * The Diagnostics section, read as source.
 *
 * There is no DOM in this project's Vitest environment and no renderer test that mounts a
 * component, so the same instrument the rest of `test/renderer/` uses applies here: the section is
 * read out of the `.tsx` as text. That is coarse, and for three of these four questions it is
 * enough — whether all four versions are named, whether the engine row branches on the failure, and
 * which of the two paths the reveal button is given are all questions about what the source says.
 *
 * The fourth is not a question about the section at all. "No log line is shown" is a property of
 * what crosses the wire, so it is asserted against `DiagnosticsInfo`: a pane cannot render a line
 * it was never handed one of. That is the assertion `docs/decisions/035` actually needs, and it
 * would survive this component being rewritten.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  INELIGIBILITY_REASON,
  LOCAL_NETWORK_CAVEAT,
  updateBanner,
  updateHeadline,
} from "@preman/desktop/renderer/model/update.js";

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../packages/desktop/src");
const SETTINGS = readFileSync(join(DESKTOP_DIR, "renderer/panes/SettingsPane.tsx"), "utf8");
const BRIDGE = readFileSync(join(DESKTOP_DIR, "preload/bridge.ts"), "utf8");

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/.*$/gm;
const NOTHING = "";

/** The section's body, from its `function` line to the first close at column zero. */
const DIAGNOSTICS_SECTION = /function DiagnosticsSection\(\)[\s\S]*?\n\}\n/;
const UPDATES_SECTION = /function UpdatesSection\(\)[\s\S]*?\n\}\n/;
/** The tab list the pane is split by. */
const SETTINGS_TABS = /const SETTINGS_TABS = \[([^\]]*)\] as const/;
/** Every `"quoted"` string in a matched fragment. */
const QUOTED = /"([^"]*)"/g;
const DIAGNOSTICS_INFO = /export interface DiagnosticsInfo \{([\s\S]*?)\n\}/;
/** Every `readonly name:` in an interface body. */
const FIELD = /readonly (\w+):/g;

/** The four a bug report needs: which build, which Electron, which Chromium, which Node. */
const VERSION_FIELDS = ["appVersion", "electronVersion", "chromeVersion", "nodeVersion"] as const;

/**
 * The whole of what main is allowed to answer with. Two paths and four version strings — no array,
 * no body, nothing that could hold a line of the log. Decision 035 is the reason.
 */
const DIAGNOSTICS_FIELDS = [
  "logFile",
  "directory",
  "appVersion",
  "electronVersion",
  "chromeVersion",
  "nodeVersion",
] as const;

/**
 * Appearance holds Theme, Density and Type; the other three are not under them. Protos sits second
 * because where this machine resolves the shared root is neither a matter of taste nor a bug
 * report, and it is the only setting here that restarts every engine. Resources is last, and is a
 * tab rather than a section for a second reason on top of that one: an inactive Radix tab is
 * unmounted, and that unmount is what stops the sampler in main. Decision 040.
 */
const TABS = ["appearance", "protos", "diagnostics", "resources"] as const;

/** A bottom border on a trigger looks like the underline and cannot travel. `design-system.md`. */
const HAND_ROLLED_UNDERLINE = "border-b-2 border-accent";

function code(source: string): string {
  return source.replace(BLOCK_COMMENT, NOTHING).replace(LINE_COMMENT, NOTHING);
}

function section(): string {
  const found = DIAGNOSTICS_SECTION.exec(code(SETTINGS));
  expect(found).not.toBeNull();
  return found?.[0] ?? NOTHING;
}

describe("the Settings pane's Diagnostics section", () => {
  it("givenTheDiagnosticsSection_whenItRenders_thenTheFourVersionsAreShown", () => {
    const body = section();

    for (const field of VERSION_FIELDS) expect(body).toContain(field);
  });

  it("givenAHostFailure_whenTheDiagnosticsSectionRenders_thenTheEngineRowSaysSo", () => {
    const body = section();

    // Read from the session store rather than from a second source of truth: the banner and this
    // row disagreeing about whether the engine is up would be worse than the row not existing.
    expect(body).toContain("state.hostFailure !== null");
    expect(body).toContain("ENGINE_STOPPED");
    expect(body).toContain("ENGINE_RUNNING");
  });

  it("givenTheRevealButton_whenItIsPressed_thenTheDirectoryIsRevealedNotTheFile", () => {
    const body = section();

    // The directory, because `preman.log.1` is half of what a report wants and the file manager
    // showing the folder gives both.
    expect(body).toContain("revealInFileManager(info.directory)");
    expect(body).not.toContain("revealInFileManager(info.logFile)");
  });

  it("givenTheDiagnosticsSection_whenItRenders_thenNoLogLineIsShown", () => {
    const found = DIAGNOSTICS_INFO.exec(code(BRIDGE));
    expect(found).not.toBeNull();

    const fields = [...(found?.[1] ?? NOTHING).matchAll(FIELD)].map(([, name]) => name);

    expect(fields).toEqual([...DIAGNOSTICS_FIELDS]);
    expect(section()).not.toContain("lines");
  });
});

/**
 * The Updates section, read two ways.
 *
 * What the section *says* is not in the `.tsx` at all — it is `model/update.ts`, which is pure and
 * importable, so those three cases are behaviour rather than text. What is left for the source
 * reading is the two structural promises the model cannot make: that the caveat is drawn only when
 * an update is staged, and that nothing here installs anything without a press.
 */
describe("the Settings pane's Updates section", () => {
  it("givenAnAvailableUpdate_whenTheUpdatesSectionRenders_thenTheVersionAndActionAreShown", () => {
    const headline = updateHeadline({
      phase: "available",
      version: "1.4.0",
      notesUrl: "https://example.invalid",
      sizeBytes: 134_217_728,
    });

    // The size, because the one thing a user weighs before pressing Download is how long it takes.
    expect(headline).toContain("1.4.0");
    expect(headline).toContain("128 MB");

    const source = code(SETTINGS);
    // Skip sits beside Download on `available` and nowhere else: before a check there is nothing
    // to skip, and after a download there is a staged bundle skipping would silently discard.
    expect(source).toContain("skipUpdate(status.version)");
    expect(source).toContain("downloadUpdate()");
  });

  it("givenAnUnsupportedApp_whenTheUpdatesSectionRenders_thenTheReasonIsNamed", () => {
    // Every refusal is a different sentence, and each names the fix where there is one. A pane
    // that said "cannot update" five times would be a pane nobody could act on.
    const sentences = Object.values(INELIGIBILITY_REASON);
    expect(new Set(sentences).size).toBe(sentences.length);

    expect(updateHeadline({ phase: "unsupported", reason: "translocated" })).toBe(INELIGIBILITY_REASON.translocated);
    // Decision 10: no `osascript … with administrator privileges`, so the answer is the DMG.
    expect(INELIGIBILITY_REASON.notWritable).toContain("DMG");
  });

  it("givenAReadyUpdate_whenTheUpdatesSectionRenders_thenTheLocalNetworkCaveatIsShown", () => {
    const found = UPDATES_SECTION.exec(code(SETTINGS));
    expect(found).not.toBeNull();
    const body = found?.[0] ?? NOTHING;

    // A hint and not a `Banner`: this is true of every update the app will ever install, and a bar
    // that said it would be a bar that said it forever.
    expect(body).toContain('status.phase === "ready" && ');
    expect(body).toContain("LOCAL_NETWORK_CAVEAT");
    expect(body).not.toContain("Banner");
    expect(LOCAL_NETWORK_CAVEAT).toContain("Local Network");
  });

  it("givenAFailedCheck_whenTheWindowRenders_thenNoBannerInterrupts", () => {
    // The bar is for news, not for a laptop that could not reach GitHub. The section above says so
    // for whoever goes looking, which is the whole of the reporting a failed check deserves.
    expect(updateBanner({ phase: "failed", message: "nope", details: [] })).toBeNull();
    expect(updateBanner({ phase: "downloading", version: "1.4.0", receivedBytes: 1, totalBytes: 2 })).toBeNull();
    expect(updateBanner({ phase: "ready", version: "1.4.0" })?.ready).toBe(true);
  });
});

describe("the Settings pane's tabs", () => {
  it("givenTheSettingsPane_whenItRenders_thenAppearanceDiagnosticsAndResourcesAreTheTabs", () => {
    const found = SETTINGS_TABS.exec(code(SETTINGS));
    expect(found).not.toBeNull();

    const tabs = [...(found?.[1] ?? NOTHING).matchAll(QUOTED)].map(([, name]) => name);

    // Diagnostics is its own tab rather than a fourth section under forty-three theme cards.
    expect(tabs).toEqual([...TABS]);
  });

  it("givenTheTabTriggers_whenTheyRender_thenTheyUseTheAppsOwnUnderline", () => {
    const source = code(SETTINGS);

    // The travelling underline belongs to `ui/Tabs.tsx`. A pane that paints its own gets one that
    // looks right and does not move, which is the failure `design-system.md` names.
    expect(source).toContain("TabTrigger");
    expect(source).toContain("useTabUnderline");
    expect(source).not.toContain(HAND_ROLLED_UNDERLINE);
  });
});
