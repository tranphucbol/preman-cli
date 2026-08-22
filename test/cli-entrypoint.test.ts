import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isDirectEntrypoint } from "@preman/cli/bin.js";

const BIN_PATH = "packages/cli/src/bin.ts";

describe("CLI entrypoint", () => {
  it("givenSymlinkedExecutable_whenChecked_thenRecognizedAsEntrypoint", () => {
    const root = mkdtempSync(join(tmpdir(), "preman-entrypoint-"));

    try {
      const linkedEntrypoint = join(root, "preman.ts");
      symlinkSync(resolve(BIN_PATH), linkedEntrypoint);

      expect(isDirectEntrypoint(linkedEntrypoint, pathToFileURL(resolve(BIN_PATH)).href)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("givenNoVersionDefine_whenVersionRequested_thenFallsBackToPackageJson", () => {
    const output = execFileSync("bun", ["run", BIN_PATH, "--version"], { encoding: "utf8" });
    const packageJson = JSON.parse(readFileSync(new URL("../packages/cli/package.json", import.meta.url), "utf8")) as {
      version: string;
    };

    expect(output.trim()).toBe(packageJson.version);
  });
});
