import { describe, expect, it } from "vitest";
import { isEventStream, SseParser, type SseFrame } from "@preman/core/http/sse.js";

/**
 * The server-sent events reader, exercised without a socket.
 *
 * Most of these assert a chunk boundary rather than a syntax, because the syntax is the
 * easy half. A stream arrives split wherever the network felt like splitting it, and every
 * boundary below - mid-line, between the halves of a CRLF, between the bytes of one
 * codepoint - is one preman has to survive without inventing or losing a frame.
 */

const AT = 1_700_000_000_000;
const LATER = AT + 5;
const UTF8: BufferEncoding = "utf8";
const NO_FRAMES = 0;
const ONE_FRAME = 1;
const TWO_FRAMES = 2;
const FIRST = 0;
const SECOND = 1;
const FIRST_SEQ = 1;
const SECOND_SEQ = 2;

function feed(parser: SseParser, text: string, at = AT): SseFrame[] {
  return parser.push(Buffer.from(text, UTF8), at);
}

/** Push the whole text as one chunk and close, the way a short stream behaves. */
function read(text: string): SseFrame[] {
  const parser = new SseParser();
  return [...feed(parser, text), ...parser.end(LATER)];
}

describe("reading a text/event-stream", () => {
  it("givenOneBlock_whenRead_thenDispatchesOneFrame", () => {
    const frames = read("data: hello\n\n");
    expect(frames).toHaveLength(ONE_FRAME);
    expect(frames[FIRST]?.data).toBe("hello");
    expect(frames[FIRST]?.seq).toBe(FIRST_SEQ);
    expect(frames[FIRST]?.at).toBe(AT);
  });

  it("givenSeveralDataLines_whenRead_thenJoinsThemWithNewlines", () => {
    const frames = read("data: one\ndata: two\ndata: three\n\n");
    expect(frames[FIRST]?.data).toBe("one\ntwo\nthree");
  });

  it("givenNamedEvent_whenRead_thenCarriesTheNameAndClearsItAfterwards", () => {
    const frames = read("event: delta\ndata: a\n\ndata: b\n\n");
    expect(frames).toHaveLength(TWO_FRAMES);
    expect(frames[FIRST]?.event).toBe("delta");
    expect(frames[SECOND]?.event).toBe("");
    expect(frames[SECOND]?.seq).toBe(SECOND_SEQ);
  });

  it("givenAnId_whenLaterFrameOmitsIt_thenTheIdPersists", () => {
    const frames = read("id: 7\ndata: a\n\ndata: b\n\n");
    expect(frames[FIRST]?.id).toBe("7");
    expect(frames[SECOND]?.id).toBe("7");
  });

  it("givenIdContainingNul_whenRead_thenTheIdIsIgnored", () => {
    const frames = read("id: bad\u0000id\ndata: a\n\n");
    expect(frames[FIRST]?.id).toBe("");
  });

  it("givenKeepAliveComments_whenRead_thenNothingIsDispatched", () => {
    expect(read(": ping\n\n: ping\n\n")).toHaveLength(NO_FRAMES);
  });

  it("givenRetryField_whenRead_thenItIsNotMistakenForData", () => {
    const frames = read("retry: 3000\ndata: a\n\n");
    expect(frames).toHaveLength(ONE_FRAME);
    expect(frames[FIRST]?.data).toBe("a");
  });

  it("givenFieldWithNoColon_whenRead_thenTheValueIsEmpty", () => {
    const frames = read("data\n\n");
    expect(frames[FIRST]?.data).toBe("");
  });

  it("givenValueWithTwoLeadingSpaces_whenRead_thenOnlyOneIsSyntax", () => {
    const frames = read("data:  spaced\n\n");
    expect(frames[FIRST]?.data).toBe(" spaced");
  });

  it("givenUnknownField_whenRead_thenItIsIgnored", () => {
    const frames = read("banana: yes\ndata: a\n\n");
    expect(frames[FIRST]?.data).toBe("a");
  });

  it("givenBlankLinesOnly_whenRead_thenNothingIsDispatched", () => {
    expect(read("\n\n\n\n")).toHaveLength(NO_FRAMES);
  });

  it("givenEventWithoutData_whenRead_thenNothingIsDispatched", () => {
    expect(read("event: ready\n\n")).toHaveLength(NO_FRAMES);
  });
});

