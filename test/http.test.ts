import { describe, expect, it } from "vitest";

import { CliError } from "../src/errors.js";
import { applyAuth } from "../src/http/auth.js";
import { readRequestBody, renderBody } from "../src/http/body.js";
import { CookieJar } from "../src/http/cookies.js";
import {
  dropEmptyValues,
  findHeader,
  normalizeKeyValues,
  setHeaderIfAbsent,
  toOutgoingHeaders,
  type KeyValue,
} from "../src/http/headers.js";
import { mergeQuery } from "../src/http/query.js";
import { buildHttpRequest, buildLiveHttpRequest, finaliseHttpRequest } from "../src/http/request.js";
import { pathPortion, resolveHttpUrl } from "../src/http/target.js";
import { VariableStore } from "../src/vars/store.js";
import type { HttpRequest } from "../src/workspace/schemas.js";
import type { FileReader } from "../src/workspace/files.js";

function pairs(headers: readonly KeyValue[]): Record<string, string> {
  return Object.fromEntries(headers.map((header) => [header.key, header.value]));
}

describe("normalizeKeyValues", () => {
  it("givenAMap_whenNormalized_thenEveryEntryIsKept", () => {
    expect(normalizeKeyValues({ "X-Trace": "abc", page: 2, exact: true }, "headers")).toEqual([
      { key: "X-Trace", value: "abc" },
      { key: "page", value: "2" },
      { key: "exact", value: "true" },
    ]);
  });

  it("givenAnArray_whenNormalized_thenDisabledEntriesAreDropped", () => {
    const source = [
      { key: "transaction_id", value: "1", disabled: true },
      { key: "start_time", value: "2" },
      { key: "no_value" },
    ];
    expect(normalizeKeyValues(source, "query params")).toEqual([
      { key: "start_time", value: "2" },
      { key: "no_value", value: "" },
    ]);
  });

  it("givenANullValue_whenNormalized_thenItBecomesAnEmptyString", () => {
    expect(normalizeKeyValues({ authorization: null }, "headers")).toEqual([{ key: "authorization", value: "" }]);
  });

  it("givenAnUnreadableSource_whenNormalized_thenCliErrorExplainsBothShapes", () => {
    expect(() => normalizeKeyValues("nope" as never, "headers")).toThrow(CliError);
    try {
      normalizeKeyValues(7 as never, "headers");
    } catch (cause) {
      const error = cause as CliError;
      expect(error.message).toContain("could not read headers");
      expect(error.details.join(" ")).toContain("list of {key, value}");
    }
  });

  it("givenUndefined_whenNormalized_thenTheListIsEmpty", () => {
    expect(normalizeKeyValues(undefined, "headers")).toEqual([]);
  });
});

describe("header helpers", () => {
  const headers: KeyValue[] = [
    { key: "Content-Type", value: "application/json" },
    { key: "authorization", value: "" },
  ];

  it("givenMixedCase_whenLookedUp_thenTheMatchIsCaseInsensitive", () => {
    expect(findHeader(headers, "content-type")?.value).toBe("application/json");
    expect(findHeader(headers, "missing")).toBeUndefined();
  });

  it("givenABlankValue_whenDropped_thenTheHeaderIsUnset", () => {
    expect(dropEmptyValues(headers)).toEqual([{ key: "Content-Type", value: "application/json" }]);
  });

  it("givenAnExistingHeader_whenSetIfAbsent_thenTheAuthorsValueWins", () => {
    const list: KeyValue[] = [{ key: "Content-Type", value: "text/plain" }];
    setHeaderIfAbsent(list, "content-type", "application/json");
    setHeaderIfAbsent(list, "accept", "application/json");
    expect(pairs(list)).toEqual({ "Content-Type": "text/plain", accept: "application/json" });
  });

  it("givenRepeatedKeys_whenSentOut_thenTheyBecomeAnArray", () => {
    const list: KeyValue[] = [
      { key: "x-tag", value: "a" },
      { key: "X-Tag", value: "b" },
      { key: "accept", value: "*/*" },
    ];
    expect(toOutgoingHeaders(list)).toEqual({ "x-tag": ["a", "b"], accept: "*/*" });
  });
});

