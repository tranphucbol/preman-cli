/**
 * The beautifier for an authored body, and the round trip it refuses to be.
 *
 * The literal cases here are the load-bearing ones: a bare token, a twenty-digit id, `1.0` and
 * `1e3` are all bytes that `JSON.stringify(JSON.parse(text))` rewrites, and rewriting them makes a
 * different request. They exist so that anyone who tries to replace this module with core's
 * `BodyStore.format` finds out from the suite rather than from production. The last three document
 * the two holes inherited from `maskTemplates`, rather than wishing them away.
 */
import { describe, expect, it } from "vitest";

import { formatJsonTemplate } from "@preman/desktop/renderer/model/format.js";
import { MASK_LIMIT_CHARS } from "@preman/desktop/renderer/ui/template.js";

/** What a real gRPC message looks like: a token bare in a numeric field, quoted in a string one. */
const AUTHORED = `{"app_id": {{app_id}}, "dest": {"merchant": {"app_id": {{app_id}}}}}`;

const LITERALS = `{"big":12345678901234567890,"f":1.0,"e":1e3,"neg":-0.0}`;

function formatted(text: string): string {
  const outcome = formatJsonTemplate(text);
  if (!outcome.ok) throw new Error(`expected a format, got: ${outcome.reason}`);
  return outcome.text;
}

function refused(text: string): string {
  const outcome = formatJsonTemplate(text);
  if (outcome.ok) throw new Error(`expected a refusal, got: ${outcome.text}`);
  return outcome.reason;
}

describe("formatJsonTemplate", () => {
  it("givenNestedObject_whenFormatted_thenTwoSpaceIndented", () => {
    expect(formatted(`{"a":{"b":[1,2]}}`)).toBe(
      ["{", '  "a": {', '    "b": [', "      1,", "      2", "    ]", "  }", "}"].join("\n"),
    );
  });

  it("givenBareToken_whenFormatted_thenTheTokenIsByteIdentical", () => {
    const out = formatted(AUTHORED);

    expect(out).toContain(`"app_id": {{app_id}}`);
    expect(out.match(/\{\{app_id\}\}/g)).toHaveLength(2);
  });

  it("givenQuotedToken_whenFormatted_thenTheStringIsUntouched", () => {
    expect(formatted(`{ "id" : "{{app_trans_id}}" }`)).toBe(`{\n  "id": "{{app_trans_id}}"\n}`);
  });

  it("givenTwentyDigitInteger_whenFormatted_thenEveryDigitSurvives", () => {
    expect(formatted(LITERALS)).toContain(`"big": 12345678901234567890`);
  });

  it("givenExponentAndTrailingZeroLiterals_whenFormatted_thenTheBytesAreUnchanged", () => {
    const out = formatted(LITERALS);

    expect(out).toContain(`"f": 1.0`);
    expect(out).toContain(`"e": 1e3`);
    expect(out).toContain(`"neg": -0.0`);
  });

  it("givenStringContainingBracesAndEscapedQuote_whenFormatted_thenTheStringIsUntouched", () => {
    // The escaped quote is what stops the scanner ending the string early, and the braces inside it
    // are what stops it indenting on punctuation that is only text.
    expect(formatted(`{"s":"a{\\"b\\",[c]}"}`)).toBe(`{\n  "s": "a{\\"b\\",[c]}"\n}`);
  });

  it("givenEmptyObjectAndArray_whenFormatted_thenTheyStayCompact", () => {
    expect(formatted(`{"o":{},"a":[ ],"n":[{}]}`)).toBe(
      ["{", '  "o": {},', '  "a": [],', '  "n": [', "    {}", "  ]", "}"].join("\n"),
    );
  });

  it("givenFormattedText_whenFormattedAgain_thenUnchanged", () => {
    const once = formatted(AUTHORED);

    expect(formatted(once)).toBe(once);
  });

  it("givenWhitespaceOnly_whenFormatted_thenOkAndUnchanged", () => {
    expect(formatJsonTemplate("  \n ")).toStrictEqual({ ok: true, text: "  \n " });
    expect(formatJsonTemplate("")).toStrictEqual({ ok: true, text: "" });
  });

  it("givenMalformedJson_whenFormatted_thenNotOkWithAReason", () => {
    expect(refused(`{"a": }`)).toContain("JSON");
  });

  it("givenAdjacentBareTokens_whenFormatted_thenNotOk", () => {
    expect(refused(`{"a": {{one}}{{two}}}`)).toContain("two tokens with nothing between them");
  });

  it("givenBareTokenAsKey_whenFormatted_thenNotOk", () => {
    expect(refused(`{{{name}}: 1}`)).toContain("a key");
  });

  it("givenTextLongerThanTheMaskLimit_whenFormatted_thenNotOkNamingTheLimit", () => {
    const oversize = `{"a":"${"x".repeat(MASK_LIMIT_CHARS)}"}`;

    expect(refused(oversize)).toContain(String(MASK_LIMIT_CHARS));
  });
});
