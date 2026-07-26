import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { CliError, EXIT } from "../src/errors.js";
import { chai } from "../src/scripts/expect.js";
import {
  requireSandboxModule,
  SANDBOX_PACKAGES,
} from "../src/scripts/modules.js";

const requireFromTest = createRequire(import.meta.url);

describe("sandbox module registry", () => {
  it.each(SANDBOX_PACKAGES)("givenAllowedPackage_whenRequire_thenItLoads: %s", (name) => {
    expect(requireSandboxModule(name)).toBeDefined();
  });

  it("givenAllowedName_whenRequire_thenModuleReturned", () => {
    const lodash = requireSandboxModule("lodash") as { pick: (value: object, keys: string[]) => object };
    expect(lodash.pick({ keep: 1, drop: 2 }, ["keep"])).toEqual({ keep: 1 });
  });

  it("givenSameNameTwice_whenRequire_thenIdenticalInstance", () => {
    expect(requireSandboxModule("moment")).toBe(requireSandboxModule("moment"));
  });

  it("givenCsvParseLegacyPath_whenRequire_thenResolvesToSyncEntry", () => {
    expect(requireSandboxModule("csv-parse/lib/sync")).toBe(requireFromTest("csv-parse/sync"));
  });

  it.each(["fs", "node:fs"])(
    "givenNodeBuiltin_whenRequire_thenThrowsCliErrorListingAllowList: %s",
    (name) => {
      try {
        requireSandboxModule(name);
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect(error).toMatchObject({ exitCode: EXIT.CLI });
        expect((error as CliError).message).toContain(name);
        expect((error as CliError).details.join("\n")).toContain("lodash");
      }
    },
  );

  it("givenRelativeSpecifier_whenRequire_thenThrowsCliError", () => {
    expect(() => requireSandboxModule("./helper.js")).toThrow('./helper.js');
  });

  it("givenNoArgument_whenRequire_thenThrowsCliError", () => {
    expect(() => requireSandboxModule(undefined as unknown as string)).toThrow("without a module name");
  });

  it("givenChai_whenRequire_thenSameInstanceAsExpectModule", () => {
    expect(requireSandboxModule("chai")).toBe(chai);
    expect(chai.config.truncateThreshold).toBe(400);
  });

  it("givenSandboxPackages_whenBuildExternals_thenEveryPackageIsExternal", async () => {
    const source = await readFile(new URL("../scripts/build.ts", import.meta.url), "utf8");
    expect(source).toContain('import { SANDBOX_ALIASES, SANDBOX_PACKAGES } from "../src/scripts/modules.js"');
    expect(source).toContain("...SANDBOX_PACKAGES");
    expect(SANDBOX_PACKAGES.length).toBeGreaterThan(0);
  });
});
