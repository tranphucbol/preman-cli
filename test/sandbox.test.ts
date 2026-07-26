import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { REQUEST_ORIGIN } from "../src/scripts/chain.js";
import { freezeRequest, LiveBody, LiveGrpcRequest, LiveHttpRequest, type LiveRequest } from "../src/scripts/live-request.js";
import { runScript, type GrpcScriptResponse, type ScriptResponseInfo } from "../src/scripts/sandbox.js";
import { VariableStore } from "../src/vars/store.js";

/** Verbatim `beforeInvoke` script from postman/collections/payment/Long Chau.request.yaml. */
const REAL_TRANS_ID_SCRIPT = `const date = new Date();
const prefix =
    (date.getFullYear() % 100) * 10000 +
    (date.getMonth() + 1) * 100 +
    date.getDate();
const id = Math.floor(Math.random() * 1000000000);
const trans_id = prefix * 1000000000 + id;
pm.environment.set("trans_id", trans_id);`;

interface ScriptRequestInfo {
  url: string;
  methodPath?: string;
  method?: string;
  body: string;
  bodyMode?: string;
  urlencoded?: Array<{ key: string; value: string }>;
}

function liveRequest(request: ScriptRequestInfo): LiveRequest {
  if (request.methodPath !== undefined) {
    return new LiveGrpcRequest({
      url: request.url,
      methodPath: request.methodPath,
      body: new LiveBody(undefined, request.body),
    });
  }
  return new LiveHttpRequest({
    url: request.url,
    method: request.method ?? "GET",
    body: new LiveBody(request.bodyMode, request.body, request.urlencoded),
  });
}

function runFull(code: string, store = new VariableStore(), response?: ScriptResponseInfo) {
  return runScript({
    code,
    store,
    info: { requestName: "Long Chau", eventName: response === undefined ? "beforeInvoke" : "afterResponse" },
    origin: REQUEST_ORIGIN,
    request: liveRequest({ url: "{{grpc_url}}", methodPath: "pe.aev2.ExchangeService.Exchange", body: '{"a":1}' }),
    ...(response === undefined ? {} : { response }),
  });
}

async function run(code: string, store = new VariableStore()) {
  return (await runFull(code, store)).logs;
}

