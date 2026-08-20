import { describe, expect, it } from "vitest";

import { CliError, EXIT } from "@/errors.js";
import { PropertyList, type Property } from "@/scripts/property-list.js";

const HEADER_OPTIONS = { caseInsensitive: true, label: "request headers" };
const QUERY_OPTIONS = { caseInsensitive: false, label: "request query parameters" };

describe("PropertyList", () => {
  it("givenDuplicateKeys_whenAdd_thenBothEntriesSurvive", () => {
    const list = new PropertyList([{ key: "X-Tag", value: "first" }], HEADER_OPTIONS);

    list.add({ key: "x-tag", value: "second" });

    expect(list.get("X-TAG")).toBe("first");
    expect(list.count()).toBe(2);
    expect(list.all()).toEqual([
      { key: "X-Tag", value: "first" },
      { key: "x-tag", value: "second" },
    ]);
  });

  it("givenExistingKey_whenUpsert_thenReplacedInPlace", () => {
    const list = new PropertyList(
      [
        { key: "first", value: "1" },
        { key: "X-Tag", value: "old" },
        { key: "last", value: "3" },
      ],
      HEADER_OPTIONS,
    );

    list.upsert({ key: "x-tag", value: "new" });

    expect(list.all()).toEqual([
      { key: "first", value: "1" },
      { key: "x-tag", value: "new" },
      { key: "last", value: "3" },
    ]);
  });

  it("givenMissingKey_whenUpsert_thenAppended", () => {
    const list = new PropertyList([{ key: "first", value: "1" }], QUERY_OPTIONS);

    list.upsert({ key: "second", value: "2" });

    expect(list.idx(1)).toEqual({ key: "second", value: "2" });
  });

  it("givenStringForm_whenAdd_thenSameAsObjectForm", () => {
    const list = new PropertyList([], QUERY_OPTIONS);

    list.add("Name", "v");
    list.add({ key: "blank" } as Property);

    expect(list.toJSON()).toEqual([
      { key: "Name", value: "v" },
      { key: "blank", value: "" },
    ]);
  });

  it("givenNoKey_whenAdd_thenThrowsCliError", () => {
    const list = new PropertyList([], HEADER_OPTIONS);

    try {
      list.add({ value: "v" } as Property);
      expect.unreachable("should have thrown");
    } catch (cause) {
      expect(cause).toBeInstanceOf(CliError);
      const error = cause as CliError;
      expect(error.message).toBe("add() needs a key");
      expect(error.details).toEqual(["Could not add to request headers."]);
    }
  });

  it("givenDuplicateKeys_whenRemove_thenAllMatchesGone", () => {
    const list = new PropertyList(
      [
        { key: "X-Tag", value: "first" },
        { key: "keep", value: "yes" },
        { key: "x-tag", value: "second" },
      ],
      HEADER_OPTIONS,
    );

    list.remove("X-TAG");

    expect(list.all()).toEqual([{ key: "keep", value: "yes" }]);
  });

  it("givenCaseInsensitiveList_whenGetDifferentCase_thenFound", () => {
    const list = new PropertyList([{ key: "Content-Type", value: "application/json" }], HEADER_OPTIONS);

    expect(list.get("content-type")).toBe("application/json");
    expect(list.has("CONTENT-TYPE")).toBe(true);
  });

  it("givenCaseSensitiveList_whenGetDifferentCase_thenNotFound", () => {
    const list = new PropertyList([{ key: "ID", value: "1" }], QUERY_OPTIONS);

    expect(list.get("id")).toBeUndefined();
    expect(list.has("id")).toBe(false);
  });

  it("givenDisabledEntry_whenEnabled_thenOmitted", () => {
    const list = new PropertyList(
      [
        { key: "off", value: "1", disabled: true },
        { key: "on", value: "2" },
      ],
      QUERY_OPTIONS,
    );

    expect(list.enabled()).toEqual([{ key: "on", value: "2" }]);
  });

  it("givenFrozenList_whenAdd_thenThrowsCliError", () => {
    const list = new PropertyList([], HEADER_OPTIONS);
    list.freeze();

    for (const mutate of [() => list.add("new", "1"), () => list.upsert("new", "1"), () => list.remove("new")]) {
      try {
        mutate();
        expect.unreachable("should have thrown");
      } catch (cause) {
        expect(cause).toBeInstanceOf(CliError);
        const error = cause as CliError;
        expect(error.message).toBe("pm.request is read-only after the request has been sent");
        expect(error.exitCode).toBe(EXIT.CLI);
      }
    }
  });

  it("givenMixedCaseKeys_whenAll_thenOriginalCasingPreserved", () => {
    const original = { key: "X-Correlation-ID", value: "abc" };
    const list = new PropertyList([original], HEADER_OPTIONS);

    original.key = "changed-outside";
    const snapshot = list.all();
    snapshot[0]!.key = "changed-snapshot";

    expect(list.all()).toEqual([{ key: "X-Correlation-ID", value: "abc" }]);
  });

  it("givenDuplicateKeys_whenToObject_thenLastWriteWins", () => {
    const headers = new PropertyList(
      [
        { key: "X-Tag", value: "first" },
        { key: "x-tag", value: "second" },
      ],
      HEADER_OPTIONS,
    );
    const query = new PropertyList(
      [
        { key: "ID", value: "upper" },
        { key: "id", value: "lower" },
      ],
      QUERY_OPTIONS,
    );

    expect(headers.toObject()).toEqual({ "x-tag": "second" });
    expect(query.toObject()).toEqual({ ID: "upper", id: "lower" });
  });

  it("givenCallbacks_whenUsed_thenTheyReceiveEntriesInOrder", () => {
    const list = new PropertyList(
      [
        { key: "a", value: "1" },
        { key: "b", value: "2" },
      ],
      QUERY_OPTIONS,
    );
    const seen: string[] = [];

    list.each((entry) => seen.push(entry.key));

    expect(seen).toEqual(["a", "b"]);
    expect(list.map((entry) => entry.value)).toEqual(["1", "2"]);
    expect(list.filter((entry) => entry.key === "b")).toEqual([{ key: "b", value: "2" }]);
  });
});
