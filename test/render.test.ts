import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSelection, type RunSelectionArgs } from "@preman/core/api/run.js";
import { LOAD_OPTIONS } from "@preman/core/grpc/schema.js";
import { renderGroupOutcome, renderOutcome } from "@preman/cli/render/outcome.js";
import { toGroupJsonReport, toJsonReport } from "@preman/core/report/json.js";
import type { GroupRunOutcome, RunOutcome } from "@preman/core/runner.js";
import {
  FIXTURE_HTTP_WS,
  FIXTURE_INCLUDE_DIR,
  FIXTURES_DIR,
  FIXTURE_PROTO,
  FIXTURE_WS,
  HTTP_TOKEN,
  startHttpServer,
  type HttpTestServer,
} from "./helpers.js";

/**
 * Golden-output characterization of the renderers. `picocolors` disables itself when
 * stdout is not a TTY, and a vitest run is not one, so every paint call here is the
 * identity function and the expected strings are plain text.
 */

interface EchoRequest {
  text?: string;
  amount?: string;
  trans_id?: string;
  mode?: string;
}

let server: grpc.Server;
let port: number;
let http: HttpTestServer;

function echo(call: grpc.ServerUnaryCall<EchoRequest, unknown>, callback: grpc.sendUnaryData<unknown>): void {
  const body = call.request;
  const trailers = new grpc.Metadata();
  trailers.set("x-handled-by", "test-server");

  if (body.mode === "TRANSPORT_FAIL") {
    callback({ code: grpc.status.INTERNAL, details: "handler exploded", metadata: trailers });
    return;
  }
  callback(null, { return_code: "OK", message: "done", echoed: body.text, trans_id: body.trans_id });
}

beforeAll(async () => {
  const pkg = protoLoader.loadSync(FIXTURE_PROTO, { ...LOAD_OPTIONS, includeDirs: [FIXTURE_INCLUDE_DIR] });
  const service = pkg["test.echo.EchoService"] as grpc.ServiceDefinition;

  server = new grpc.Server();
  server.addService(service, {
    Echo: ((call, cb) => echo(call, cb)) satisfies grpc.handleUnaryCall<EchoRequest, unknown>,
    Ping: ((call, cb) => echo(call, cb)) satisfies grpc.handleUnaryCall<EchoRequest, unknown>,
  });

  port = await new Promise<number>((done, fail) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
      if (error) fail(error);
      else done(boundPort);
    });
  });

  http = await startHttpServer();
});

afterAll(async () => {
  await new Promise<void>((done) => server.tryShutdown(() => done()));
  await http.close();
});

const BASE: Omit<RunSelectionArgs, "dir" | "selector" | "env" | "url"> = {
  tls: undefined,
  tlsCerts: {},
  timeoutMs: 30_000,
  runTimeoutMs: 0,
  scriptTimeoutMs: 5_000,
  iterationCount: undefined,
  iterationData: undefined,
  delayRequestMs: 0,
  vars: {},
  save: false,
  preferDescriptor: false,
  bail: false,
  certBaseDir: FIXTURES_DIR,
  workingDir: undefined,
  insecureFileRead: false,
  safeEval: false,
};

async function grpcOutcome(selector: string, overrides: Partial<RunSelectionArgs> = {}): Promise<RunOutcome> {
  const result = await runSelection({
    ...BASE,
    dir: FIXTURE_WS,
    selector,
    env: "LOCAL",
    url: `localhost:${port}`,
    ...overrides,
  });
  if (result.outcome === undefined) throw new Error(`"${selector}" did not produce a single-request outcome`);
  return result.outcome;
}

async function grpcGroup(selector: string, overrides: Partial<RunSelectionArgs> = {}): Promise<GroupRunOutcome> {
  const result = await runSelection({
    ...BASE,
    dir: FIXTURE_WS,
    selector,
    env: "LOCAL",
    url: `localhost:${port}`,
    ...overrides,
  });
  if (result.group === undefined) throw new Error(`"${selector}" did not produce a group outcome`);
  return result.group;
}

