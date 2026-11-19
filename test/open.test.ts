/**
 * `preman open`: which folder reaches the app, how it is asked for, and what a refusal says.
 *
 * The launcher is always a fake. A suite that ran the real `open -b` would start whatever preman
 * happens to be installed on the machine running it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { APP_BUNDLE_ID, openInApp, type Launch, type Launcher } from "@preman/cli/desktop.js";
import { main } from "@preman/cli/main.js";
import { EXIT, PremanError } from "@preman/core/errors.js";
import { FIXTURE_WS } from "./helpers.js";

const MACOS = "darwin";
const LINUX = "linux";
const LAUNCHED: Launch = { status: 0, stderr: "" };
const NOT_INSTALLED_STDERR = `Unable to find application with bundle identifier ${APP_BUNDLE_ID}`;
const NO_CALLS = 0;

interface Recorded {
  launcher: Launcher;
  calls: { command: string; args: readonly string[] }[];
}

function recording(answer: Launch): Recorded {
  const calls: Recorded["calls"] = [];
  return {
    calls,
    launcher: (command, args) => {
      calls.push({ command, args });
      return answer;
    },
  };
}

const scratch: string[] = [];

function emptyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "preman-open-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function refusal(run: () => unknown): PremanError {
  try {
    run();
  } catch (cause) {
    if (cause instanceof PremanError) return cause;
    throw cause;
  }
  throw new Error("expected a PremanError");
}

describe("openInApp", () => {
  it("givenWorkspaceRoot_whenOpenedOnMacOS_thenOpenIsAskedForTheAppByBundleId", () => {
    const fake = recording(LAUNCHED);

    const root = openInApp(FIXTURE_WS, { platform: MACOS, launch: fake.launcher });

    expect(root).toBe(FIXTURE_WS);
    expect(fake.calls).toEqual([{ command: "open", args: ["-b", APP_BUNDLE_ID, FIXTURE_WS] }]);
  });

  it("givenDirectoryInsideAWorkspace_whenOpened_thenTheWorkspaceRootIsHandedOver", () => {
    const fake = recording(LAUNCHED);

    const root = openInApp(join(FIXTURE_WS, "postman", "collections"), { platform: MACOS, launch: fake.launcher });

    expect(root).toBe(FIXTURE_WS);
    expect(fake.calls[0]?.args.at(-1)).toBe(FIXTURE_WS);
  });

  it("givenDirectoryOutsideAnyWorkspace_whenOpened_thenItIsRefusedWithoutLaunching", () => {
    const fake = recording(LAUNCHED);

    const error = refusal(() => openInApp(emptyDir(), { platform: MACOS, launch: fake.launcher }));

    expect(error.message).toMatch(/no Postman workspace found/);
    expect(fake.calls).toHaveLength(NO_CALLS);
  });

  it("givenAppNotInstalled_whenOpened_thenTheRefusalCarriesWhatOpenSaidAndWhereToGetIt", () => {
    const fake = recording({ status: 1, stderr: `${NOT_INSTALLED_STDERR}\n` });

    const error = refusal(() => openInApp(FIXTURE_WS, { platform: MACOS, launch: fake.launcher }));

    expect(error.exitCode).toBe(EXIT.CLI);
    expect(error.message).toContain(FIXTURE_WS);
    expect(error.details[0]).toBe(NOT_INSTALLED_STDERR);
    expect(error.details.at(-1)).toMatch(/releases/);
  });

  it("givenOpenCannotStart_whenOpened_thenTheSpawnErrorIsNotSwallowed", () => {
    const fake = recording({ status: null, stderr: "", error: new Error("spawn open ENOENT") });

    const error = refusal(() => openInApp(FIXTURE_WS, { platform: MACOS, launch: fake.launcher }));

    expect(error.details[0]).toBe("spawn open ENOENT");
  });

  it("givenPlatformOtherThanMacOS_whenOpened_thenItSaysTheAppIsMacOnlyWithoutLaunching", () => {
    const fake = recording(LAUNCHED);

    const error = refusal(() => openInApp(FIXTURE_WS, { platform: LINUX, launch: fake.launcher }));

    expect(error.message).toMatch(/only packaged for macOS/);
    expect(fake.calls).toHaveLength(NO_CALLS);
  });
});

describe("preman open", () => {
  it("givenDirectoryOutsideAnyWorkspace_whenMainRuns_thenItExitsWithAUsageError", async () => {
    // Refused before `open` would run on macOS, and by the platform check everywhere else.
    await expect(main(["open", emptyDir()])).rejects.toMatchObject({ exitCode: EXIT.CLI });
  });
});
