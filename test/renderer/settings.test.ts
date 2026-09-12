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
  updateChip,
  updateHeadline,
} from "@preman/desktop/renderer/model/update.js";

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../packages/desktop/src");
const SETTINGS = readFileSync(join(DESKTOP_DIR, "renderer/panes/SettingsPane.tsx"), "utf8");
const BRIDGE = readFileSync(join(DESKTOP_DIR, "preload/bridge.ts"), "utf8");
const APP = readFileSync(join(DESKTOP_DIR, "renderer/App.tsx"), "utf8");
const BANNER = readFileSync(join(DESKTOP_DIR, "renderer/ui/Banner.tsx"), "utf8");

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/.*$/gm;
const NOTHING = "";

/** The section's body, from its `function` line to the first close at column zero. */
const DIAGNOSTICS_SECTION = /function DiagnosticsSection\(\)[\s\S]*?\n\}\n/;
const UPDATES_SECTION = /function UpdatesSection\(\)[\s\S]*?\n\}\n/;
/** The title bar's chip, from its `function` line to the first close at column zero. */
const UPDATE_CHIP = /function UpdateChip\(\)[\s\S]*?\n\}\n/;
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

const BUTTON_TAG = "<Button";
const CHROME_TIER = 'tier="chrome"';
/** `Controls.tsx`'s content tier, worn by the input the one exception is paired with. */
const FIELD_HEIGHT = "h-control-lg";
const ICON_BUTTON_TAG = "<IconButton";
/** Every function in the pane that draws a labelled button, except the one holding a field. */
const CHROME_TIER_FUNCTIONS = ["UpdateActions"] as const;
/** The three that draw the log's controls, all of which are a glyph and a tooltip. */
const ICON_ONLY_FUNCTIONS = ["DiagnosticsSection", "StreamToggle", "LogStream"] as const;
/** The Updates buttons that say what they do, because doing it is not free. */
const CONSEQUENTIAL_ACTIONS = ["Skip", "Download", "Restart and install"] as const;
const ONE_GLYPH = 1;

function code(source: string): string {
  return source.replace(BLOCK_COMMENT, NOTHING).replace(LINE_COMMENT, NOTHING);
}

