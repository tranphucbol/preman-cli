import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadIterationData, rowFor } from "@/data/rows.js";
import { CliError } from "@/errors.js";
import { dataPath } from "./helpers.js";

describe("loadIterationData", () => {
  it("givenJsonArray_whenLoading_thenRowsParsedAndValuesNormalised", async () => {
    const loaded = await loadIterationData(dataPath("users.json"));
    expect(loaded.rows).toEqual([
      { msisdn: "84900000001", label: "first" },
      { msisdn: "84900000002", label: "second" },
    ]);
  });

  it("givenJsonObject_whenLoading_thenCliError", async () => {
    await expect(loadIterationData(dataPath("not-an-array.json"))).rejects.toThrow(/expects an array of objects/);
  });

  it("givenJsonArrayOfScalars_whenLoading_thenCliError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preman-data-"));
    const path = join(dir, "scalars.json");
    try {
      writeFileSync(path, '["a", "b"]');
      await expect(loadIterationData(path)).rejects.toThrow(/expects an array of objects/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("givenCsvWithHeader_whenLoading_thenRowsParsedAsStrings", async () => {
    const loaded = await loadIterationData(dataPath("users.csv"));
    expect(loaded.rows[0]).toEqual({ msisdn: "84900000001", label: "first" });
  });

  it("givenCsvWithHeaderOnly_whenLoading_thenCliError", async () => {
    await expect(loadIterationData(dataPath("empty.csv"))).rejects.toThrow(/contains no rows/);
  });

  it("givenUnknownExtension_whenLoading_thenCliErrorNamesSupported", async () => {
    await expect(loadIterationData("users.txt")).rejects.toThrow(/expects \.json or \.csv/);
  });

  it("givenMissingFile_whenLoading_thenCliErrorNamesPath", async () => {
    await expect(loadIterationData(dataPath("missing.json"))).rejects.toBeInstanceOf(CliError);
    await expect(loadIterationData(dataPath("missing.json"))).rejects.toThrow(/missing\.json/);
  });

  it("givenNullJsonValue_whenLoading_thenValueIsEmptyString", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preman-data-"));
    const path = join(dir, "null.json");
    try {
      writeFileSync(path, '[{"value":null,"number":42}]');
      expect((await loadIterationData(path)).rows).toEqual([{ value: "", number: "42" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rowFor", () => {
  it("givenFewerRowsThanIterations_whenSelectingRow_thenRowsCycle", () => {
    const rows = [{ value: "a" }, { value: "b" }];
    expect(rowFor(rows, 2)).toEqual({ value: "a" });
    expect(rowFor(rows, 3)).toEqual({ value: "b" });
  });

  it("givenNoRows_whenSelectingRow_thenUndefined", () => {
    expect(rowFor([], 0)).toBeUndefined();
  });
});
