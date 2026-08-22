import { describe, expect, it } from "vitest";
import { LiveBody, Url } from "@preman/core/scripts/live-request.js";

describe("Url", () => {
  it("givenAbsoluteUrl_whenParse_thenPartsSplit", () => {
    const url = Url.parse("https://api.example.com:8443/v1/orders?a=1#result");

    expect(url.protocol).toBe("https");
    expect(url.host).toEqual(["api", "example", "com"]);
    expect(url.port).toBe("8443");
    expect(url.path).toEqual(["v1", "orders"]);
    expect(url.query.toJSON()).toEqual([{ key: "a", value: "1" }]);
    expect(url.hash).toBe("result");
  });

  it("givenSchemelessUrl_whenParse_thenHttpAssumed", () => {
    expect(Url.parse("api.example.com/x").toString()).toBe("http://api.example.com/x");
  });

  it("givenIpv6Url_whenParse_thenHostWithoutBracketsAndToStringRestoresThem", () => {
    const url = Url.parse("http://[::1]:8080/x");
    expect(url.host).toEqual(["::1"]);
    expect(url.port).toBe("8080");
    expect(url.toString()).toBe("http://[::1]:8080/x");
  });

  it("givenPercentEncodedPath_whenToString_thenNotDoubleEncoded", () => {
    expect(Url.parse("http://host/a%2Fb").toString()).toBe("http://host/a%2Fb");
  });

  it("givenGrpcsUrl_whenToString_thenNoTrailingSlash", () => {
    expect(Url.parse("grpcs://host:443").toString()).toBe("grpcs://host:443");
  });

  it("givenUnresolvedToken_whenParse_thenLeftVerbatim", () => {
    expect(Url.parse("http://{{host}}/v1/{{path}}?id={{id}}").toString()).toBe("http://{{host}}/v1/{{path}}?id={{id}}");
  });

  it("givenParsedUrl_whenToString_thenRoundTrips", () => {
    const raw = "https://api.example.com:8443/v1/orders?a=1#result";
    expect(Url.parse(raw).toString()).toBe(raw);
  });

  it("givenUntouchedQuerySyntax_whenToString_thenAuthoredBytesArePreserved", () => {
    const raw = "http://host/path?flag&q=a+b";
    expect(Url.parse(raw).toString()).toBe(raw);
  });

  it("givenUntouchedPathSyntax_whenToString_thenAuthoredBytesArePreserved", () => {
    const raw = "http://host/a:b+a;b=c";
    expect(Url.parse(raw).toString()).toBe(raw);
  });

  it("givenPathSegmentsWithDelimiters_whenToString_thenEachSegmentIsEncoded", () => {
    const url = Url.parse("http://host");
    url.path = ["a/b", "what?", "hash#"];
    expect(url.toString()).toBe("http://host/a%2Fb/what%3F/hash%23");
  });
});

describe("LiveBody", () => {
  it("givenRawJsonBody_whenToWire_thenVerbatimWithJsonContentType", () => {
    expect(new LiveBody("json", '{"a": 1}').toWire()).toEqual({
      body: '{"a": 1}',
      contentType: "application/json",
    });
  });

  it("givenEmptyBody_whenToWire_thenUndefinedAndNoContentType", () => {
    expect(new LiveBody(undefined, "").toWire()).toEqual({ body: undefined, contentType: undefined });
  });

  it("givenUrlencodedBody_whenFieldMutated_thenWireUsesMutation", () => {
    const body = new LiveBody("urlencoded", "", [{ key: "sig", value: "old" }]);
    body.urlencoded.upsert("sig", "a+b");
    expect(body.toWire()).toEqual({ body: "sig=a%2Bb", contentType: "application/x-www-form-urlencoded" });
  });
});
