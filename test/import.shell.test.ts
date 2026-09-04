import { describe, expect, it } from "vitest";
import { EXIT, PremanError } from "@preman/core";
import { splitWords } from "@preman/core/import/shell.js";

/**
 * The splitter knows nothing about curl, so every case here is shell grammar alone.
 * `import.curl.test.ts` asserts what the words then mean.
 */

describe("splitWords", () => {
  it("givenAnsiCQuoting_whenSplit_thenNewlinesAreLiteral", () => {
    expect(splitWords("curl -H $'x-note: first\\nsecond\\ttabbed'")).toEqual([
      "curl",
      "-H",
      "x-note: first\nsecond\ttabbed",
    ]);
  });

  it("givenAnsiCHexEscape_whenSplit_thenTheByteIsDecoded", () => {
    expect(splitWords("$'a\\x41b'")).toEqual(["aAb"]);
  });

  it("givenAnsiCEscapedQuote_whenSplit_thenTheApostropheSurvives", () => {
    expect(splitWords("-H $'x-note: it\\'s fine'")).toEqual(["-H", "x-note: it's fine"]);
  });

  it("givenABackslashNewline_whenSplit_thenTheCommandIsOneLine", () => {
    expect(splitWords("curl 'https://x/y' \\\n  -H 'a: b' \\\n  --data-raw 'hi'")).toEqual([
      "curl",
      "https://x/y",
      "-H",
      "a: b",
      "--data-raw",
      "hi",
    ]);
  });

  it("givenACaretNewline_whenSplit_thenTheWindowsFormIsOneLine", () => {
    expect(splitWords('curl "https://x/y" ^\r\n  -H "a: b" ^\r\n  --data-raw "{\\"q\\":1}"')).toEqual([
      "curl",
      "https://x/y",
      "-H",
      "a: b",
      "--data-raw",
      '{"q":1}',
    ]);
  });

  it("givenClusteredShortFlags_whenSplit_thenTheyStayOneWord", () => {
    expect(splitWords("curl -sSL https://x")).toEqual(["curl", "-sSL", "https://x"]);
  });

  it("givenAnEmptyQuotedWord_whenSplit_thenItSurvives", () => {
    expect(splitWords("curl -d '' https://x")).toEqual(["curl", "-d", "", "https://x"]);
  });

  it("givenAdjacentQuotedRuns_whenSplit_thenTheyJoinIntoOneWord", () => {
    expect(splitWords(`--data-raw 'a'"b"c`)).toEqual(["--data-raw", "abc"]);
  });

  it("givenABackslashInsideDoubleQuotes_whenSplit_thenAWindowsPathSurvives", () => {
    expect(splitWords('--cert "C:\\Users\\me\\cert.pem"')).toEqual(["--cert", "C:\\Users\\me\\cert.pem"]);
  });

  it("givenACommandSubstitution_whenSplit_thenItIsRefused", () => {
    expect(() => splitWords('curl -H "authorization: Bearer $(cat token)" https://x')).toThrowError(PremanError);
    try {
      splitWords("curl -H 'a: b' https://x/$(id)");
      expect.unreachable("a command substitution must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(PremanError);
      expect((error as PremanError).exitCode).toBe(EXIT.CLI);
      expect((error as PremanError).message).toContain("$(");
    }
  });

  it("givenABacktick_whenSplit_thenItIsRefused", () => {
    expect(() => splitWords("curl https://x/`hostname`")).toThrowError(/`/);
  });

  it("givenAnUnterminatedQuote_whenSplit_thenItIsRefused", () => {
    try {
      splitWords("curl -H 'a: b https://x");
      expect.unreachable("an unterminated quote must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(PremanError);
      expect((error as PremanError).exitCode).toBe(EXIT.CLI);
      expect((error as PremanError).message).toContain("unterminated");
    }
    expect(() => splitWords('curl --data-raw "{\\"q\\":1}')).toThrowError(/unterminated/);
  });
});