describe("mergeQuery", () => {
  it("givenAParamAlreadyInTheUrl_whenMerged_thenItIsNotSentTwice", () => {
    const url = new URL("http://host/api?error_code=20&exact=true");
    const skipped = mergeQuery(url, [
      { key: "error_code", value: "20" },
      { key: "exact", value: "true" },
      { key: "page", value: "2" },
    ]);
    expect(skipped).toEqual(["error_code", "exact"]);
    expect(url.search).toBe("?error_code=20&exact=true&page=2");
  });

  it("givenNoParams_whenMerged_thenTheUrlIsUntouched", () => {
    const url = new URL("http://host/api?a=1");
    expect(mergeQuery(url, [])).toEqual([]);
    expect(url.search).toBe("?a=1");
  });
});

describe("resolveHttpUrl", () => {
  it("givenAnAbsoluteUrl_whenResolved_thenTheOriginComesFromTheRequest", () => {
    const resolved = resolveHttpUrl({ rawUrl: "https://api.example.com/v1/users?a=1" });
    expect(resolved.url.href).toBe("https://api.example.com/v1/users?a=1");
    expect(resolved.target).toEqual({ origin: "https://api.example.com", tls: true, source: "request url" });
  });

  it("givenNoScheme_whenResolved_thenHttpIsAssumed", () => {
    expect(resolveHttpUrl({ rawUrl: "localhost:8080/health" }).url.href).toBe("http://localhost:8080/health");
  });

  it("givenAnUnresolvedBaseVariable_whenResolved_thenTheErrorNamesTheWayOut", () => {
    try {
      resolveHttpUrl({ rawUrl: "/api/v1/login" });
      throw new Error("expected a CliError");
    } catch (cause) {
      const error = cause as CliError;
      expect(error.message).toContain("could not determine an HTTP origin");
      expect(error.details.join(" ")).toContain("--url <origin>");
    }
  });

  it("givenAnOverride_whenResolved_thenOnlyTheOriginIsReplaced", () => {
    const resolved = resolveHttpUrl({ rawUrl: "{{admin_http_url}}/api/v1/login?a=1", override: "127.0.0.1:3000" });
    expect(resolved.url.href).toBe("http://127.0.0.1:3000/api/v1/login?a=1");
    expect(resolved.target.source).toBe("--url");
  });

  it("givenAnOverrideWithAPath_whenResolved_thenThePathIsIgnoredWithAWarning", () => {
    const resolved = resolveHttpUrl({ rawUrl: "http://old/api/v1/login", override: "http://new/ignored" });
    expect(resolved.url.href).toBe("http://new/api/v1/login");
    expect(resolved.warnings.join(" ")).toContain("ignored");
  });

  it("givenATlsOverride_whenResolved_thenTheSchemeIsForced", () => {
    expect(resolveHttpUrl({ rawUrl: "http://host/x", tlsOverride: true }).url.protocol).toBe("https:");
    expect(resolveHttpUrl({ rawUrl: "https://host/x", tlsOverride: false }).url.protocol).toBe("http:");
  });

  it("givenANonHttpScheme_whenResolved_thenItIsRejected", () => {
    expect(() => resolveHttpUrl({ rawUrl: "ws://host/socket" })).toThrow(CliError);
  });

  it("givenAnyUrl_whenOnlyThePathIsWanted_thenTheOriginIsStripped", () => {
    expect(pathPortion("https://host:8443/api/v1/login?a=1")).toBe("/api/v1/login?a=1");
    expect(pathPortion("{{base}}/api")).toBe("/api");
    expect(pathPortion("http://host")).toBe("/");
  });
});

