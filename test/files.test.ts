import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { fileReader } from "../src/workspace/files.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "preman-files-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("fileReader", () => {
  it("givenRelativePath_whenResolve_thenAgainstWorkingDir", () => {
    const root = tempRoot();
    const path = join(root, "receipt.txt");
    writeFileSync(path, "receipt");
    expect(fileReader({ workingDir: root, allowOutside: false }).resolve("./receipt.txt", "upload")).toBe(realpathSync(path));
  });

  it("givenAbsolutePathInsideWorkingDir_whenResolve_thenAllowed", () => {
    const root = tempRoot();
    const path = join(root, "receipt.txt");
    writeFileSync(path, "receipt");
    expect(fileReader({ workingDir: root, allowOutside: false }).resolve(path, "upload")).toBe(realpathSync(path));
  });

  it("givenPathEscapingWorkingDir_whenResolve_thenThrowsCliErrorNamingFlag", () => {
    const parent = tempRoot();
    const root = join(parent, "workspace");
    mkdirSync(root);
    writeFileSync(join(parent, "outside.txt"), "outside");
    try {
      fileReader({ workingDir: root, allowOutside: false }).resolve("../outside.txt", "formdata field receipt");
      throw new Error("expected a CliError");
    } catch (cause) {
      expect(cause).toBeInstanceOf(CliError);
      expect((cause as CliError).message).toContain("outside the working directory");
      expect((cause as CliError).details.join(" ")).toContain("--insecure-file-read");
    }
  });

  it("givenPathEscapingWorkingDir_whenAllowOutside_thenAllowed", () => {
    const parent = tempRoot();
    const root = join(parent, "workspace");
    mkdirSync(root);
    const outside = join(parent, "outside.txt");
    writeFileSync(outside, "outside");
    expect(fileReader({ workingDir: root, allowOutside: true }).resolve("../outside.txt", "upload")).toBe(realpathSync(outside));
  });

  it("givenSymlinkEscapingWorkingDir_whenResolve_thenRejected", () => {
    const parent = tempRoot();
    const root = join(parent, "workspace");
    mkdirSync(root);
    const outside = join(parent, "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(root, "linked.txt"));
    expect(() => fileReader({ workingDir: root, allowOutside: false }).resolve("linked.txt", "upload")).toThrow(
      /outside the working directory/,
    );
  });

  it("givenMissingFile_whenRead_thenThrowsCliErrorNamingField", () => {
    const root = tempRoot();
    expect(() => fileReader({ workingDir: root, allowOutside: false }).read("missing.txt", 'formdata field "receipt"')).toThrow(
      /formdata field "receipt"/,
    );
  });

  it("givenDirectory_whenRead_thenThrowsCliError", () => {
    const root = tempRoot();
    mkdirSync(join(root, "directory"));
    expect(() => fileReader({ workingDir: root, allowOutside: false }).read("directory", "file body")).toThrow(
      /not a regular file/,
    );
  });
});
