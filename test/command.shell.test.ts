import { describe, expect, it } from "vitest";
import { copySelection } from "@preman/core";
import { quoteWords } from "@preman/core/command/shell.js";
import { splitWords } from "@preman/core/import/shell.js";
import { FIXTURE_HTTP_WS, FIXTURE_WS } from "./helpers.js";

/**
 * The joiner knows nothing about curl, so every case here is shell grammar alone.
 * `command.curl.test.ts` asserts what the words then mean.
 */

const NO_CERTS = {};
const COPY_DEFAULTS = {
  env: null,
  url: undefined,
  tls: undefined,
  tlsCerts: NO_CERTS,
  workingDir: undefined,
  insecureFileRead: false,
};

/** Enough for every fixture request to resolve a host without an environment file. */
const HTTP_VARS = { http_url: "http://127.0.0.1:65500", token: "jwt-123" };
const GRPC_VARS = { grpc_url: "127.0.0.1:50051", trans_id: "t-1", greeting: "hello", mode: "SUCCEED" };

/** `Legacy Http` is a websocket request; nothing plans it, in either direction. */
const UNPLANNABLE = new Set(["payment/Legacy Http"]);

const HTTP_SELECTORS = [
  "admin/Login",
  "admin/Profile",
  "admin/Denied",
  "admin/Echo Get Body",
  "admin/Squeezed",
  "admin/Round And Round",
  "admin/Side Login",
  "admin/Callback Login",
  "admin/Signed Form",
];
const GRPC_SELECTORS = ["payment/Ping", "payment/Echo", "payment/Descriptor Only", "payment/nested/Deep Echo"];

describe("quoteWords", () => {
  it("givenAPlainWord_whenQuoted_thenItIsBare", () => {
    expect(quoteWords(["curl", "-X", "POST", "https://api.example.com/orders"])).toBe(
      "curl -X POST https://api.example.com/orders",
    );
  });

  it("givenAWordWithASpace_whenQuoted_thenItIsSingleQuoted", () => {
    expect(quoteWords(["-H", "content-type: application/json"])).toBe("-H 'content-type: application/json'");
  });

  it("givenAWordWithASingleQuote_whenQuoted_thenTheQuoteIsEscaped", () => {
    expect(quoteWords(["--data-raw", `{"note":"it's fine"}`])).toBe(`--data-raw '{"note":"it'\\''s fine"}'`);
    expect(splitWords(quoteWords([`it's`]))).toEqual([`it's`]);
  });

  it("givenAnEmptyWord_whenQuoted_thenItIsTwoQuotes", () => {
    expect(quoteWords(["-H", ""])).toBe("-H ''");
    expect(splitWords(quoteWords(["-H", ""]))).toEqual(["-H", ""]);
  });

  it("givenAWordWithANewline_whenQuoted_thenItSurvivesSplitWords", () => {
    const words = ["--data-raw", "first\nsecond\ttabbed", "-H", "x: $(whoami)`id`"];
    expect(splitWords(quoteWords(words))).toEqual(words);
  });

  it("givenEveryFixtureRequestsWords_whenQuotedThenSplit_thenTheArgvIsUnchanged", async () => {
    const cases = [
      ...HTTP_SELECTORS.map((selector) => ({ dir: FIXTURE_HTTP_WS, selector, vars: HTTP_VARS })),
      ...GRPC_SELECTORS.map((selector) => ({ dir: FIXTURE_WS, selector, vars: GRPC_VARS })),
    ];

    for (const { dir, selector, vars } of cases) {
      if (UNPLANNABLE.has(selector)) continue;
      const { plan } = await copySelection({ ...COPY_DEFAULTS, dir, selector, certBaseDir: dir, vars });
      expect(splitWords(plan.command), selector).toEqual([...plan.words]);
    }
  });
});
