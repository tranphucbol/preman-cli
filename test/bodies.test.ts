import { describe, expect, it } from "vitest";
import { BodyStore } from "@preman/core/api/bodies.js";
import { PremanError } from "@preman/core/errors.js";

const PREVIEW_BYTES = 256 * 1024;
const FORMAT_LIMIT_BYTES = 2 * 1024 * 1024;
const BODY_RETENTION = 20;
const JSON_TYPE = "application/json";

/** Three bytes in UTF-8, so any window boundary inside one is a split codepoint. */
const SNOWMAN = "\u2603";

function textBody(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

/** A body just over `PREVIEW_BYTES`, so a preview of it must stop short. */
function oversizedBody(): Buffer {
  return Buffer.alloc(PREVIEW_BYTES + 1, 0x61);
}

describe("BodyStore.publish", () => {
  it("givenSmallResponse_whenPublished_thenPreviewIsCompleteAndNotTruncated", () => {
    const store = new BodyStore();
    const published = store.publish(textBody('{"ok":true}'), JSON_TYPE);

    expect(published.preview).toBe('{"ok":true}');
    expect(published.truncated).toBe(false);
    expect(published.byteLength).toBe(11);
    expect(published.contentType).toBe(JSON_TYPE);
  });

  it("givenLargeResponse_whenPublished_thenPreviewIsCappedAndTruncatedIsTrue", () => {
    const store = new BodyStore();
    const published = store.publish(oversizedBody(), "text/plain");

    expect(published.byteLength).toBe(PREVIEW_BYTES + 1);
    expect(Buffer.byteLength(published.preview, "utf8")).toBe(PREVIEW_BYTES);
    expect(published.truncated).toBe(true);
  });

  it("givenEmptyResponse_whenPublished_thenPreviewIsEmptyAndComplete", () => {
    const store = new BodyStore();
    const published = store.publish(Buffer.alloc(0), null);

    expect(published.preview).toBe("");
    expect(published.truncated).toBe(false);
    expect(published.byteLength).toBe(0);
  });
});

describe("BodyStore.window", () => {
  it("givenHandle_whenWindowSpansMultibyteChar_thenSliceIsValidUtf8", () => {
    const store = new BodyStore();
    const bytes = textBody(SNOWMAN.repeat(4));
    const handle = store.put(bytes, null);

    // Four bytes covers the first snowman and one byte of the second.
    const first = store.window(handle, 0, 4);
    expect(first.text).toBe(SNOWMAN);
    expect(first.nextOffset).toBe(3);
    expect(first.eof).toBe(false);

    // Resuming from the reported offset must not skip or repeat a codepoint.
    const second = store.window(handle, first.nextOffset, 12);
    expect(second.text).toBe(SNOWMAN.repeat(3));
    expect(second.eof).toBe(true);
  });

  it("givenOffsetInsideACodepoint_whenWindowed_thenStartMovesToTheBoundary", () => {
    const store = new BodyStore();
    const handle = store.put(textBody(`${SNOWMAN}ok`), null);

    const window = store.window(handle, 1, 16);
    expect(window.offset).toBe(3);
    expect(window.text).toBe("ok");
  });

  it("givenWindowsWalkedToTheEnd_whenConcatenated_thenTheWholeBodyIsRecovered", () => {
    const store = new BodyStore();
    const text = `${SNOWMAN}line one\nline two${SNOWMAN}\n`;
    const handle = store.put(textBody(text), null);

    let offset = 0;
    let seen = "";
    for (;;) {
      const window = store.window(handle, offset, 5);
      seen += window.text;
      if (window.eof) break;
      expect(window.nextOffset).toBeGreaterThan(offset);
      offset = window.nextOffset;
    }
    expect(seen).toBe(text);
  });

  it("givenOffsetPastTheEnd_whenWindowed_thenEmptyAndEof", () => {
    const store = new BodyStore();
    const handle = store.put(textBody("short"), null);

    const window = store.window(handle, 500, 10);
    expect(window.text).toBe("");
    expect(window.eof).toBe(true);
  });
});

describe("BodyStore.search", () => {
  it("givenFindInLargeBody_whenSearching_thenEngineReturnsMatchOffsets", () => {
    const store = new BodyStore();
    const handle = store.put(textBody("alpha\nbeta needle\ngamma\nneedle again\n"), null);

    const matches = store.search(handle, "needle");
    expect(matches.map((m) => m.line)).toEqual([2, 4]);
    expect(matches.map((m) => m.offset)).toEqual([11, 24]);
    expect(matches[0]?.preview).toBe("beta needle");
  });

  it("givenMatchOffset_whenWindowedFromIt_thenTheQueryIsAtTheStart", () => {
    const store = new BodyStore();
    const handle = store.put(textBody(`${SNOWMAN}padding\nfindme here`), null);

    const match = store.search(handle, "findme")[0];
    expect(match).toBeDefined();
    expect(store.window(handle, match!.offset, 6).text).toBe("findme");
  });

  it("givenLimit_whenSearching_thenNoMoreThanThatManyMatches", () => {
    const store = new BodyStore();
    const handle = store.put(textBody("x".repeat(50)), null);

    expect(store.search(handle, "x", 5)).toHaveLength(5);
  });

  it("givenEmptyQuery_whenSearching_thenNoMatches", () => {
    const store = new BodyStore();
    const handle = store.put(textBody("anything"), null);

    expect(store.search(handle, "")).toEqual([]);
  });
});

describe("BodyStore.format", () => {
  it("givenJsonBody_whenFormatted_thenItIsIndented", () => {
    const store = new BodyStore();
    const handle = store.put(textBody('{"a":1,"b":[2]}'), JSON_TYPE);

    expect(store.format(handle)).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  });

  it("givenNonJsonBody_whenFormatted_thenItComesBackUnchanged", () => {
    const store = new BodyStore();
    const handle = store.put(textBody("<html><body>hi</body></html>"), "text/html");

    expect(store.format(handle)).toBe("<html><body>hi</body></html>");
  });

  it("givenBodyAboveFormatLimit_whenFormat_thenPremanError", () => {
    const store = new BodyStore();
    const handle = store.put(Buffer.alloc(FORMAT_LIMIT_BYTES + 1, 0x20), JSON_TYPE);

    expect(() => store.format(handle)).toThrow(PremanError);
    expect(() => store.format(handle)).toThrow(/too large to pretty-print/);
  });
});

describe("BodyStore retention", () => {
  it("givenMoreBodiesThanRetained_whenReadingTheOldest_thenPremanErrorNamesTheHandle", () => {
    const store = new BodyStore();
    const first = store.put(textBody("first"), null);
    for (let n = 0; n < BODY_RETENTION; n += 1) store.put(textBody(`body ${n}`), null);

    expect(store.size).toBe(BODY_RETENTION);
    expect(() => store.head(first)).toThrow(PremanError);
    expect(() => store.head(first)).toThrow(new RegExp(first));
  });

  it("givenAnOldBodyStillBeingRead_whenNewOnesArrive_thenItIsNotEvicted", () => {
    const store = new BodyStore();
    const watched = store.put(textBody("watched"), null);

    for (let n = 0; n < BODY_RETENTION - 1; n += 1) {
      store.put(textBody(`body ${n}`), null);
      // Reading it moves it to the back of the LRU, which is the point.
      expect(store.head(watched).byteLength).toBe(7);
    }
    store.put(textBody("one more"), null);

    expect(store.head(watched).byteLength).toBe(7);
  });

  it("givenReleasedHandle_whenRead_thenPremanError", () => {
    const store = new BodyStore();
    const handle = store.put(textBody("gone soon"), null);
    store.release(handle);

    expect(store.size).toBe(0);
    expect(() => store.head(handle)).toThrow(PremanError);
  });
});
