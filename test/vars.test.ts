import { describe, expect, it } from "vitest";
import { PremanError } from "@preman/core/errors.js";
import { interpolate, interpolateStrict } from "@preman/core/vars/interpolate.js";
import { readVariables, type VariableBinding, type VariableView } from "@preman/core/api/variables.js";
import { VariableStore } from "@preman/core/vars/store.js";

import { fixtureWorkspace } from "./helpers.js";

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

  it("givenDataAndEnvironmentBothSetKey_whenReading_thenEnvironmentWins", () => {
    const store = new VariableStore({ data: { value: "data" }, environment: { value: "environment" } });
    expect(store.get("value")).toBe("environment");
  });

  it("givenDataAndCollectionBothSetKey_whenReading_thenDataWins", () => {
    const store = new VariableStore({ collection: { value: "collection" }, data: { value: "data" } });
    expect(store.get("value")).toBe("data");
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

  it("givenTwoOccurrencesOfSameDynamicVariable_whenInterpolating_thenValuesDiffer", () => {
    const [first, second] = interpolate("{{$randomUUID}} {{$randomUUID}}", store()).text.split(" ");
    expect(first).not.toBe(second);
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

  it("givenDynamicVariableInsideResolvedToken_whenInterpolating_thenStillGenerated", () => {
    const s = new VariableStore({ environment: { generated: "{{$randomEmail}}" } });
    expect(interpolate("{{generated}}", s).text).toMatch(/@/);
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
    const result = interpolate("{{$randomEmial}}", store());
    expect(result.unsupported).toEqual(["$randomEmial"]);
    expect(result.missing).toEqual([]);
  });

  it("givenUnresolvedTokens_whenInterpolateStrict_thenThrowsWithActionableDetails", () => {
    try {
      interpolateStrict("{{nope}} {{$randomEmial}}", store(), "message body");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PremanError);
      const cliError = error as PremanError;
      expect(cliError.message).toContain("message body");
      expect(cliError.details.join("\n")).toContain("{{nope}}");
      expect(cliError.details.join("\n")).toContain("$randomEmail");
    }
  });

  it("givenTextWithoutTokens_whenInterpolateStrict_thenReturnedVerbatim", () => {
    expect(interpolateStrict("plain text", store(), "url")).toBe("plain text");
  });
});

/**
 * The scope chain as a reader sees it. `readVariables` never re-implements precedence - it asks
 * `VariableStore` - so what is pinned here is the reporting: which layers exist, which one wins
 * each key, and which ones lost.
 */
describe("readVariables", () => {
  const FIXTURE = fixtureWorkspace().root;

  function bindingOf(view: VariableView, key: string): VariableBinding {
    const found = view.bindings.find((binding) => binding.key === key);
    if (found === undefined) throw new Error(`no binding for ${key}`);
    return found;
  }

  it("givenEnvironmentAndGlobals_whenRead_thenLayersAreLowestPrecedenceFirst", () => {
    const view = readVariables(FIXTURE, "LOCAL");

    expect(view.environment).toBe("LOCAL");
    expect(view.layers.map((layer) => layer.scope)).toEqual(["globals", "environment"]);
    expect(view.layers.map((layer) => layer.writable)).toEqual([false, true]);
    expect(view.layers[1]?.label).toBe("LOCAL");
  });

  it("givenKeyInBothLayers_whenRead_thenEnvironmentWinsAndGlobalsIsRecordedAsShadowed", () => {
    const greeting = bindingOf(readVariables(FIXTURE, "LOCAL"), "greeting");

    expect(greeting.value).toBe("hello");
    expect(greeting.scope).toBe("environment");
    expect(greeting.shadowed).toEqual(["globals"]);
  });

  it("givenKeyOnlyInGlobals_whenRead_thenGlobalsWinsAndNothingIsShadowed", () => {
    const only = bindingOf(readVariables(FIXTURE, "LOCAL"), "global_only");

    expect(only.value).toBe("from-globals");
    expect(only.scope).toBe("globals");
    expect(only.shadowed).toEqual([]);
  });

  it("givenDisabledEnvironmentRow_whenRead_thenItIsAbsentJustAsItIsForARun", () => {
    const view = readVariables(FIXTURE, "LOCAL");

    expect(view.bindings.some((binding) => binding.key === "disabled_var")).toBe(false);
  });

  it("givenNoEnvironment_whenRead_thenOnlyGlobalsRemainAndTheEnvironmentValueIsGone", () => {
    const view = readVariables(FIXTURE, null);

    expect(view.environment).toBeUndefined();
    expect(view.layers.map((layer) => layer.scope)).toEqual(["globals"]);
    expect(bindingOf(view, "greeting").value).toBe("overridden-by-environment");
  });

  it("givenUndefinedEnvironment_whenRead_thenItAnswersTheSameAsNull", () => {
    // An inspection has no ambiguity to resolve, so unlike a run it neither adopts the sole
    // environment nor asks which one was meant.
    expect(readVariables(FIXTURE, undefined)).toStrictEqual(readVariables(FIXTURE, null));
  });

  it("givenUnknownEnvironment_whenRead_thenTheCandidatesAreListed", () => {
    try {
      readVariables(FIXTURE, "NOPE");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PremanError);
      expect((error as PremanError).details.join("\n")).toContain("LOCAL");
    }
  });

  it("givenBindings_whenRead_thenKeysAreSortedSoTheTableNeedsNoSecondPass", () => {
    const keys = readVariables(FIXTURE, "LOCAL").bindings.map((binding) => binding.key);

    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });
});
