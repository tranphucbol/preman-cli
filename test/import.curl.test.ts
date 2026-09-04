import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EXIT, PremanError, planImport } from "@preman/core";
import { FIXTURES_DIR, FIXTURE_WS } from "./helpers.js";

/**
 * Planning is pure, so every case here reads a command and asserts the document it would write.
 * The commands that came out of a real *Copy as cURL* live in `test/fixtures/curl/`, sanitised;
 * everything smaller is inline, because a one-flag case is easier to read beside its assertion.
 */

const CURL_DIR = join(FIXTURES_DIR, "curl");

function fixture(name: string): string {
  return readFileSync(join(CURL_DIR, `${name}.txt`), "utf8");
}

function plan(text: string) {
  return planImport({ root: FIXTURE_WS, text });
}

function document(text: string): Record<string, unknown> {
  return parse(plan(text).contents) as Record<string, unknown>;
}

function flagsDropped(text: string): string[] {
  return plan(text).dropped.map((entry) => entry.flag);
}

describe("planImport, curl", () => {
  it("givenAChromeCopyAsCurl_whenPlanned_thenEveryHeaderSurvives", () => {
    const planned = plan(fixture("chrome-mac"));

    expect(planned.format).toBe("curl");
    expect(planned.kind).toBe("http-request");
    expect(planned.name).toBe("orders");
    expect(parse(planned.contents)).toEqual({
      $kind: "http-request",
      name: "orders",
      method: "POST",
      url: "https://api.example.test/v1/orders?page=2&sort=desc",
      headers: [
        { key: "accept", value: "application/json" },
        { key: "accept-language", value: "en-GB,en;q=0.9" },
        { key: "content-type", value: "application/json" },
        { key: "x-note", value: "it's fine" },
        { key: "authorization", value: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" },
      ],
      body: { type: "raw", content: '{"item":"widget","qty":2}' },
    });
  });

  it("givenAChromeWindowsCopyAsCurl_whenPlanned_thenItMatchesTheMacForm", () => {
    expect(plan(fixture("chrome-windows")).contents).toBe(plan(fixture("chrome-mac")).contents);
  });

  it("givenDataWithNoMethod_whenPlanned_thenTheMethodIsPost", () => {
    expect(document("curl https://api.example.test/v1/orders -d 'a=1&b=2'")).toMatchObject({
      method: "POST",
      body: { type: "raw", content: "a=1&b=2" },
    });
    expect(document("curl https://api.example.test/v1/orders")).toMatchObject({ method: "GET" });
    expect(document("curl -I https://api.example.test/v1/orders")).toMatchObject({ method: "HEAD" });
  });

  it("givenAMultipartCommand_whenPlanned_thenFormdataCarriesTheFileEntry", () => {
    expect(document(fixture("multipart"))).toMatchObject({
      method: "POST",
      body: {
        type: "formdata",
        formdata: [
          { key: "title", type: "text", value: "Q3 report" },
          { key: "document", type: "file", src: "/tmp/report.pdf", contentType: "application/pdf" },
        ],
      },
    });
  });

  it("givenUserFlag_whenPlanned_thenAuthIsBasic", () => {
    expect(document("curl -u alice:s3cret https://api.example.test/v1/orders")).toMatchObject({
      auth: { type: "basic", credentials: { username: "alice", password: "s3cret" } },
    });
  });

  it("givenGetWithDataUrlencode_whenPlanned_thenThePairsBecomeQueryParams", () => {
    const shaped = document("curl -G https://api.example.test/search --data-urlencode 'q=red shoes' -d 'page=2'");

    expect(shaped).toMatchObject({
      method: "GET",
      url: "https://api.example.test/search",
      queryParams: [
        { key: "page", value: "2" },
        { key: "q", value: "red shoes" },
      ],
    });
    expect(shaped.body).toBeUndefined();
  });

  it("givenDataUrlencodeWithoutGet_whenPlanned_thenTheBodyIsUrlencoded", () => {
    expect(document("curl https://api.example.test/login --data-urlencode 'user=a b'")).toMatchObject({
      method: "POST",
      body: { type: "urlencoded", urlencoded: [{ key: "user", value: "a b" }] },
    });
  });

  it("givenAQueryStringInTheUrl_whenPlanned_thenItStaysInTheUrl", () => {
    // Decision 10: `mergeQuery` skips any key the URL already carries, so splitting these out
    // into `queryParams` would move them into a field the runner then ignores.
    const shaped = document("curl 'https://api.example.test/search?q=red+shoes&page=2'");

    expect(shaped.url).toBe("https://api.example.test/search?q=red+shoes&page=2");
    expect(shaped.queryParams).toBeUndefined();
  });

  it("givenInsecureFlag_whenPlanned_thenItIsDroppedAndNamed", () => {
    const planned = plan("curl -k --max-time 30 -L --compressed -o out.json https://api.example.test/v1/orders");

    expect(planned.dropped.map((entry) => entry.flag)).toEqual(["-k", "--max-time", "-L", "--compressed", "-o"]);
    expect(planned.dropped[0]?.reason).toContain("--ssl-");
    expect(planned.warnings).toEqual([]);
  });

  it("givenAnUnknownFlag_whenPlanned_thenItWarnsAndStillImports", () => {
    const planned = plan("curl --parallel-max 4 https://api.example.test/v1/orders");

    expect(planned.warnings.join("\n")).toContain("--parallel-max");
    expect(parse(planned.contents)).toMatchObject({ url: "https://api.example.test/v1/orders" });
  });

  it("givenTwoUrls_whenPlanned_thenItIsRefused", () => {
    try {
      plan("curl https://api.example.test/a https://api.example.test/b");
      expect.unreachable("two URLs must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(PremanError);
      expect((error as PremanError).exitCode).toBe(EXIT.CLI);
      expect((error as PremanError).message).toContain("more than one URL");
    }
  });

  it("givenTwoCommands_whenPlanned_thenItIsRefusedNamingTheCount", () => {
    expect(() => plan("curl https://api.example.test/a && curl https://api.example.test/b")).toThrowError(
      /holds 2 commands/,
    );
  });

  it("givenABearerHeader_whenPlanned_thenItIsWrittenVerbatim", () => {
    // Decision 12: no `{{token}}` is invented, and no environment variable is created.
    const shaped = document("curl -H 'authorization: Bearer sk-live-42' https://api.example.test/v1/orders");

    expect(shaped).toMatchObject({ headers: [{ key: "authorization", value: "Bearer sk-live-42" }] });
    expect(
      planImport({ root: FIXTURE_WS, text: "curl -H 'authorization: Bearer sk-live-42' https://x.test/y" }).contents,
    ).not.toContain("{{");
  });

  it("givenNoScheme_whenPlanned_thenHttpsIsAssumed", () => {
    expect(document("curl api.example.test/v1/orders")).toMatchObject({
      url: "https://api.example.test/v1/orders",
    });
  });

  it("givenAPathlessUrl_whenPlanned_thenTheHostNamesTheRequest", () => {
    expect(plan("curl https://api.example.test/").name).toBe("api.example.test");
  });

  it("givenAPipeline_whenPlanned_thenTheTailIsNamedAndIgnored", () => {
    const planned = plan("curl https://api.example.test/v1/orders | jq .");

    expect(planned.warnings.join("\n")).toContain("jq");
    expect(parse(planned.contents)).toMatchObject({ url: "https://api.example.test/v1/orders" });
  });

  it("givenProse_whenPlanned_thenItSaysWhichFormatsItKnows", () => {
    try {
      plan("please call the orders endpoint for me");
      expect.unreachable("prose is not a command");
    } catch (error) {
      expect((error as PremanError).details.join("\n")).toContain("--format curl");
    }
  });

  it("givenAHeaderRemoval_whenPlanned_thenItIsDroppedByName", () => {
    expect(flagsDropped("curl -H 'accept:' https://api.example.test/v1/orders")).toEqual(["-H accept:"]);
  });
});
