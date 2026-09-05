/**
 * The renderer's own comment scanner, and the mask the grammar is actually handed.
 *
 * This is deliberately a second copy of `packages/core/src/json/comments.ts`, because the renderer
 * may not import the engine. The cases here are the ones that would tell you the two copies had
 * drifted: the same strings appear in `test/json.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { commentRanges, maskComments } from "@preman/desktop/renderer/model/comments.js";
import { maskAuthored } from "@preman/desktop/renderer/ui/template.js";

/** A body of the shape that opened all of this: two fields commented out of a real request. */
const AUTHORED = ["{", '  "amount": "100",', '  // "request_time": "",', '  "type": "BT_FREEZE"', "}"].join("\n");

describe("commentRanges", () => {
  it("givenALineComment_whenScanned_thenTheRangeStopsBeforeTheNewline", () => {
    const ranges = commentRanges(AUTHORED);
    const [only] = ranges;

    expect(ranges).toHaveLength(1);
    expect(AUTHORED.slice(only?.from, only?.to)).toBe('  // "request_time": "",'.trim());
  });

  it("givenABlockComment_whenScanned_thenTheCloserIsIncluded", () => {
    const ranges = commentRanges('{/* why */ "a": 1}');

    expect(ranges).toEqual([{ from: 1, to: 10 }]);
  });

  it("givenCommentMarkersInsideAString_whenScanned_thenNothingIsFound", () => {
    expect(commentRanges('{"url": "https://h//p", "note": "a /* b"}')).toEqual([]);
  });

  it("givenAnEscapedQuote_whenScanned_thenTheStringIsStillClosed", () => {
    // If the escape were not honoured the string would read as open and the comment would be missed.
    const ranges = commentRanges('{"q": "say \\"hi\\"",\n// dropped\n"n": 1}');

    expect(ranges).toHaveLength(1);
  });

  it("givenAnUnterminatedBlockComment_whenScanned_thenItRunsToTheEnd", () => {
    const text = '{"a": 1 /* forever';

    expect(commentRanges(text)).toEqual([{ from: 8, to: text.length }]);
  });

  it("givenNoComments_whenScanned_thenNothingIsFound", () => {
    expect(commentRanges('{"a": 1}')).toEqual([]);
  });
});

describe("maskComments", () => {
  it("givenComments_whenMasked_thenLengthAndLinesSurvive", () => {
    const masked = maskComments(AUTHORED);

    expect(masked).toHaveLength(AUTHORED.length);
    expect(masked.split("\n")).toHaveLength(AUTHORED.split("\n").length);
  });

  it("givenComments_whenMasked_thenWhatIsLeftIsParseableJson", () => {
    // The whole point: the grammar is handed a legal document, so there are no error nodes to
    // break folding or bracket matching with.
    expect(JSON.parse(maskComments(AUTHORED))).toEqual({ amount: "100", type: "BT_FREEZE" });
  });

  it("givenNoComments_whenMasked_thenTheTextIsReturnedUnchanged", () => {
    const text = '{"a": 1}';

    expect(maskComments(text)).toBe(text);
  });
});

describe("maskAuthored", () => {
  it("givenATokenAndAComment_whenMasked_thenBothAreGoneAndTheRestParses", () => {
    const text = '{"id": {{app_id}},\n// "t": "",\n"s": "{{name}}"}';
    const masked = maskAuthored(text);

    expect(masked).toHaveLength(text.length);
    expect(() => JSON.parse(masked) as unknown).not.toThrow();
  });

  it("givenSlashesInsideAToken_whenMasked_thenTheTokenIsNotReadAsAComment", () => {
    // Tokens are masked first for exactly this: the comment scan never sees the slashes.
    const masked = maskAuthored('{"a": {{x//y}}}');

    expect(JSON.parse(masked)).toEqual({ a: 0.0 });
  });

  it("givenATokenInsideAComment_whenMasked_thenTheWholeLineIsBlank", () => {
    const masked = maskAuthored('{\n// "a": {{x}},\n"b": 1}');

    expect(JSON.parse(masked)).toEqual({ b: 1 });
  });
});