describe("runScript", () => {
  it("givenRealTransIdScript_whenRun_thenSetsDatePrefixedNumericEnvironmentVariable", async () => {
    const store = new VariableStore({ environment: { trans_id: "" } });
    await run(REAL_TRANS_ID_SCRIPT, store);

    const transId = store.get("trans_id");
    const now = new Date();
    const prefix = String((now.getFullYear() % 100) * 10000 + (now.getMonth() + 1) * 100 + now.getDate());

    expect(transId).toMatch(/^\d+$/);
    expect(transId).toHaveLength(prefix.length + 9);
    expect(transId?.startsWith(prefix)).toBe(true);
    // The value must be a change so it gets written back to the environment file.
    expect(store.changes("environment")).toEqual({ trans_id: transId });
  });

  it("givenConsoleCalls_whenRun_thenCapturesLevelAndFormattedText", async () => {
    const logs = await run(`
      console.log("plain", 1, true);
      console.warn({ a: 1 });
      console.error("boom");
    `);
    expect(logs).toEqual([
      { level: "log", text: "plain 1 true", origin: REQUEST_ORIGIN },
      { level: "warn", text: '{"a":1}', origin: REQUEST_ORIGIN },
      { level: "error", text: "boom", origin: REQUEST_ORIGIN },
    ]);
  });

  it("givenScopeApis_whenRun_thenReadsAndWritesTheRightLayer", async () => {
    const store = new VariableStore({ globals: { g: "from-globals" }, environment: { e: "from-env" } });
    await run(
      `
      pm.environment.set("e2", "env-written");
      pm.globals.set("g2", "globals-written");
      pm.collectionVariables.set("c", "collection-written");
      pm.variables.set("v", "local-written");
      console.log(pm.environment.get("e"), pm.globals.get("g"), pm.variables.get("e"));
      console.log(String(pm.environment.has("nope")), String(pm.variables.has("g")));
    `,
      store,
    );

    expect(store.changes("environment")).toEqual({ e2: "env-written" });
    expect(store.changes("globals")).toEqual({ g2: "globals-written" });
    expect(store.changes("collection")).toEqual({ c: "collection-written" });
    // pm.variables.set is not persisted anywhere, so it lands in the local scope.
    expect(store.changes("local")).toEqual({ v: "local-written" });
    expect(store.get("v")).toBe("local-written");
  });

  it("givenScopeIsolation_whenReadingFromAnotherScope_thenReturnsUndefined", async () => {
    const store = new VariableStore({ globals: { only: "in-globals" } });
    const logs = await run(`console.log(String(pm.environment.get("only")), String(pm.globals.get("only")));`, store);
    expect(logs[0]?.text).toBe("undefined in-globals");
  });

  it("givenUnsetAndClear_whenRun_thenRecordsEmptyStringChanges", async () => {
    const store = new VariableStore({ environment: { a: "1", b: "2" } });
    await run(`pm.environment.unset("a"); pm.globals.set("keep", "1");`, store);
    expect(store.changes("environment")).toEqual({ a: "" });

    const store2 = new VariableStore({ environment: { a: "1", b: "2" } });
    await run(`pm.environment.clear();`, store2);
    expect(store2.changes("environment")).toEqual({ a: "", b: "" });
  });

  it("givenLegacyPostmanApi_whenRun_thenWritesEnvironmentVariable", async () => {
    const store = new VariableStore({ environment: { legacy: "old" } });
    await run(`postman.setEnvironmentVariable("legacy", postman.getEnvironmentVariable("legacy") + "-new");`, store);
    expect(store.get("legacy")).toBe("old-new");
  });

  it("givenPmInfoAndRequest_whenRun_thenExposesRequestContext", async () => {
    const logs = await run(
      `console.log(pm.info.requestName, pm.info.eventName, pm.request.methodPath, pm.request.body.raw);`,
    );
    expect(logs[0]?.text).toBe('Long Chau beforeInvoke pe.aev2.ExchangeService.Exchange {"a":1}');
  });

  it("givenToObject_whenRun_thenMergesScopesByPrecedence", async () => {
    const store = new VariableStore({ globals: { shared: "g", g: "1" }, environment: { shared: "e" } });
    const logs = await run(`console.log(JSON.stringify(pm.variables.toObject()));`, store);
    expect(JSON.parse(logs[0]!.text)).toEqual({ shared: "e", g: "1" });
  });

  it("givenThrowingScript_whenRun_thenThrowsCliErrorCarryingLogs", async () => {
    try {
      await run(`console.log("before the boom"); throw new Error("nope");`);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      const cliError = error as CliError;
      expect(cliError.message).toContain('script "beforeInvoke" failed');
      expect(cliError.message).toContain("nope");
      expect(cliError.details).toEqual(["log: before the boom"]);
    }
  });

  it("givenInfiniteLoop_whenRun_thenTimesOut", async () => {
    await expect(
      runScript({
        code: `while (true) {}`,
        store: new VariableStore(),
        info: { requestName: "spin", eventName: "beforeInvoke" },
        origin: REQUEST_ORIGIN,
        request: liveRequest({ url: "localhost:9090", methodPath: "", body: "" }),
        timeoutMs: 50,
      }),
    ).rejects.toThrow(CliError);
  });

  it("givenScriptAwaitingForever_whenRun_thenHitsTheOuterDeadline", async () => {
    await expect(
      runScript({
        // vm's own timeout only covers synchronous code, so this can only be
        // caught by the outer deadline.
        code: `await new Promise(() => {});`,
        store: new VariableStore(),
        info: { requestName: "hang", eventName: "beforeInvoke" },
        origin: REQUEST_ORIGIN,
        request: liveRequest({ url: "localhost:9090", methodPath: "", body: "" }),
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out after 50ms/);
  });

  it("givenAwaitingScript_whenRun_thenVariablesWrittenAfterTheAwaitAreVisible", async () => {
    const store = new VariableStore({ environment: { late: "" } });
    await run(`await new Promise((resolve) => setTimeout(resolve, 1)); pm.environment.set("late", "written");`, store);
    expect(store.get("late")).toBe("written");
  });

  it("givenScriptTouchingHostGlobals_whenRun_thenOnlyAllowlistedRequireIsPresent", async () => {
    const logs = await run(`console.log(typeof process, typeof require, typeof fetch);`);
    expect(logs[0]?.text).toBe("undefined function undefined");
  });

  it("givenScript_whenRequireLodash_thenPickWorks", async () => {
    const logs = await run(`console.log(JSON.stringify(require("lodash").pick({ a: 1, b: 2 }, ["b"])));`);
    expect(logs[0]?.text).toBe('{"b":2}');
  });

  it("givenScript_whenUsingBareUnderscore_thenLodashAvailable", async () => {
    const logs = await run(`console.log(_.camelCase("bare lodash global"));`);
    expect(logs[0]?.text).toBe("bareLodashGlobal");
  });

  it("givenScript_whenUsingBareCryptoJs_thenHmacMatchesKnownVector", async () => {
    const store = new VariableStore();
    await run(`pm.environment.set("hmac", CryptoJS.HmacSHA256("payload", "secret").toString());`, store);
    expect(store.get("hmac")).toBe(createHmac("sha256", "secret").update("payload").digest("hex"));
  });

  it("givenScript_whenUsingMoment_thenFormattedDate", async () => {
    const logs = await run(`console.log(require("moment").utc("2026-07-26T12:34:56Z").format("YYYYMMDDHHmmss"));`);
    expect(logs[0]?.text).toBe("20260726123456");
  });

  it("givenScript_whenUsingBufferBase64_thenRoundTrips", async () => {
    const logs = await run(`const value = Buffer.from("preman").toString("base64"); console.log(Buffer.from(value, "base64").toString());`);
    expect(logs[0]?.text).toBe("preman");
  });

  it("givenScript_whenUsingBtoaAtob_thenRoundTrips", async () => {
    const logs = await run(`console.log(atob(btoa("preman")));`);
    expect(logs[0]?.text).toBe("preman");
  });

  it("givenScript_whenUsingXml2js_thenParsesToObject", async () => {
    const logs = await run(`const parsed = await require("xml2js").parseStringPromise("<root><id>7</id></root>"); console.log(parsed.root.id[0]);`);
    expect(logs[0]?.text).toBe("7");
  });

  it("givenScript_whenUsingCheerio_thenSelectsElement", async () => {
    const logs = await run(`const $ = require("cheerio").load("<p class='value'>seven</p>"); console.log($(".value").text());`);
    expect(logs[0]?.text).toBe("seven");
  });

  it("givenScript_whenCallingFunctionConstructor_thenThrows", async () => {
    await expect(run(`Function("return process")();`)).rejects.toThrow("Function is not a function");
  });

  it("givenScript_whenRequiringFs_thenScriptFailsWithAllowList", async () => {
    try {
      await run(`require("fs");`);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toContain("fs");
      expect((error as CliError).details.join("\n")).toContain("crypto-js");
    }
  });

  it("givenScript_whenUsingPmRequire_thenSameAsRequire", async () => {
    const logs = await run(`console.log(pm.require("lodash") === require("lodash"));`);
    expect(logs[0]?.text).toBe("true");
  });

  it("givenLongRunningLibraryCall_whenScriptExceedsBudget_thenDeadlineStillFires", async () => {
    await expect(
      runScript({
        code: `require("ajv"); await new Promise(() => {});`,
        store: new VariableStore(),
        info: { requestName: "library hang", eventName: "beforeInvoke" },
        origin: REQUEST_ORIGIN,
        request: liveRequest({ url: "localhost:9090", methodPath: "", body: "" }),
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out after 50ms/);
  });

  it("givenPreScript_whenRun_thenResponseAndMessageAreAbsent", async () => {
    const logs = await run(`console.log(typeof pm.response, typeof pm.message);`);
    expect(logs[0]?.text).toBe("undefined undefined");
  });

  it("givenPreRequestScript_whenHeadersUpsert_thenNextScriptInChainSeesIt", async () => {
    const request = liveRequest({ url: "http://host/pay", method: "POST", body: "" });
    const options = {
      store: new VariableStore(),
      info: { requestName: "Pay", eventName: "beforeRequest" },
      origin: REQUEST_ORIGIN,
      request,
    };

    await runScript({ ...options, code: `pm.request.headers.upsert("X-Signature", "abc");` });
    const result = await runScript({ ...options, code: `console.log(pm.request.headers.get("x-signature"));` });

    expect(result.logs[0]?.text).toBe("abc");
  });

  it("givenPreRequestScript_whenUrlQueryAdd_thenUrlToStringIncludesIt", async () => {
    const result = await runFull2(`pm.request.url.query.add("ts", "123"); console.log(String(pm.request.url));`);
    expect(result.logs[0]?.text).toBe("http://host/pay?ts=123");
  });

  it("givenPostResponseScript_whenMutatingRequest_thenThrowsFrozenError", async () => {
    const request = liveRequest({ url: "http://host/pay", method: "POST", body: "" });
    freezeRequest(request);

    await expect(
      runScript({
        code: `pm.request.headers.add("X-Late", "nope");`,
        store: new VariableStore(),
        info: { requestName: "Pay", eventName: "afterResponse" },
        origin: REQUEST_ORIGIN,
        request,
      }),
    ).rejects.toThrow("pm.request is read-only after the request has been sent");
  });

  it.each([
    `pm.request.body = {};`,
    `pm.request.url.query = {};`,
    `pm.request.headers = {};`,
    `pm.request.protocol = "grpc";`,
    `pm.request.body.urlencoded = {};`,
    `pm.request.url.path.push("late");`,
    `pm.request.url.host[0] = "other";`,
    `Object.setPrototypeOf(pm.request.url.path, null);`,
    `Object.preventExtensions(pm.request.url.host);`,
  ])(
    "givenFrozenRequest_whenReplacingNestedObject_thenThrowsFrozenError: %s",
    async (code) => {
      const request = liveRequest({ url: "http://host/pay", method: "POST", body: "" });
      freezeRequest(request);

      await expect(
        runScript({
          code,
          store: new VariableStore(),
          info: { requestName: "Pay", eventName: "afterResponse" },
          origin: REQUEST_ORIGIN,
          request,
        }),
      ).rejects.toThrow("pm.request is read-only after the request has been sent");
    },
  );

  it("givenFrozenGrpcRequest_whenReplacingMetadata_thenThrowsFrozenError", async () => {
    const request = liveRequest({ url: "grpc://host:9090", methodPath: "test.Echo", body: "{}" });
    freezeRequest(request);

    await expect(
      runScript({
        code: `pm.request.metadata = {};`,
        store: new VariableStore(),
        info: { requestName: "Echo", eventName: "afterResponse" },
        origin: REQUEST_ORIGIN,
        request,
      }),
    ).rejects.toThrow("pm.request is read-only after the request has been sent");
  });

  it("givenScript_whenReplaceIn_thenTokenResolved", async () => {
    const store = new VariableStore({ environment: { token: "resolved" } });
    const result = await runFull2(`console.log(pm.variables.replaceIn("Bearer {{token}}"));`, undefined, store);
    expect(result.logs[0]?.text).toBe("Bearer resolved");
  });
});

/** Verbatim `afterResponse` script from postman/collections/payment/Long Chau.request.yaml. */
const REAL_TEST_SCRIPT = `const message = pm.response.messages.idx(0);

const body =
    typeof message.data === "string"
        ? JSON.parse(message.data)
        : message.data;

pm.test("Transaction status is TRANS_PROCESSING", function () {
    pm.expect(body.transaction.status).to.equal("TRANS_PROCESSING");
});`;

function grpcResponse(response: unknown, overrides: Partial<GrpcScriptResponse> = {}): GrpcScriptResponse {
  return {
    protocol: "grpc",
    code: 0,
    codeName: "OK",
    message: "",
    durationMs: 42,
    response,
    metadata: { "content-type": "application/grpc" },
    trailers: { "x-handled-by": "echo" },
    ...overrides,
  };
}

describe("runScript (post-response scripts)", () => {
  it("givenRealTestScript_whenStatusMatches_thenTestPasses", async () => {
    const body = { return_code: "OK", transaction: { status: "TRANS_PROCESSING" } };
    const { tests } = await runFull(REAL_TEST_SCRIPT, new VariableStore(), grpcResponse(body));

    expect(tests).toEqual([
      { name: "Transaction status is TRANS_PROCESSING", status: "passed", error: undefined, origin: REQUEST_ORIGIN },
    ]);
  });

  it("givenRealTestScript_whenStatusDiffers_thenTestFailsWithTheChaiMessage", async () => {
    const body = { return_code: "OK", transaction: { status: "TRANS_SUCCESS" } };
    const { tests } = await runFull(REAL_TEST_SCRIPT, new VariableStore(), grpcResponse(body));

    expect(tests).toHaveLength(1);
    expect(tests[0]?.status).toBe("failed");
    expect(tests[0]?.error).toContain("TRANS_PROCESSING");
    expect(tests[0]?.error).toContain("TRANS_SUCCESS");
  });

  it("givenStringMessageData_whenRealTestScriptParsesIt_thenTestPasses", async () => {
    const raw = JSON.stringify({ transaction: { status: "TRANS_PROCESSING" } });
    const { tests } = await runFull(REAL_TEST_SCRIPT, new VariableStore(), grpcResponse(raw));

    expect(tests[0]?.status).toBe("passed");
  });

  it("givenResponse_whenScriptReadsIt_thenPostmanShapedFieldsAreAvailable", async () => {
    const logs = await run2(
      `console.log(pm.response.code, pm.response.status, pm.response.responseTime);
       console.log(pm.response.metadata.get("Content-Type"), pm.response.metadata.has("nope"));
       console.log(pm.response.headers.get("content-type"));
       console.log(pm.response.trailers.has("x-handled-by"));
       console.log(pm.response.messages.count(), pm.message.timestamp instanceof Date);
       console.log(pm.response.responseSize > 0);`,
      grpcResponse({ return_code: "OK" }),
    );

    expect(logs.map((line) => line.text)).toEqual([
      "0 OK 42",
      "application/grpc false",
      "application/grpc",
      "true",
      "1 true",
      "true",
    ]);
  });

  it("givenCustomAssertions_whenUsed_thenTheyMatchTheDocumentedPostmanApi", async () => {
    const { tests } = await runFull(
      `pm.test("status by code", function () { pm.response.to.have.status(0); });
       pm.test("status by name", function () { pm.response.to.have.status("ok"); });
       pm.test("wrong status", function () { pm.response.to.have.status(5); });
       pm.test("not that status", function () { pm.response.to.not.have.status(5); });
       pm.test("metadata pair", function () { pm.response.to.have.metadata("content-type", "application/grpc"); });
       pm.test("metadata mismatch", function () { pm.response.to.have.metadata("content-type", "text/plain"); });
       pm.test("trailer present", function () { pm.response.to.have.trailer("x-handled-by"); });
       pm.test("trailer absent", function () { pm.response.to.have.trailer("grpc-status-details-bin"); });
       pm.test("messages include", function () { pm.response.messages.to.include({ return_code: "OK" }); });
       pm.test("messages exclude", function () { pm.response.messages.to.include({ return_code: "NOPE" }); });`,
      new VariableStore(),
      grpcResponse({ return_code: "OK", transaction: { status: "TRANS_PROCESSING" } }),
    );

    expect(tests.map((test) => [test.name, test.status])).toEqual([
      ["status by code", "passed"],
      ["status by name", "passed"],
      ["wrong status", "failed"],
      ["not that status", "passed"],
      ["metadata pair", "passed"],
      ["metadata mismatch", "failed"],
      ["trailer present", "passed"],
      ["trailer absent", "failed"],
      ["messages include", "passed"],
      ["messages exclude", "failed"],
    ]);
  });

  it("givenPlainChaiInclude_whenUsedOnOrdinaryValues_thenItStillBehavesNormally", async () => {
    const { tests } = await runFull(
      `pm.test("array include", function () { pm.expect([1, 2, 3]).to.include(2); });
       pm.test("string include", function () { pm.expect("abc").to.include("b"); });
       pm.test("object include", function () { pm.expect({ a: 1, b: 2 }).to.include({ a: 1 }); });
       pm.test("include fails", function () { pm.expect([1]).to.include(9); });`,
      new VariableStore(),
      grpcResponse({}),
    );

    expect(tests.map((test) => test.status)).toEqual(["passed", "passed", "passed", "failed"]);
  });

  it("givenAsyncTests_whenRun_thenTheyFailLoudlyInsteadOfPassingSilently", async () => {
    const { tests } = await runFull(
      `pm.test("done callback", function (done) { done(); });
       pm.test("promise", function () { return Promise.reject(new Error("late")); });`,
      new VariableStore(),
      grpcResponse({}),
    );

    expect(tests.map((test) => test.status)).toEqual(["failed", "failed"]);
    expect(tests[0]?.error).toContain("async tests are not supported");
    expect(tests[1]?.error).toContain("async tests are not supported");
  });

  it("givenSkippedAndInvalidTests_whenRun_thenRecordedAsSkipped", async () => {
    const { tests } = await runFull(
      `pm.test.skip("not now", function () { throw new Error("never runs"); });
       pm.test.todo("later");
       pm.test("no callback");`,
      new VariableStore(),
      grpcResponse({}),
    );

    expect(tests.map((test) => [test.name, test.status])).toEqual([
      ["not now", "skipped"],
      ["later", "skipped"],
      ["no callback", "skipped"],
    ]);
  });

  it("givenAFailingTest_whenMoreCodeFollows_thenTheScriptKeepsRunning", async () => {
    const store = new VariableStore({ environment: { last: "" } });
    const { tests, logs } = await runFull(
      `pm.test("fails", function () { pm.expect(1).to.equal(2); });
       console.log("still here");
       pm.environment.set("last", "written");`,
      store,
      grpcResponse({}),
    );

    expect(tests[0]?.status).toBe("failed");
    expect(logs.map((line) => line.text)).toEqual(["still here"]);
    expect(store.changes("environment")).toEqual({ last: "written" });
  });

  it("givenScriptThrowingAfterATest_whenRun_thenTestResultsAreInTheErrorDetails", async () => {
    try {
      await runFull(
        `pm.test("ran first", function () { pm.expect(1).to.equal(1); });
         pm.response.nope.boom;`,
        new VariableStore(),
        grpcResponse({}),
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      const cliError = error as CliError;
      expect(cliError.message).toContain('script "afterResponse" failed');
      expect(cliError.details.join("\n")).toContain("test passed: ran first");
    }
  });

  it("givenNoResponseBody_whenScriptReadsMessages_thenTheListIsEmpty", async () => {
    const logs = await run2(
      `console.log(pm.response.messages.count(), pm.message === undefined);`,
      grpcResponse(undefined),
    );
    expect(logs[0]?.text).toBe("0 true");
  });

  it("givenAUrlencodedBody_whenScriptReadsIt_thenTheFieldsAreVisible", async () => {
    const { logs } = await runFull2(
      `const fields = {};
       pm.request.body.urlencoded.toJSON().forEach((entry) => { fields[entry.key] = entry.value; });
       console.log(pm.request.body.mode, JSON.stringify(fields), pm.request.body.urlencoded.get("sig"));`,
      { url: "http://host/pay", method: "POST", body: "", bodyMode: "urlencoded", urlencoded: FORM_FIELDS },
    );
    expect(logs[0]?.text).toBe('urlencoded {"clientid":"11","sig":"abc"} abc');
  });

  it("givenNoUrlencodedBody_whenScriptReadsIt_thenTheListIsEmptyRatherThanUndefined", async () => {
    const { logs } = await runFull2(`console.log(pm.request.body.urlencoded.count(), pm.request.body.raw);`, {
      url: "http://host/pay",
      method: "POST",
      body: '{"a":1}',
      bodyMode: "json",
    });
    expect(logs[0]?.text).toBe('0 {"a":1}');
  });

  it("givenAScriptUsingCryptoJs_whenRun_thenTheDigestMatchesNode", async () => {
    const store = new VariableStore();
    await runFull2(`pm.environment.set("sig", CryptoJS.SHA256("11|payload").toString());`, undefined, store);
    expect(store.get("sig")).toBe(createHash("sha256").update("11|payload").digest("hex"));
  });
});

const FORM_FIELDS = [
  { key: "clientid", value: "11" },
  { key: "sig", value: "abc" },
];

/** Like {@link runFull}, but with the HTTP request facade the body tests need. */
async function runFull2(code: string, request?: ScriptRequestInfo, store = new VariableStore()) {
  return runScript({
    code,
    store,
    info: { requestName: "Bank Query", eventName: "beforeRequest" },
    origin: REQUEST_ORIGIN,
    request: liveRequest(request ?? { url: "http://host/pay", method: "POST", body: "" }),
  });
}

async function run2(code: string, response: ScriptResponseInfo) {
  return (await runFull(code, new VariableStore(), response)).logs;
}
