import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import viteConfig from "../packages/cli/vite.config.js";
import { PremanError, EXIT } from "@preman/core/errors.js";
import { chai } from "@preman/core/scripts/expect.js";
import { requireSandboxModule, SANDBOX_ALIASES, SANDBOX_PACKAGES } from "@preman/core/scripts/modules.js";

// Each workspace package gets its own node_modules, so the alias target must be
// resolved from the core package that the sandbox itself resolves from.
const requireFromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));

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
    expect(requireSandboxModule("csv-parse/lib/sync")).toBe(requireFromCore("csv-parse/sync"));
  });

  it.each(["fs", "node:fs"])("givenNodeBuiltin_whenRequire_thenThrowsPremanErrorListingAllowList: %s", (name) => {
    try {
      requireSandboxModule(name);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PremanError);
      expect(error).toMatchObject({ exitCode: EXIT.CLI });
      expect((error as PremanError).message).toContain(name);
      expect((error as PremanError).details.join("\n")).toContain("lodash");
    }
  });

  it("givenRelativeSpecifier_whenRequire_thenThrowsPremanError", () => {
    expect(() => requireSandboxModule("./helper.js")).toThrow("./helper.js");
  });

  it("givenNoArgument_whenRequire_thenThrowsPremanError", () => {
    expect(() => requireSandboxModule(undefined as unknown as string)).toThrow("without a module name");
  });

  it("givenChai_whenRequire_thenSameInstanceAsExpectModule", () => {
    expect(requireSandboxModule("chai")).toBe(chai);
    expect(chai.config.truncateThreshold).toBe(400);
  });

  it("givenSandboxPackages_whenBuildExternals_thenEveryPackageIsExternal", () => {
    const external = viteConfig.build?.rolldownOptions?.external;
    expect(external).toEqual(expect.arrayContaining([...SANDBOX_PACKAGES]));
    expect(SANDBOX_PACKAGES.length).toBeGreaterThan(0);
  });

  it("givenSandboxAliases_whenBuildExternals_thenAliasTargetsAreExternal", () => {
    const external = viteConfig.build?.rolldownOptions?.external;
    expect(external).toEqual(expect.arrayContaining(Object.values(SANDBOX_ALIASES)));
  });

  it("givenViteConfig_whenAliasResolved_thenPointsAtCoreSourceDirectory", () => {
    expect(viteConfig.resolve?.alias).toMatchObject({
      "@preman/core": resolve(import.meta.dirname, "../packages/core/src"),
    });
  });
});
