import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { interpolate, interpolateStrict } from "../src/vars/interpolate.js";
import { VariableStore } from "../src/vars/store.js";

describe("VariableStore", () => {
  it("givenSameKeyInEveryScope_whenGet_thenLocalWinsThenEnvironmentThenCollectionThenGlobals", () => {
    const store = new VariableStore({
      globals: { a: "g", b: "g", c: "g", d: "g" },
      collection: { a: "c", b: "c", c: "c" },
      environment: { a: "e", b: "e" },
      local: { a: "l" },
    });
    expect(store.get("a")).toBe("l");
    expect(store.get("b")).toBe("e");
    expect(store.get("c")).toBe("c");
    expect(store.get("d")).toBe("g");
    expect(store.get("missing")).toBeUndefined();
  });

  it("givenNoWrites_whenCheckingChanges_thenNothingIsDirty", () => {
    const store = new VariableStore({ environment: { a: "1" } });
    expect(store.hasChanges("environment")).toBe(false);
    // Writing the identical value is not a change.
    store.set("environment", "a", "1");
    expect(store.hasChanges("environment")).toBe(false);
  });

  it("givenWritesAndUnsets_whenCheckingChanges_thenTracksPerScope", () => {
    const store = new VariableStore({ environment: { a: "1", b: "2" } });
    store.set("environment", "a", 42);
    store.unset("environment", "b");
    store.set("globals", "g", "x");

    expect(store.changes("environment")).toEqual({ a: "42", b: "" });
    expect(store.changes("globals")).toEqual({ g: "x" });
    expect(store.changes("local")).toEqual({});
    expect(store.get("a")).toBe("42");
  });

  it("givenNullValue_whenSet_thenStoredAsEmptyString", () => {
    const store = new VariableStore();
    store.set("local", "a", null);
    expect(store.get("a")).toBe("");
  });
});

describe("interpolate", () => {
  const store = () => new VariableStore({ environment: { host: "localhost", port: "9090", greeting: "hi" } });

  it("givenKnownVariables_whenInterpolating_thenSubstitutesAll", () => {
    expect(interpolate("{{host}}:{{port}}", store()).text).toBe("localhost:9090");
  });

  it("givenPaddedToken_whenInterpolating_thenTrimsName", () => {
    expect(interpolate("{{  greeting  }}", store()).text).toBe("hi");
  });

  it("givenTwoGuidTokens_whenInterpolating_thenEachIsEvaluatedIndependently", () => {
    const { text } = interpolate('{"a":"{{$guid}}","b":"{{$guid}}"}', store());
    const parsed = JSON.parse(text) as { a: string; b: string };
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(parsed.a).toMatch(uuid);
    expect(parsed.b).toMatch(uuid);
    expect(parsed.a).not.toBe(parsed.b);
  });

  it("givenTimestampVariables_whenInterpolating_thenProducesExpectedShapes", () => {
    const s = store();
    expect(interpolate("{{$timestamp}}", s).text).toMatch(/^\d{10}$/);
    expect(interpolate("{{$isoTimestamp}}", s).text).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number(interpolate("{{$randomInt}}", s).text)).toBeGreaterThanOrEqual(0);
  });

  it("givenNestedVariable_whenInterpolating_thenExpandsRecursively", () => {
    const s = new VariableStore({ environment: { target: "{{host}}:{{port}}", host: "example.com", port: "443" } });
    expect(interpolate("{{target}}", s).text).toBe("example.com:443");
  });

  it("givenSelfReferentialVariable_whenInterpolating_thenThrowsCycleError", () => {
    const s = new VariableStore({ environment: { a: "{{b}}", b: "{{a}}" } });
    expect(() => interpolate("{{a}}", s)).toThrow(/cycle detected/);
  });

  it("givenUnknownVariable_whenInterpolating_thenReportsMissingAndKeepsToken", () => {
    const result = interpolate("{{host}}/{{nope}}", store());
    expect(result.missing).toEqual(["nope"]);
    expect(result.text).toBe("localhost/{{nope}}");
  });

  it("givenUnsupportedDynamicVariable_whenInterpolating_thenReportedSeparately", () => {
    const result = interpolate("{{$randomBankAccount}}", store());
    expect(result.unsupported).toEqual(["$randomBankAccount"]);
    expect(result.missing).toEqual([]);
  });

  it("givenUnresolvedTokens_whenInterpolateStrict_thenThrowsWithActionableDetails", () => {
    try {
      interpolateStrict("{{nope}} {{$randomBankAccount}}", store(), "message body");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      const cliError = error as CliError;
      expect(cliError.message).toContain("message body");
      expect(cliError.details.join("\n")).toContain("{{nope}}");
      expect(cliError.details.join("\n")).toContain("$randomBankAccount");
    }
  });

  it("givenTextWithoutTokens_whenInterpolateStrict_thenReturnedVerbatim", () => {
    expect(interpolateStrict("plain text", store(), "url")).toBe("plain text");
  });
});
