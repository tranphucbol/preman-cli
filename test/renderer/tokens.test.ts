/**
 * Which `{{token}}` a click landed on, and what the box that opens on it is allowed to offer.
 *
 * Both halves are pure by design rather than by accident. The editors hit-test with a CodeMirror
 * document position and the plain fields hit-test with `selectionStart`, so both arrive holding a
 * string and an integer; and the box's four situations are read off the view the engine answered
 * with rather than off the DOM. That is what makes them assertable here, where there is no window.
 *
 * The `tokenState` cases run against the real fixture workspace instead of a hand-built view, so
 * the precedence they assert is the precedence `readVariables` actually reports.
 */
import { describe, expect, it } from "vitest";

import { readVariables } from "@preman/core/api/variables.js";
import { couldHaveTokens, findTokens, tokenAt, tokenState } from "@preman/desktop/renderer/model/tokens.js";
import { FIXTURE_WS } from "../helpers.js";

/** The fixture's environment, and the only writable layer in it. */
const LOCAL = "LOCAL";

/** A name no layer of the fixture carries. */
const UNDEFINED_NAME = "not_a_variable_anywhere";

describe("finding the tokens in a piece of text", () => {
  it("givenTextWithTwoTokens_whenFound_thenBothSpansAreExact", () => {
    const text = `{ "id": {{app_id}}, "to": "{{merchant}}" }`;

    const found = findTokens(text);

    expect(found.map((token) => token.name)).toEqual(["app_id", "merchant"]);
    // The span is what the backdrop paints and what the editor underlines, so it has to slice back
    // to the whole token, braces included.
    expect(found.map((token) => text.slice(token.from, token.to))).toEqual(["{{app_id}}", "{{merchant}}"]);
  });

  it("givenSpacedToken_whenFound_thenNameIsTrimmed", () => {
    const text = "a {{  spaced  }} b";

    const [token] = findTokens(text);

    // The name is what gets sent to `readVariables`, so it has to match the key in the file.
    expect(token?.name).toBe("spaced");
    // The span is not trimmed with it: the padding is part of the token the user clicked.
    expect(text.slice(token?.from, token?.to)).toBe("{{  spaced  }}");
  });

  it("givenEmptyBraces_whenFound_thenNothingMatches", () => {
    // `ui/template.ts` masks `{{}}` because the parser has to be told those braces are not JSON.
    // A box has nothing to open on, so this pattern does not match it at all.
    expect(findTokens("{{}} {{ }}")).toEqual([]);
  });

  it("givenTextWithNoBrace_whenAsked_thenTheRegexIsNeverReached", () => {
    // The cheap guard the grid leans on, asserted as the behaviour it promises rather than as a
    // count of regex calls.
    expect(couldHaveTokens("plain value")).toBe(false);
    expect(couldHaveTokens("{{greeting}}")).toBe(true);
    expect(findTokens("plain value")).toEqual([]);
  });
});

describe("hit-testing an offset against the tokens", () => {
  const TEXT = `ab{{greeting}}cd`;

  it("givenOffsetInsideToken_whenAsked_thenTokenIsReturned", () => {
    expect(tokenAt(TEXT, TEXT.indexOf("greeting"))?.name).toBe("greeting");
  });

  it("givenOffsetOnTheBrace_whenAsked_thenTokenIsReturned", () => {
    const from = TEXT.indexOf("{{");
    const to = from + "{{greeting}}".length;

    // Both ends count. A caret at `to` is a caret the user put there by clicking the last `}`, and
    // that is where `selectionStart` reports it.
    expect(tokenAt(TEXT, from)?.name).toBe("greeting");
    expect(tokenAt(TEXT, to)?.name).toBe("greeting");
  });

  it("givenOffsetOutsideEveryToken_whenAsked_thenNullIsReturned", () => {
    expect(tokenAt(TEXT, 0)).toBeNull();
    expect(tokenAt(TEXT, TEXT.length)).toBeNull();
    expect(tokenAt("no tokens here", 3)).toBeNull();
  });
});

describe("what the box may offer for a name", () => {
  it("givenDynamicName_whenResolved_thenNothingIsStorable", () => {
    // Ahead of the lookup on purpose: a `{{$guid}}` is generated per occurrence at send time, so
    // there is no value to show even if some environment happens to carry that key.
    expect(tokenState(readVariables(FIXTURE_WS, LOCAL), "$guid")).toEqual({ kind: "dynamic" });
  });

  it("givenNameInTheEnvironment_whenResolved_thenItIsWritableAndNamesWhatItShadows", () => {
    const state = tokenState(readVariables(FIXTURE_WS, LOCAL), "greeting");

    // The fixture defines `greeting` in both layers, and the environment wins.
    expect(state).toEqual({
      kind: "writable",
      value: "hello",
      environment: LOCAL,
      shadows: ["globals"],
    });
  });

  it("givenNameOnlyInGlobals_whenResolved_thenItIsReadOnlyAndNamesTheFile", () => {
    const state = tokenState(readVariables(FIXTURE_WS, LOCAL), "global_only");

    expect(state.kind).toBe("read-only");
    if (state.kind !== "read-only") return;
    expect(state.value).toBe("from-globals");
    // The file is the actionable half of a layer preman cannot write.
    expect(state.file).toContain("workspace.globals.yaml");
  });

  it("givenUndefinedName_whenResolvedWithAnEnvironment_thenItIsAbsentAndOfferable", () => {
    expect(tokenState(readVariables(FIXTURE_WS, LOCAL), UNDEFINED_NAME)).toEqual({
      kind: "absent",
      environment: LOCAL,
    });
  });

  it("givenUndefinedName_whenNoEnvironmentIsChosen_thenThereIsNowhereToDefineIt", () => {
    // Distinct from `absent`: the box has no environment to name, so it offers no field rather than
    // an empty one that could not be saved.
    expect(tokenState(readVariables(FIXTURE_WS, null), UNDEFINED_NAME)).toEqual({ kind: "no-environment" });
  });

  it("givenNameInGlobals_whenNoEnvironmentIsChosen_thenItStillResolves", () => {
    // Globals are in the chain whether or not an environment is, so this is read-only and not
    // `no-environment`.
    expect(tokenState(readVariables(FIXTURE_WS, null), "global_only").kind).toBe("read-only");
  });
});
