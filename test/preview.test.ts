import { afterEach, describe, expect, it } from "vitest";
import { previewText } from "@preman/core/api/preview.js";
import { PremanError } from "@preman/core/errors.js";
import { findEnvironment, saveEnvironmentValues } from "@preman/core/workspace/environments.js";

import { cloneFixtureWorkspace, FIXTURE_WS, type ClonedWorkspace } from "./helpers.js";

const NO_NAMES: string[] = [];

/**
 * `previewText` is the engine's answer to "what would this text become", and the substitution
 * itself is `interpolate`'s, covered by `vars.test.ts`. What is pinned here is the preview
 * contract: which layers are in play, that a bad token does not cost the good ones their value,
 * and that only the two unrecoverable cases throw.
 */
describe("previewText", () => {
  let clone: ClonedWorkspace | undefined;

  afterEach(() => {
    clone?.cleanup();
    clone = undefined;
  });

  it("givenTextWithResolvableToken_whenPreviewed_thenTextIsSubstituted", () => {
    const preview = previewText(FIXTURE_WS, "LOCAL", "say {{greeting}}");

    expect(preview.text).toBe("say hello");
    expect(preview.missing).toEqual(NO_NAMES);
    expect(preview.unsupported).toEqual(NO_NAMES);
  });

  it("givenTextWithUnknownToken_whenPreviewed_thenNameIsMissingAndTextKeepsTheToken", () => {
    const preview = previewText(FIXTURE_WS, "LOCAL", "say {{greetng}}");

    expect(preview.text).toBe("say {{greetng}}");
    expect(preview.missing).toEqual(["greetng"]);
  });

  it("givenTextWithBothKinds_whenPreviewed_thenTheGoodOneResolvesAnyway", () => {
    // A preview of a body with one bad token must still show the other nine substituted,
    // which is why this calls `interpolate` and not `interpolateStrict`.
    const preview = previewText(FIXTURE_WS, "LOCAL", "{{greeting}} {{greetng}}");

    expect(preview.text).toBe("hello {{greetng}}");
    expect(preview.missing).toEqual(["greetng"]);
  });

  it("givenShadowedKey_whenPreviewed_thenEnvironmentWins", () => {
    expect(previewText(FIXTURE_WS, "LOCAL", "{{greeting}}").text).toBe("hello");
  });

  it("givenNoEnvironment_whenPreviewed_thenGlobalsStillResolve", () => {
    const preview = previewText(FIXTURE_WS, null, "{{global_only}} {{greeting}}");

    expect(preview.text).toBe("from-globals overridden-by-environment");
    expect(preview.missing).toEqual(NO_NAMES);
  });

  it("givenNullAndUndefinedEnvironment_whenPreviewed_thenAnswersMatch", () => {
    // An inspection has no ambiguity to resolve, so it never adopts the sole environment.
    expect(previewText(FIXTURE_WS, undefined, "{{greeting}}")).toStrictEqual(
      previewText(FIXTURE_WS, null, "{{greeting}}"),
    );
  });

  it("givenNestedToken_whenPreviewed_thenExpansionIsRecursive", () => {
    expect(previewText(FIXTURE_WS, "LOCAL", "{{nested_token}}").text).toBe("hello world");
  });

  it("givenCyclicToken_whenPreviewed_thenPremanErrorNamesTheChain", () => {
    clone = cloneFixtureWorkspace();
    const env = findEnvironment(clone.workspace, "LOCAL");
    saveEnvironmentValues(env!.filePath, { loop_a: "{{loop_b}}", loop_b: "{{loop_a}}" });

    try {
      previewText(clone.root, "LOCAL", "{{loop_a}}");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PremanError);
      expect((error as PremanError).message).toContain("loop_a -> loop_b -> loop_a");
    }
  });

  it("givenUnsupportedDynamicVariable_whenPreviewed_thenNameIsUnsupported", () => {
    const preview = previewText(FIXTURE_WS, "LOCAL", "{{$notAGenerator}}");

    expect(preview.text).toBe("{{$notAGenerator}}");
    expect(preview.unsupported).toEqual(["$notAGenerator"]);
    expect(preview.missing).toEqual(NO_NAMES);
  });

  it("givenEmptyText_whenPreviewed_thenNoDiagnostics", () => {
    expect(previewText(FIXTURE_WS, "LOCAL", "")).toEqual({ text: "", missing: NO_NAMES, unsupported: NO_NAMES });
  });
});