async function httpOutcome(selector: string, overrides: Partial<RunSelectionArgs> = {}): Promise<RunOutcome> {
  const result = await runSelection({
    ...BASE,
    dir: FIXTURE_HTTP_WS,
    selector,
    env: "QC",
    url: undefined,
    vars: { http_url: http.origin, token: HTTP_TOKEN },
    ...overrides,
  });
  if (result.outcome === undefined) throw new Error(`"${selector}" did not produce a single-request outcome`);
  return result.outcome;
}

describe("renderOutcome", () => {
  it("givenGrpcOutcome_whenRendered_thenHeaderStatusAndTestsAppear", async () => {
    const text = renderOutcome(await grpcOutcome("Echo"), { verbose: false });

    expect(text).toContain("payment/Echo  →  test.echo.EchoService.Echo");
    expect(text).toContain(`target localhost:${port} [plaintext] (--url) · schema proto-file`);
    expect(text).toContain("✓ OK / OK");
    expect(text).toContain("✓ return_code is as expected");
    expect(text).toContain("✓ grpc status is OK");
    expect(text).toContain("2 tests · 2 passed");
  });

  it("givenFailedGrpcStatus_whenRendered_thenTransportLineShown", async () => {
    const text = renderOutcome(await grpcOutcome("Echo", { vars: { mode: "TRANSPORT_FAIL" } }), { verbose: false });

    expect(text).toContain("✗ INTERNAL");
    expect(text).toContain("handler exploded");
    // A transport failure runs no post-response scripts, so there is no tally.
    expect(text).not.toContain("tests ·");
  });

  it("givenHttpOutcome_whenRendered_thenStatusLineIsTheVerdict", async () => {
    const text = renderOutcome(await httpOutcome("Login"), { verbose: false });

    expect(text).toContain("admin/Login  →  POST /login");
    expect(text).toContain(`target ${http.origin} [plaintext] (request url)`);
    expect(text).toContain("✓ 200 OK");
    expect(text).toContain("✓ logged in");
  });

  it("givenNoHttpResponse_whenRendered_thenNoResponseLabelShown", async () => {
    const text = renderOutcome(await httpOutcome("Login", { url: "http://127.0.0.1:1" }), { verbose: false });

    expect(text).toContain("✗ no response");
    expect(text).toContain("warn: afterResponse scripts skipped: no response was received");
  });

  it("givenVerbose_whenRendered_thenRequestBodyConsoleAndCertSourcesAppear", async () => {
    const text = renderOutcome(await grpcOutcome("Echo", { tlsCerts: { insecure: true } }), { verbose: true });

    expect(text).toContain("cert insecure ← --ssl-*");
    expect(text).toContain("script log: generated trans_id");
    expect(text).toContain("request metadata:");
    expect(text).toContain("  x-scripted: beforeInvoke");
    expect(text).toContain("request body:");
    expect(text).toContain('"mode": "SUCCEED"');
  });

  it("givenRedactedHeader_whenRenderedVerbose_thenValueIsTruncated", async () => {
    const text = renderOutcome(await httpOutcome("Profile"), { verbose: true });

    expect(text).toContain("request headers:");
    // Redaction is case-insensitive on the header name, and keeps the first eight characters.
    expect(text).toContain("  Authorization: Bearer j…");
    expect(text).not.toContain(`Bearer ${HTTP_TOKEN}`);
  });
});

