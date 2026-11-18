/**
 * The folder a launch was asked to open, read off argv.
 *
 * The cases that matter are the launches that carry no folder at all: an unpackaged run puts its
 * entry script where a folder would be, and the Playwright harness adds switches around it. Either
 * mistaken for a folder would have every test launch refuse a directory nobody named.
 */
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { workspaceArgument } from "@preman/desktop/main/launch.js";

const EXECUTABLE = "/Applications/preman.app/Contents/MacOS/preman";
const ELECTRON = "/repo/node_modules/.bin/electron";
const ENTRY = "dist/main/main.js";
const CWD = "/Users/someone/src";
const WORKSPACE = "/Users/someone/src/payments";
const PACKAGED = false;
const UNPACKAGED = true;

describe("workspaceArgument", () => {
  it("givenPackagedLaunchWithNoArguments_whenRead_thenItIsNull", () => {
    expect(workspaceArgument([EXECUTABLE], CWD, PACKAGED)).toBeNull();
  });

  it("givenPackagedLaunchWithAnAbsoluteFolder_whenRead_thenItIsThatFolder", () => {
    expect(workspaceArgument([EXECUTABLE, WORKSPACE], CWD, PACKAGED)).toBe(WORKSPACE);
  });

  it("givenRelativeFolder_whenRead_thenItResolvesAgainstTheWorkingDirectory", () => {
    expect(workspaceArgument([EXECUTABLE, "payments"], CWD, PACKAGED)).toBe(join(CWD, "payments"));
    expect(workspaceArgument([EXECUTABLE, "."], CWD, PACKAGED)).toBe(resolve(CWD));
  });

  it("givenSwitchesAndAProcessSerialNumber_whenRead_thenNoneIsTakenForAFolder", () => {
    const argv = [EXECUTABLE, "-psn_0_12345", "--inspect=0", "--remote-debugging-port=0"];

    expect(workspaceArgument(argv, CWD, PACKAGED)).toBeNull();
  });

  it("givenUnpackagedLaunchOfTheEntryScriptAlone_whenRead_thenTheEntryIsNotAFolder", () => {
    // What `bun run desktop` and the Playwright harness both do.
    const argv = [ELECTRON, "--inspect=0", ENTRY, "--user-data-dir=/tmp/profile"];

    expect(workspaceArgument(argv, CWD, UNPACKAGED)).toBeNull();
  });

  it("givenUnpackagedLaunchWithAFolderAfterTheEntry_whenRead_thenItIsThatFolder", () => {
    expect(workspaceArgument([ELECTRON, ENTRY, WORKSPACE], CWD, UNPACKAGED)).toBe(WORKSPACE);
  });

  it("givenSeveralPositionals_whenRead_thenTheLastWins", () => {
    expect(workspaceArgument([EXECUTABLE, "/elsewhere", WORKSPACE], CWD, PACKAGED)).toBe(WORKSPACE);
  });
});
