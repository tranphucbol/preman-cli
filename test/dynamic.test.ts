import { afterEach, describe, expect, it, vi } from "vitest";
import { PremanError } from "@preman/core/errors.js";
import {
  assembleGeneratorTables,
  generateDynamicValue,
  supportedDynamicVariables,
  type GeneratorTable,
} from "@preman/core/vars/dynamic/index.js";

const RANDOM_INT_MIN = 0;
const RANDOM_INT_MAX = 1000;
const RANDOM_INT_SAMPLES = 5_000;
const FAKER_SEED = "8675309";

describe("dynamic variables", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("givenEverySupportedName_whenGenerating_thenReturnsNonEmptyString", () => {
    for (const name of supportedDynamicVariables()) expect(generateDynamicValue(name), name).not.toBe("");
  });

  it("givenEverySupportedName_whenGenerating_thenReturnsTypeofString", () => {
    for (const name of supportedDynamicVariables()) expect(typeof generateDynamicValue(name), name).toBe("string");
  });

  it("givenSeedSet_whenGeneratingTwice_thenValuesMatch", async () => {
    vi.stubEnv("PREMAN_FAKER_SEED", FAKER_SEED);
    vi.resetModules();
    const firstModule = await import("@preman/core/vars/dynamic/index.js");
    const first = firstModule.generateDynamicValue("$randomEmail");

    vi.resetModules();
    const secondModule = await import("@preman/core/vars/dynamic/index.js");
    const second = secondModule.generateDynamicValue("$randomEmail");

    expect(second).toBe(first);
  });

  it("givenUnsupportedName_whenGenerating_thenPremanErrorSuggestsNearest", () => {
    try {
      generateDynamicValue("$randomEmial");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PremanError);
      expect((error as PremanError).details.join("\n")).toContain("{{$randomEmail}}");
    }
  });

  it("givenUnsupportedNameWithNoNearMatch_whenGenerating_thenPremanErrorNamesCount", () => {
    try {
      generateDynamicValue("$zzzzzzzzzzzzzzzz");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PremanError);
      expect((error as PremanError).details.join("\n")).toContain(
        `${supportedDynamicVariables().length} dynamic variables`,
      );
    }
  });

  it("givenDuplicateNameAcrossTables_whenAssembling_thenThrowsAtLoad", () => {
    const first: GeneratorTable = { $duplicate: () => "first" };
    const second: GeneratorTable = { $duplicate: () => "second" };
    expect(() => assembleGeneratorTables([first, second])).toThrow(/duplicate dynamic variable generator: \$duplicate/);
  });

  it("givenSupportedNames_whenListing_thenSorted", () => {
    const names = supportedDynamicVariables();
    expect(names).toEqual([...names].sort());
  });

  it("givenGuid_whenGenerating_thenMatchesUuidV4Shape", () => {
    expect(generateDynamicValue("$guid")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("givenTimestamp_whenGenerating_thenSecondsNotMilliseconds", () => {
    expect(generateDynamicValue("$timestamp")).toMatch(/^\d{10}$/);
  });

  it("givenIsoTimestamp_whenGenerating_thenParsesAsDate", () => {
    expect(Number.isNaN(Date.parse(generateDynamicValue("$isoTimestamp")))).toBe(false);
  });

  it("givenRandomInt_whenGeneratingManyTimes_thenAlwaysWithinZeroToOneThousand", () => {
    for (let index = 0; index < RANDOM_INT_SAMPLES; index += 1) {
      const value = Number(generateDynamicValue("$randomInt"));
      expect(value).toBeGreaterThanOrEqual(RANDOM_INT_MIN);
      expect(value).toBeLessThanOrEqual(RANDOM_INT_MAX);
    }
  });

  it("givenRandomBoolean_whenGenerating_thenTrueOrFalseString", () => {
    expect(["true", "false"]).toContain(generateDynamicValue("$randomBoolean"));
  });

  it("givenLatitude_whenGenerating_thenWithinRange", () => {
    const value = Number(generateDynamicValue("$randomLatitude"));
    expect(value).toBeGreaterThanOrEqual(-90);
    expect(value).toBeLessThanOrEqual(90);
  });

  it("givenEmail_whenGenerating_thenContainsAtSign", () => {
    expect(generateDynamicValue("$randomEmail")).toContain("@");
  });

  it("givenIpV4_whenGenerating_thenFourDottedOctets", () => {
    const octets = generateDynamicValue("$randomIP").split(".");
    expect(octets).toHaveLength(4);
    expect(octets.every((octet) => Number(octet) >= 0 && Number(octet) <= 255)).toBe(true);
  });
});