describe("applyAuth", () => {
  const store = () => new VariableStore({ environment: { jwt_token: "tok-1", user: "admin", pass: "s3cret" } });

  it("givenBearerAuth_whenApplied_thenTheHeaderCarriesTheToken", () => {
    const headers: KeyValue[] = [];
    const warnings = applyAuth({
      auth: { type: "bearer", credentials: { token: "{{jwt_token}}" } },
      headers,
      url: new URL("http://host/x"),
      store: store(),
    });
    expect(pairs(headers)).toEqual({ Authorization: "Bearer tok-1" });
    expect(warnings).toEqual([]);
  });

  it("givenBasicAuth_whenApplied_thenTheCredentialsAreBase64", () => {
    const headers: KeyValue[] = [];
    applyAuth({
      auth: { type: "basic", credentials: { username: "{{user}}", password: "{{pass}}" } },
      headers,
      url: new URL("http://host/x"),
      store: store(),
    });
    expect(findHeader(headers, "authorization")?.value).toBe(`Basic ${Buffer.from("admin:s3cret").toString("base64")}`);
  });

  it("givenApiKeyInQuery_whenApplied_thenTheUrlCarriesIt", () => {
    const url = new URL("http://host/x");
    applyAuth({
      auth: { type: "apikey", credentials: { key: "api_key", value: "{{jwt_token}}", in: "query" } },
      headers: [],
      url,
      store: store(),
    });
    expect(url.search).toBe("?api_key=tok-1");
  });

  it("givenAnExplicitAuthorizationHeader_whenAuthBlockPresent_thenTheHeaderWinsWithAWarning", () => {
    const headers: KeyValue[] = [{ key: "authorization", value: "Bearer mine" }];
    const warnings = applyAuth({
      auth: { type: "bearer", credentials: { token: "{{jwt_token}}" } },
      headers,
      url: new URL("http://host/x"),
      store: store(),
    });
    expect(pairs(headers)).toEqual({ authorization: "Bearer mine" });
    expect(warnings.join(" ")).toContain("overrides the bearer auth block");
  });

  it("givenNoauthOrNothing_whenApplied_thenNoHeaderIsAdded", () => {
    const headers: KeyValue[] = [];
    expect(applyAuth({ auth: { type: "noauth" }, headers, url: new URL("http://host/x"), store: store() })).toEqual([]);
    expect(applyAuth({ auth: undefined, headers, url: new URL("http://host/x"), store: store() })).toEqual([]);
    expect(headers).toEqual([]);
  });

  it("givenAnEmptyBearerToken_whenApplied_thenItWarnsInsteadOfSendingBearer", () => {
    const headers: KeyValue[] = [];
    const warnings = applyAuth({
      auth: { type: "bearer", credentials: { token: "" } },
      headers,
      url: new URL("http://host/x"),
      store: store(),
    });
    expect(headers).toEqual([]);
    expect(warnings.join(" ")).toContain("bearer token is empty");
  });

  it("givenAnUnknownAuthType_whenApplied_thenTheErrorListsTheSupportedOnes", () => {
    try {
      applyAuth({ auth: { type: "oauth2" }, headers: [], url: new URL("http://host/x"), store: store() });
      throw new Error("expected a CliError");
    } catch (cause) {
      const error = cause as CliError;
      expect(error.message).toContain('auth type "oauth2" is not supported');
      expect(error.details.join(" ")).toContain("noauth, bearer, basic, apikey");
    }
  });
});

describe("CookieJar", () => {
  it("givenADeleteThenSetPair_whenStored_thenTheLiveValueIsKept", () => {
    // The admin backend clears the cookie at a legacy path before setting the real one.
    const jar = new CookieJar();
    jar.storeFrom(new URL("http://host/api/v1/login"), [
      "admin_csrf_token=; Path=/legacy; Max-Age=0",
      "admin_csrf_token=real-value; Path=/api/v1; HttpOnly",
    ]);
    expect(jar.get("admin_csrf_token")).toBe("real-value");
    expect(jar.headerFor(new URL("http://host/api/v1/auth/refresh"))).toBe("admin_csrf_token=real-value");
  });

  it("givenAPathScopedCookie_whenAnotherPathIsRequested_thenItIsNotSent", () => {
    const jar = new CookieJar();
    jar.storeFrom(new URL("http://host/api/v1/login"), ["sid=abc; Path=/api/v1"]);
    expect(jar.headerFor(new URL("http://host/other"))).toBeUndefined();
    expect(jar.headerFor(new URL("http://host/api/v1/users"))).toBe("sid=abc");
  });

  it("givenNoExplicitPath_whenStored_thenTheDefaultIsTheDirectory", () => {
    const jar = new CookieJar();
    jar.storeFrom(new URL("http://host/api/v1/login"), ["sid=abc"]);
    expect(jar.headerFor(new URL("http://host/api/v1/users"))).toBe("sid=abc");
    expect(jar.headerFor(new URL("http://host/"))).toBeUndefined();
  });

  it("givenCookiesAtDifferentPaths_whenSent_thenTheLongerPathComesFirst", () => {
    const jar = new CookieJar();
    jar.storeFrom(new URL("http://host/"), ["a=root; Path=/"]);
    jar.storeFrom(new URL("http://host/api/v1/x"), ["b=deep; Path=/api/v1"]);
    expect(jar.headerFor(new URL("http://host/api/v1/x"))).toBe("b=deep; a=root");
  });

  it("givenAnotherHost_whenRequested_thenHostOnlyCookiesStayHome", () => {
    const jar = new CookieJar();
    jar.storeFrom(new URL("http://host/x"), ["sid=abc; Path=/"]);
    expect(jar.headerFor(new URL("http://elsewhere/x"))).toBeUndefined();
  });

  it("givenAnExpiredCookie_whenRead_thenItIsGone", () => {
    const jar = new CookieJar();
    jar.storeFrom(new URL("http://host/"), ["sid=abc; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"]);
    expect(jar.has("sid")).toBe(false);
    expect(jar.toObject()).toEqual({});
  });

  it("givenSeveralCookies_whenExposedToScripts_thenHttpOnlyIsStillVisible", () => {
    const jar = new CookieJar();
    jar.storeFrom(new URL("http://host/"), ["sid=abc; Path=/; HttpOnly", "theme=dark; Path=/"]);
    expect(jar.toObject()).toEqual({ sid: "abc", theme: "dark" });
    expect(jar.has("sid")).toBe(true);
    expect(jar.get("nope")).toBeUndefined();
  });
});