/** A named function's body, from its `function` line to the first close at column zero. */
function functionBody(name: string): string {
  const found = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}\\n`).exec(code(SETTINGS));
  expect(found).not.toBeNull();
  return found?.[0] ?? NOTHING;
}

function occurrences(body: string, needle: string): number {
  return body.split(needle).length - 1;
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

  it("givenTheDiagnosticsRead_whenItAnswers_thenItStillCarriesNoLogLine", () => {
    const found = DIAGNOSTICS_INFO.exec(code(BRIDGE));
    expect(found).not.toBeNull();

    const fields = [...(found?.[1] ?? NOTHING).matchAll(FIELD)].map(([, name]) => name);

    // `docs/decisions/056` let the *pane* show the log; it did not turn this read into one. Two
    // paths and four version strings, answered once on mount and never again — the lines arrive on
    // their own push channel, only while somebody asked for them, and are never a reply to this.
    expect(fields).toEqual([...DIAGNOSTICS_FIELDS]);
  });

  it("givenTheDiagnosticsSection_whenItRenders_thenTheLogCanBeWatchedFromTheRowThatNamesIt", () => {
    const body = section();

    // The switch sits in the Log row, beside the Reveal that answers the other question: the file
    // is what has last Tuesday in it, and the stream is what has the next ten seconds.
    expect(body).toContain("<StreamToggle />");
    expect(body).toContain("<LogStream />");
  });
});

/**
 * The Updates section, read two ways.
 *
 * What the section *says* is not in the `.tsx` at all — it is `model/update.ts`, which is pure and
 * importable, so those cases are behaviour rather than text. What is left for the source reading is
 * the two structural promises the model cannot make: that the caveat is drawn only when an update
 * is staged, and that nothing here installs anything without a press.
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
});

/**
 * The chip in the title bar, read the same two ways.
 *
 * What it says is `model/update.ts` and is behaviour. What is left for the source reading is the
 * two structural promises the model cannot make: that the phase with nothing to press is not a
 * disabled button, and that the updater no longer owns a bar across the window.
 */
describe("the title bar's update chip", () => {
  it("givenAPhaseWithNothingToDo_whenTheTitleBarRenders_thenNoChipIsDrawn", () => {
    // Chrome is permanent, which is exactly why `failed` is not in it: a laptop that could not
    // reach GitHub gives the user nothing to do, and a standing mark saying so is worse than the
    // bar it replaced, because the bar at least went away. The Settings section still says it.
    expect(updateChip({ phase: "failed", message: "nope", details: [] })).toBeNull();
    expect(updateChip({ phase: "idle" })).toBeNull();
    expect(updateChip({ phase: "checking" })).toBeNull();
    expect(updateChip({ phase: "current" })).toBeNull();
    expect(updateChip({ phase: "unsupported", reason: "translocated" })).toBeNull();
  });

  it("givenAnUpdateToActOn_whenTheChipRenders_thenOnePressDoesTheOneThing", () => {
    const available = updateChip({
      phase: "available",
      version: "1.4.0",
      notesUrl: "https://example.invalid",
      sizeBytes: 134_217_728,
    });

    expect(available?.action).toBe("download");
    expect(available?.detail).toBe("1.4.0");
    // The tooltip is the sentence the bar used to be, so nothing the move dropped is unsaid.
    expect(available?.title).toContain("128 MB");
    expect(updateChip({ phase: "ready", version: "1.4.0" })?.action).toBe("install");
  });

  it("givenADownloadInFlight_whenTheChipRenders_thenItReportsItselfAndOffersNoPress", () => {
    // The one phase the move adds rather than relocates: a bar could not report a press back at
    // the presser, but the chip *is* the control that was pressed and must not vanish mid-download.
    const half = updateChip({ phase: "downloading", version: "1.4.0", receivedBytes: 1, totalBytes: 2 });
    expect(half?.action).toBeNull();
    expect(half?.detail).toBe("50%");

    // No `content-length`, no denominator, and no invented percentage that could jump backwards.
    const unknown = updateChip({ phase: "downloading", version: "1.4.0", receivedBytes: 1, totalBytes: 0 });
    expect(unknown?.detail).toBe("1.4.0");
  });

  it("givenTheChipInAPhaseItCannotActIn_whenItRenders_thenItIsNotADisabledButton", () => {
    const found = UPDATE_CHIP.exec(code(APP));
    expect(found).not.toBeNull();
    const body = found?.[0] ?? NOTHING;

    // A disabled `<button>` emits no pointer events in Chromium, so its tooltip never opens.
    // `design-system.md` states this for the field lead; the chip is the second case of it.
    expect(body).toContain("chip.action === null ?");
    expect(body).not.toContain("disabled");
  });

  it("givenTheTitleBarsTrailingGroup_whenTheChipArrives_thenItGrowsBesideTheGearRatherThanMovingIt", () => {
    const source = code(APP);
    // A transient placed after the row's permanent controls widens the trailing group leftwards
    // and shifts every one of them. Placed before, it grows into the empty run and shifts nothing.
    expect(source.indexOf("<UpdateChip />")).toBeLessThan(source.indexOf('label="Settings"'));
  });

  it("givenTheChip_whenItRenders_thenItsGlyphIsNotTheSidebarsImportTray", () => {
    const body = UPDATE_CHIP.exec(code(APP))?.[0] ?? NOTHING;

    // `ImportIcon` is "Import from cURL", four rows below in the same window. One glyph cannot
    // mean both "read this file" and "there is a new version".
    expect(body).toContain("<UpdateIcon />");
    expect(body).not.toContain("ImportIcon");
  });

  it("givenTheUpdater_whenTheWindowRenders_thenItOwnsNoBannerAndNoToneOfItsOwn", () => {
    expect(code(APP)).not.toContain("UpdateBanner");
    // `info` had exactly one caller and this was it, so the tone went with it rather than being
    // kept warm for a second bar that says nothing is wrong.
    expect(code(BANNER)).not.toContain('"info"');
  });
});

/**
 * Every control in this pane is chrome.
 *
 * The pane is a column of rows that report something, and the buttons in them act on what the row
 * says rather than on a thing being edited — which is `Controls.tsx`'s definition of the chrome
 * tier. At 30px they were the tallest objects in rows they are not the subject of, and the
 * Diagnostics tab had four of them stacked. The single exception is the one paired with a field.
 */
describe("the Settings pane's control tiers", () => {
  it("givenARowThatReportsSomething_whenItsButtonsRender_thenTheyAreChromeTier", () => {
    for (const name of CHROME_TIER_FUNCTIONS) {
      const body = functionBody(name);

      expect(occurrences(body, BUTTON_TAG)).toBeGreaterThan(0);
      expect(occurrences(body, CHROME_TIER)).toBe(occurrences(body, BUTTON_TAG));
    }
  });

  it("givenTheLogsOwnControls_whenTheyRender_thenTheyAreGlyphsAndNotWords", () => {
    for (const name of ICON_ONLY_FUNCTIONS) {
      const body = functionBody(name);

      // `IconButton` is already the chrome tier with no border and no fill, and it takes a `label`
      // that is both the tooltip and the accessible name — which is why going icon-only here costs
      // no new variant and loses nothing to a screen reader.
      expect(occurrences(body, ICON_BUTTON_TAG)).toBeGreaterThan(0);
      expect(occurrences(body, BUTTON_TAG)).toBe(0);
    }
  });

  it("givenTheLogSearchIsOpen_whenEscapeIsPressed_thenOnlyTheSearchCloses", () => {
    const body = functionBody("LogStream");

    // The pane dismisses itself on a window-level Escape and skips a prevented one. Without the
    // claim, putting the search away also closes Settings — which is how this was found, by eye.
    expect(body).toContain("if (event.key === ESCAPE_KEY) {");
    expect(body).toContain("event.preventDefault();");
  });

  it("givenTheConsequentialUpdateActions_whenTheyRender_thenTheyKeepTheirWords", () => {
    const body = functionBody("UpdateActions");

    // Skip, Download and Restart and install are deliberately not icons: one of them reboots the
    // app, they appear only when there is an update, and a strip of unlabelled buttons over a
    // version number is a quiz. Each still says which of them it is.
    for (const words of CONSEQUENTIAL_ACTIONS) expect(body).toContain(words);
    expect(occurrences(body, BUTTON_TAG)).toBe(CONSEQUENTIAL_ACTIONS.length);
  });

  it("givenCheckNow_whenItRenders_thenItIsTheSectionsOneGlyph", () => {
    const body = functionBody("UpdateActions");

    // The exception, and the argument for it is that it is cheap to misread: it checks again.
    expect(occurrences(body, ICON_BUTTON_TAG)).toBe(ONE_GLYPH);
    expect(body).toContain("<RefreshIcon />");
    expect(body).not.toContain("Check now<");
  });

  it("givenAButtonPairedWithAField_whenItRenders_thenItKeepsTheFieldsHeight", () => {
    const body = functionBody("ProtosSection");

    // A 26px button beside a 30px input is a row that does not line up. `Controls.tsx` has the
    // long version: a field and the button that acts on it are one control in the user's head.
    expect(occurrences(body, BUTTON_TAG)).toBe(1);
    expect(occurrences(body, CHROME_TIER)).toBe(0);
    expect(body).toContain(FIELD_HEIGHT);
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