describe("renderGroupOutcome", () => {
  it("givenGroupOutcome_whenRendered_thenTableAndCountsLineAppear", async () => {
    const text = renderGroupOutcome(await grpcGroup("payment"), { verbose: false });

    expect(text).toContain("payment  5 requests");
    expect(text).toContain("✓ payment/Ping");
    expect(text).toContain("- payment/Legacy Http");
    expect(text).toContain("skipped: websocket-request is not supported yet");
    expect(text).toContain("5 requests · 3 ok · 1 failed · 1 skipped · 3 assertions · 3 passed");
  });

  it("givenGroupOutcome_whenRenderedVerbose_thenPerRequestReportsReplaceTheTable", async () => {
    const group = await grpcGroup("payment/nested");

    const compact = renderGroupOutcome(group, { verbose: false });
    expect(compact).not.toContain("request body:");

    const verbose = renderGroupOutcome(group, { verbose: true });
    expect(verbose).toContain("payment/nested  1 request");
    expect(verbose).toContain("payment/nested/Deep Echo  →  test.echo.EchoService.Echo");
    expect(verbose).toContain("request body:");
  });

  it("givenBailedGroup_whenRendered_thenStoppedLineExplainsWhy", async () => {
    const text = renderGroupOutcome(await grpcGroup("payment", { bail: true }), { verbose: false });

    expect(text).toContain("✗ payment/Descriptor Only");
    expect(text).toContain("stopped early: --bail");
    // Deep Echo follows the failure and is never attempted.
    expect(text).not.toContain("payment/nested/Deep Echo");
  });
});

describe("json reports", () => {
  it("givenGrpcOutcome_whenJsonReported_thenShapeIsStable", async () => {
    const report = toJsonReport(await grpcOutcome("Echo"));

    expect(Object.keys(report)).toEqual([
      "request",
      "protocol",
      "target",
      "warnings",
      "console",
      "sideRequests",
      "tests",
      "testSummary",
      "savedVars",
      "savedTo",
      "exitCode",
      "methodPath",
      "schemaSource",
      "request_message",
      "request_metadata",
      "ok",
      "status",
      "durationMs",
      "response",
      "responseMetadata",
      "trailers",
      "returnCode",
    ]);
    expect(report).toMatchObject({
      request: { name: "Echo", path: "payment/Echo" },
      protocol: "grpc",
      methodPath: "test.echo.EchoService.Echo",
      schemaSource: "proto-file",
      ok: true,
      status: { name: "OK" },
      returnCode: "OK",
      exitCode: 0,
      testSummary: { total: 2, passed: 2, failed: 0, skipped: 0 },
    });
  });

  it("givenHttpOutcome_whenJsonReported_thenBodyIsParsedWhenJson", async () => {
    const report = toJsonReport(await httpOutcome("Login"));

    expect(Object.keys(report)).toEqual([
      "request",
      "protocol",
      "target",
      "warnings",
      "console",
      "sideRequests",
      "tests",
      "testSummary",
      "savedVars",
      "savedTo",
      "exitCode",
      "method",
      "url",
      "finalUrl",
      "request_headers",
      "request_body",
      "ok",
      "status",
      "durationMs",
      "response",
      "responseHeaders",
      "setCookies",
      "redirects",
    ]);
    expect(report).toMatchObject({
      protocol: "http",
      method: "POST",
      ok: true,
      status: { code: 200 },
      response: { reason_code: "SUCCESSFUL" },
    });
  });

  it("givenGroupOutcome_whenJsonReported_thenItemsCarryNestedRuns", async () => {
    const report = toGroupJsonReport(await grpcGroup("payment"));

    expect(Object.keys(report)).toEqual([
      "group",
      "items",
      "bailed",
      "bailReason",
      "iterations",
      "tests",
      "savedVars",
      "savedTo",
      "durationMs",
      "exitCode",
    ]);
    expect(Object.keys(report.items[0] ?? {})).toEqual(["request", "iteration", "status", "error", "run"]);
    expect(report.items.map((item) => item.status)).toEqual(["ok", "ok", "skipped", "transport", "ok"]);
    // A skipped request has an error and no run; a completed one has the reverse.
    expect(report.items[2]?.run).toBeNull();
    expect(report.items[0]?.run).toMatchObject({ methodPath: "test.echo.EchoService.Ping" });
    expect(report.items[0]?.error).toBeNull();
  });
});
