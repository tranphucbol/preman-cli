import { describe, expect, it } from "vitest";
import { maskComments, offendingLine } from "@preman/core/json/comments.js";

describe("maskComments", () => {
  it("givenALineComment_whenMasked_thenItBecomesSpacesOfTheSameWidth", () => {
    expect(maskComments('{"a":1} // gone')).toBe('{"a":1}        ');
  });

  it("givenABlockComment_whenMasked_thenItBecomesSpaces", () => {
    expect(maskComments('{"a":/* two */2}')).toBe('{"a":         2}');
  });

  /**
   * The whole reason for masking rather than deleting: an offset into the masked text is an
   * offset into the author's text, so nothing downstream has to translate one.
   */
  it("givenAnyComment_whenMasked_thenLengthAndLineCountSurvive", () => {
    const raw = ["{", "  // one", "  /* two", "     still two */", '  "a": 1', "}"].join("\n");
    const masked = maskComments(raw);

    expect(masked.length).toBe(raw.length);
    expect(masked.split("\n").length).toBe(raw.split("\n").length);
  });

  it("givenCommentMarkersInsideAString_whenMasked_thenTheyAreLeftAlone", () => {
    const raw = '{"url": "https://host//p", "note": "a /* b */ c"}';
    expect(maskComments(raw)).toBe(raw);
  });

  it("givenAnEscapedQuote_whenMasked_thenTheStringIsStillClosedAfterIt", () => {
    // If the escape were missed the string would read as open and the comment would survive.
    expect(maskComments('{"q": "he said \\"hi\\"" // gone\n}')).toBe('{"q": "he said \\"hi\\""        \n}');
  });

  it("givenAnUnterminatedBlockComment_whenMasked_thenItRunsToTheEnd", () => {
    expect(maskComments('{"a":1} /* never closed')).toBe('{"a":1}                ');
  });

  it("givenNoComments_whenMasked_thenTheTextIsUntouched", () => {
    const raw = '{\n  "a": [1, 2],\n  "b": "c"\n}';
    expect(maskComments(raw)).toBe(raw);
  });
});

describe("offendingLine", () => {
  it("givenAPositionedMessage_whenAsked_thenTheAuthorsLineComesBack", () => {
    const raw = ["{", "  // one", '  "a": 1,', "}"].join("\n");
    // Position 21 is the closing brace on line 4; the comment above it must not shift the count.
    expect(offendingLine(raw, "Expected property name in JSON at position 21")).toEqual(["  line 4: }"]);
  });

  it("givenNoPositionInTheMessage_whenAsked_thenNothingIsInvented", () => {
    expect(offendingLine('{"a":}', "JSON Parse error: Unexpected token '}'")).toEqual([]);
  });

  it("givenAPositionPastTheEnd_whenAsked_thenNothingIsInvented", () => {
    expect(offendingLine("{}", "Unexpected end of JSON input at position 999")).toEqual([]);
  });
});