describe("reading a stream split across chunks", () => {
  it("givenChunkSplitMidLine_whenRead_thenTheFrameIsWhole", () => {
    const parser = new SseParser();
    expect(feed(parser, "data: hel")).toHaveLength(NO_FRAMES);
    const frames = feed(parser, "lo\n\n", LATER);
    expect(frames[FIRST]?.data).toBe("hello");
    expect(frames[FIRST]?.at).toBe(LATER);
  });

  it("givenChunkSplitBetweenCrAndLf_whenRead_thenTheBlankLineIsNotDoubled", () => {
    const parser = new SseParser();
    const first = feed(parser, "data: hello\r\n\r");
    expect(first).toHaveLength(NO_FRAMES);
    expect(feed(parser, "\n")).toHaveLength(ONE_FRAME);
  });

  it("givenChunkSplitInsideACodepoint_whenRead_thenTheCharacterSurvives", () => {
    const bytes = Buffer.from("data: 😀\n\n", UTF8);
    const cut = bytes.indexOf("😀", 0, UTF8) + 2;
    const parser = new SseParser();
    parser.push(bytes.subarray(0, cut), AT);
    const frames = parser.push(bytes.subarray(cut), AT);
    expect(frames[FIRST]?.data).toBe("😀");
  });

  it("givenByteOrderMark_whenRead_thenItIsNotPartOfTheFirstField", () => {
    const frames = read("\ufeffdata: hello\n\n");
    expect(frames[FIRST]?.data).toBe("hello");
  });

  it("givenByteOrderMarkSplitFromTheRest_whenRead_thenItIsStillStripped", () => {
    const bytes = Buffer.from("\ufeffdata: hello\n\n", UTF8);
    const parser = new SseParser();
    parser.push(bytes.subarray(0, 1), AT);
    const frames = parser.push(bytes.subarray(1), AT);
    expect(frames[FIRST]?.data).toBe("hello");
  });

  it("givenCarriageReturnsOnly_whenRead_thenTheyTerminateLines", () => {
    expect(read("data: a\r\rdata: b\r\r")).toHaveLength(TWO_FRAMES);
  });
});

describe("closing a text/event-stream", () => {
  it("givenBlockWithoutTrailingBlankLine_whenEnded_thenItIsStillDispatched", () => {
    const parser = new SseParser();
    expect(feed(parser, "data: last")).toHaveLength(NO_FRAMES);
    const frames = parser.end(LATER);
    expect(frames).toHaveLength(ONE_FRAME);
    expect(frames[FIRST]?.data).toBe("last");
    expect(frames[FIRST]?.at).toBe(LATER);
  });

  it("givenNothingPending_whenEnded_thenNoFrameIsInvented", () => {
    const parser = new SseParser();
    feed(parser, "data: a\n\n");
    expect(parser.end(LATER)).toHaveLength(NO_FRAMES);
  });

  it("givenEmptyStream_whenEnded_thenNothingIsDispatched", () => {
    expect(read("")).toHaveLength(NO_FRAMES);
  });
});

describe("recognising the media type", () => {
  it("givenEventStreamWithCharset_whenChecked_thenItIsAStream", () => {
    expect(isEventStream("text/event-stream; charset=utf-8")).toBe(true);
  });

  it("givenMixedCaseAndPadding_whenChecked_thenItIsAStream", () => {
    expect(isEventStream("  Text/Event-Stream  ")).toBe(true);
  });

  it("givenJson_whenChecked_thenItIsNotAStream", () => {
    expect(isEventStream("application/json")).toBe(false);
  });

  it("givenNoContentType_whenChecked_thenItIsNotAStream", () => {
    expect(isEventStream(undefined)).toBe(false);
  });
});