describe("request bodies", () => {
  const store = () => new VariableStore({ environment: { sig: "a+b/c=", tenant: "acme" } });
  const files: FileReader = {
    resolve: () => "/work/receipt.txt",
    read: () => Buffer.from("receipt"),
  };

  function httpRequest(body: HttpRequest["body"]): HttpRequest {
    return { $kind: "http-request", url: "http://host/pay", method: "POST", body };
  }

  it("givenATextBody_whenRead_thenItIsKeptVerbatim", () => {
    const parsed = readRequestBody(httpRequest({ type: "json", content: '{"a": 1}' }));
    expect(parsed).toEqual({ mode: "json", raw: '{"a": 1}', urlencoded: undefined });
    expect(renderBody(parsed, store())).toBe('{"a": 1}');
  });

  it("givenAUrlencodedMap_whenRead_thenTheFieldsKeepTheirOrder", () => {
    const parsed = readRequestBody(httpRequest({ type: "urlencoded", content: { clientid: "11", sig: "{{sig}}" } }));
    expect(parsed.urlencoded).toEqual([
      { key: "clientid", value: "11" },
      { key: "sig", value: "{{sig}}" },
    ]);
    expect(parsed.raw).toBe("");
  });

  it("givenAUrlencodedList_whenRead_thenDisabledFieldsRemainInspectableButAreNotRendered", () => {
    const parsed = readRequestBody(
      httpRequest({
        type: "urlencoded",
        content: [
          { key: "keep", value: "1" },
          { key: "skip", value: "2", disabled: true },
        ],
      }),
    );
    expect(parsed.urlencoded).toEqual([
      { key: "keep", value: "1" },
      { key: "skip", value: "2", disabled: true },
    ]);
    expect(renderBody(parsed, store())).toBe("keep=1");
  });

  it("givenAUrlencodedField_whenRendered_thenTheResolvedValueIsPercentEncoded", () => {
    const parsed = readRequestBody(httpRequest({ type: "urlencoded", content: { sig: "{{sig}}", to: "{{tenant}}" } }));
    expect(renderBody(parsed, store())).toBe("sig=a%2Bb%2Fc%3D&to=acme");
  });

  it("givenNoUrlencodedFields_whenRendered_thenThereIsNoBody", () => {
    expect(renderBody(readRequestBody(httpRequest({ type: "urlencoded", content: {} })), store())).toBeUndefined();
  });

  it("givenOnlyDisabledUrlencodedFields_whenRendered_thenThereIsNoBody", () => {
    const parsed = readRequestBody(
      httpRequest({ type: "urlencoded", content: [{ key: "skip", value: "{{missing}}", disabled: true }] }),
    );
    expect(renderBody(parsed, store())).toBeUndefined();
  });

  it("givenAStructuredBodyThatIsNotUrlencoded_whenRead_thenCliError", () => {
    expect(() => readRequestBody(httpRequest({ type: "json", content: { a: "1" } }))).toThrow(CliError);
    expect(() => readRequestBody(httpRequest({ type: "json", content: { a: "1" } }))).toThrow(/urlencoded/);
  });

  it("givenAUrlencodedBody_whenBuilt_thenTheFormContentTypeIsSet", () => {
    const built = buildHttpRequest({
      request: httpRequest({ type: "urlencoded", content: { sig: "{{sig}}" } }),
      auth: undefined,
      store: store(),
    });
    expect(built.body).toBe("sig=a%2Bb%2Fc%3D");
    expect(pairs(built.headers)["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("givenMultipartBody_whenBuildRequest_thenContentTypeCarriesBoundary", () => {
    const built = buildHttpRequest({
      request: httpRequest({ type: "formdata", formdata: [{ key: "note", type: "text", value: "one" }] }),
      auth: undefined,
      store: store(),
      files,
      boundary: "test-boundary",
    });
    expect(Buffer.isBuffer(built.body)).toBe(true);
    expect(pairs(built.headers)["content-type"]).toBe("multipart/form-data; boundary=test-boundary");
  });

  it("givenExplicitContentTypeWithFormData_whenBuildRequest_thenWarnsAboutBoundary", () => {
    const built = buildHttpRequest({
      request: {
        ...httpRequest({ type: "formdata", formdata: [{ key: "note", type: "text", value: "one" }] }),
        headers: { "Content-Type": "multipart/form-data; boundary=authored" },
      },
      auth: undefined,
      store: store(),
      files,
      boundary: "generated",
    });
    expect(pairs(built.headers)["Content-Type"]).toBe("multipart/form-data; boundary=authored");
    expect(built.warnings).toContain("explicit Content-Type overrides the generated multipart boundary");
  });

  it("givenRawBody_whenBuildRequest_thenItDoesNotWarnAboutAnUnknownType", () => {
    const built = buildHttpRequest({
      request: httpRequest({ type: "raw", content: "raw bytes" }),
      auth: undefined,
      store: store(),
    });
    expect(built.body).toBe("raw bytes");
    expect(built.warnings).toEqual([]);
  });

  it("givenBodyWithoutType_whenBuildRequest_thenItDoesNotWarnAboutAnUnknownType", () => {
    const built = buildHttpRequest({
      request: httpRequest({ content: "raw bytes" }),
      auth: undefined,
      store: store(),
    });
    expect(built.body).toBe("raw bytes");
    expect(built.warnings).toEqual([]);
  });

  it("givenScriptReplacingStructuredBody_whenFinalised_thenScriptBodyWins", () => {
    const live = buildLiveHttpRequest({
      request: httpRequest({ type: "file", file: { src: "receipt.txt" } }),
      auth: undefined,
      store: store(),
      files,
    });
    live.request.body.mode = "text";
    live.request.body.raw = "replacement";

    const built = finaliseHttpRequest(live.request, live.target, live.wireBody);
    expect(built.body).toBe("replacement");
    expect(pairs(built.headers)["content-type"]).toBe("text/plain");
  });

  it("givenDisabledAuthoredEntries_whenBuiltLive_thenScriptsSeeThemButTheWireDoesNot", () => {
    const live = buildLiveHttpRequest({
      request: {
        ...httpRequest({
          type: "urlencoded",
          content: [
            { key: "keep", value: "1" },
            { key: "skip-form", value: "2", disabled: true },
          ],
        }),
        headers: [
          { key: "X-Keep", value: "yes" },
          { key: "X-Skip", value: "no", disabled: true },
        ],
        queryParams: [
          { key: "keep", value: "yes" },
          { key: "skip-query", value: "no", disabled: true },
        ],
      },
      auth: undefined,
      store: store(),
    });

    expect(live.request.headers.toJSON()).toContainEqual({ key: "X-Skip", value: "no", disabled: true });
    expect(live.request.url.query.toJSON()).toContainEqual({ key: "skip-query", value: "no", disabled: true });
    expect(live.request.body.urlencoded.toJSON()).toContainEqual({ key: "skip-form", value: "2", disabled: true });

    const built = finaliseHttpRequest(live.request, live.target);
    expect(built.headers).toEqual([{ key: "X-Keep", value: "yes" }, { key: "content-type", value: "application/x-www-form-urlencoded" }]);
    expect(built.url.toString()).toBe("http://host/pay?keep=yes");
    expect(built.body).toBe("keep=1");
  });

  it("givenScriptRewrittenOrigin_whenFinalised_thenTargetMatchesTheFinalUrl", () => {
    const live = buildLiveHttpRequest({ request: httpRequest(undefined), auth: undefined, store: store() });
    live.request.url = "https://other.example:8443/pay";

    expect(finaliseHttpRequest(live.request, live.target).target).toEqual({
      origin: "https://other.example:8443",
      tls: true,
      source: "pre-request script",
    });
  });

  it("givenUrlOverrideSupersededByScript_whenFinalised_thenTargetNamesTheScript", () => {
    const live = buildLiveHttpRequest({
      request: httpRequest(undefined),
      auth: undefined,
      store: store(),
      urlOverride: "http://override.example",
    });
    live.request.url = "https://script.example/pay";

    expect(finaliseHttpRequest(live.request, live.target).target).toEqual({
      origin: "https://script.example",
      tls: true,
      source: "pre-request script",
    });
  });
});
