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

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../packages/desktop/src");
const SETTINGS = readFileSync(join(DESKTOP_DIR, "renderer/panes/SettingsPane.tsx"), "utf8");
const BRIDGE = readFileSync(join(DESKTOP_DIR, "preload/bridge.ts"), "utf8");

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/.*$/gm;
const NOTHING = "";

/** The section's body, from its `function` line to the first close at column zero. */
const DIAGNOSTICS_SECTION = /function DiagnosticsSection\(\)[\s\S]*?\n\}\n/;
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
