import { describe, expect, it } from "vitest";
import { CliError } from "@/errors.js";
import { buildBody } from "@/http/body.js";
import { VariableStore } from "@/vars/store.js";
import type { FileReader } from "@/workspace/files.js";

const FILE_BYTES = Buffer.from([0, 1, 2, 255]);
const BOUNDARY = "fixed-boundary";

function store(): VariableStore {
  return new VariableStore({ environment: { value: "a+b", file: "receipt.pdf" } });
}

function files(overrides: Partial<FileReader> = {}): FileReader {
  return {
    resolve: (src) => `/work/${src}`,
    read: () => FILE_BYTES,
    ...overrides,
  };
}

describe("buildBody", () => {
  it("givenRawJsonBody_whenBuild_thenUnchangedStringAndJsonContentType", () => {
    const result = buildBody({ body: { type: "json", content: '{"a":1}' }, store: store(), files: files() });
    expect(result.wire).toEqual({ content: '{"a":1}', contentType: "application/json" });
  });

  it("givenStructuredUrlencoded_whenBuild_thenPercentEncodedPairs", () => {
    const result = buildBody({
      body: { type: "urlencoded", urlencoded: [{ key: "sig", value: "{{value}}" }] },
      store: store(),
      files: files(),
    });
    expect(result.wire).toEqual({ content: "sig=a%2Bb", contentType: "application/x-www-form-urlencoded" });
  });

  it("givenStructuredUrlencodedWithDisabledEntry_whenBuild_thenEntryDropped", () => {
    const result = buildBody({
      body: { type: "urlencoded", urlencoded: [{ key: "skip", value: "{{missing}}", disabled: true }] },
      store: store(),
      files: files(),
    });
    expect(result.wire).toEqual({ content: undefined, contentType: undefined });
  });

  it("givenUrlencodedWithBothContentAndArray_whenBuild_thenArrayWinsWithWarning", () => {
    const result = buildBody({
      body: { type: "urlencoded", content: "old=1", urlencoded: { current: "2" } },
      store: store(),
      files: files(),
    });
    expect(result.wire.content).toBe("current=2");
    expect(result.warnings).toContain("body.content ignored because body.urlencoded is present");
  });

  it("givenFormDataTextParts_whenBuild_thenBoundaryDelimitedBytes", () => {
    const result = buildBody({
      body: { type: "formdata", formdata: [{ key: "note", type: "text", value: "{{value}}" }] },
      store: store(),
      files: files(),
      boundary: BOUNDARY,
    });
    expect(result.wire.content?.toString()).toBe(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\na+b\r\n--${BOUNDARY}--\r\n`,
    );
    expect(result.wire.contentType).toBe(`multipart/form-data; boundary=${BOUNDARY}`);
  });

  it("givenFormDataFilePart_whenBuild_thenFilenameAndContentTypeHeadersPresent", () => {
    const result = buildBody({
      body: { type: "formdata", formdata: [{ key: "receipt", type: "file", src: "receipt.pdf" }] },
      store: store(),
      files: files(),
      boundary: BOUNDARY,
    });
    const content = result.wire.content as Buffer;
    expect(
      content.subarray(0, content.length - FILE_BYTES.length - `\r\n--${BOUNDARY}--\r\n`.length).toString(),
    ).toContain(
      'Content-Disposition: form-data; name="receipt"; filename="receipt.pdf"\r\nContent-Type: application/pdf',
    );
    expect(content.includes(FILE_BYTES)).toBe(true);
  });

  it("givenMixedFormData_whenBuild_thenEveryWireByteMatches", () => {
    const result = buildBody({
      body: {
        type: "formdata",
        formdata: [
          { key: "note", type: "text", value: "one" },
          { key: "receipt", type: "file", src: "receipt.pdf" },
        ],
      },
      store: store(),
      files: files(),
      boundary: BOUNDARY,
    });
    const expected = Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\none\r\n`),
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="receipt"; filename="receipt.pdf"\r\n` +
          "Content-Type: application/pdf\r\n\r\n",
      ),
      FILE_BYTES,
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]);
    expect(result.wire.content).toEqual(expected);
  });

  it("givenFormDataFilePartWithExplicitContentType_whenBuild_thenExplicitTypeUsed", () => {
    const result = buildBody({
      body: {
        type: "formdata",
        formdata: [{ key: "data", type: "file", src: "receipt.pdf", contentType: "application/x-receipt" }],
      },
      store: store(),
      files: files(),
      boundary: BOUNDARY,
    });
    expect(result.wire.content?.toString()).toContain("Content-Type: application/x-receipt");
  });

  it("givenFormDataKeyWithQuote_whenBuild_thenEscapedInDisposition", () => {
    const result = buildBody({
      body: { type: "formdata", formdata: [{ key: 'a"b\\c', type: "text", value: "1" }] },
      store: store(),
      files: files(),
      boundary: BOUNDARY,
    });
    expect(result.wire.content?.toString()).toContain('name="a\\"b\\\\c"');
  });

  it.each([
    { label: "field name", entry: { key: "bad\r\nname", type: "text" as const, value: "1" } },
    { label: "filename", entry: { key: "file", type: "file" as const, src: "bad\nname.txt" } },
    {
      label: "content type",
      entry: { key: "file", type: "file" as const, src: "receipt.pdf", contentType: "text/plain\r\nX-Bad: yes" },
    },
  ])("givenControlCharacterIn$label_whenBuild_thenRejected", ({ entry }) => {
    expect(() =>
      buildBody({ body: { type: "formdata", formdata: [entry] }, store: store(), files: files(), boundary: BOUNDARY }),
    ).toThrow(/control character/);
  });

  it("givenFormDataAllEntriesDisabled_whenBuild_thenNoBody", () => {
    const result = buildBody({
      body: { type: "formdata", formdata: [{ key: "skip", type: "text", value: "{{missing}}", disabled: true }] },
      store: store(),
      files: files(),
    });
    expect(result.wire).toEqual({ content: undefined, contentType: undefined });
  });

  it("givenFileBody_whenBuild_thenRawBytesAndTypeFromExtension", () => {
    const result = buildBody({ body: { type: "file", file: { src: "receipt.pdf" } }, store: store(), files: files() });
    expect(result.wire).toEqual({ content: FILE_BYTES, contentType: "application/pdf" });
  });

  it("givenFileBodyUnknownExtension_whenBuild_thenOctetStream", () => {
    const result = buildBody({ body: { type: "file", file: { src: "data.bin" } }, store: store(), files: files() });
    expect(result.wire.contentType).toBe("application/octet-stream");
  });

  it("givenGraphqlBody_whenBuild_thenQueryAndVariablesJson", () => {
    const result = buildBody({
      body: { type: "graphql", graphql: { query: "query Q { thing }", variables: '{"id":7}' } },
      store: store(),
      files: files(),
    });
    expect(result.wire).toEqual({
      content: '{"query":"query Q { thing }","variables":{"id":7}}',
      contentType: "application/json",
    });
  });

  it("givenGraphqlBodyWithInvalidVariables_whenBuild_thenThrowsCliError", () => {
    expect(() =>
      buildBody({
        body: { type: "graphql", graphql: { query: "query Q", variables: "{" } },
        store: store(),
        files: files(),
        requestLabel: "Admin Query",
      }),
    ).toThrow(CliError);
    expect(() =>
      buildBody({
        body: { type: "graphql", graphql: { query: "query Q", variables: "{" } },
        store: store(),
        files: files(),
        requestLabel: "Admin Query",
      }),
    ).toThrow(/Admin Query/);
  });

  it("givenUnknownBodyType_whenBuild_thenContentSentWithWarning", () => {
    const result = buildBody({ body: { type: "custom", content: "bytes" }, store: store(), files: files() });
    expect(result.wire).toEqual({ content: "bytes", contentType: undefined });
    expect(result.warnings[0]).toContain('unknown body type "custom"');
  });

  it("givenRawBody_whenBuild_thenNoUnknownTypeWarning", () => {
    const result = buildBody({ body: { type: "raw", content: "bytes" }, store: store(), files: files() });
    expect(result.wire).toEqual({ content: "bytes", contentType: undefined });
    expect(result.warnings).toEqual([]);
  });

  it("givenInterpolatedFileSrc_whenBuild_thenTokenResolvedBeforeRead", () => {
    let readSrc = "";
    buildBody({
      body: { type: "file", file: { src: "{{file}}" } },
      store: store(),
      files: files({ read: (src) => ((readSrc = src), FILE_BYTES) }),
    });
    expect(readSrc).toBe("receipt.pdf");
  });
});
