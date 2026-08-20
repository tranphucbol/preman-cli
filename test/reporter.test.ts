import { describe, expect, it } from "vitest";
import { CliError } from "@/errors.js";
import { reporterNames, resolveReporters, resolveReporterTargets } from "@/output/reporter.js";

describe("reporter resolution", () => {
  it("givenNoReporterFlag_whenResolve_thenCliOnly", () => {
    expect(resolveReporters([]).map((reporter) => reporter.name)).toEqual(["cli"]);
  });

  it("givenCommaSeparatedNames_whenResolve_thenBothReporters", () => {
    expect(resolveReporters(["cli,junit"]).map((reporter) => reporter.name)).toEqual(["cli", "junit"]);
  });

  it("givenRepeatedFlag_whenResolve_thenBothReporters", () => {
    expect(resolveReporters(["cli", "junit"]).map((reporter) => reporter.name)).toEqual(["cli", "junit"]);
  });

  it("givenDuplicateName_whenResolve_thenDeduplicated", () => {
    expect(resolveReporters(["json", "json"]).map((reporter) => reporter.name)).toEqual(["json"]);
  });

  it("givenUnknownName_whenResolve_thenThrowsCliErrorListingNames", () => {
    try {
      resolveReporters(["nope"]);
      throw new Error("expected reporter resolution to fail");
    } catch (cause) {
      expect(cause).toBeInstanceOf(CliError);
      expect((cause as CliError).details.join(" ")).toContain(reporterNames().join(", "));
    }
  });

  it("givenTwoStdoutReporters_whenResolve_thenThrowsCliErrorNamingBoth", () => {
    expect(() => resolveReporterTargets(["cli", "json"], {})).toThrow(/"cli", "json".*stdout/);
  });

  it("givenExportPathForDisabledReporter_whenResolve_thenThrowsCliError", () => {
    expect(() => resolveReporterTargets(["cli"], { junit: "junit.xml" })).toThrow(/requires reporter "junit"/);
  });

  it("givenExportPathForCliReporter_whenResolve_thenThrowsCliError", () => {
    expect(() => resolveReporterTargets(["cli"], { cli: "output.txt" })).toThrow(/cannot be exported/);
  });

  it("givenExportedJunitReporter_whenResolve_thenOnlyCliTargetsStdout", () => {
    const resolved = resolveReporterTargets(["cli,junit"], { junit: "junit.xml" });
    expect(resolved.map(({ reporter, exportPath }) => [reporter.name, exportPath])).toEqual([
      ["cli", undefined],
      ["junit", "junit.xml"],
    ]);
  });
});
