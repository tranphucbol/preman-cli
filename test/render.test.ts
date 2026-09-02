import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSelection, type RunSelectionArgs } from "@preman/core/api/run.js";
import { LOAD_OPTIONS } from "@preman/core/grpc/schema.js";
import { progressWriter, type ProgressStream } from "@preman/cli/progress.js";
import { renderGroupOutcome, renderOutcome } from "@preman/cli/render/outcome.js";
import { renderProgress } from "@preman/cli/render/migrate.js";
import { renderLinkWrite, renderSpecs } from "@preman/cli/render/protos.js";
import { toGroupJsonReport, toJsonReport } from "@preman/core/report/json.js";
import type { DeclaredSpec, SpecsView } from "@preman/core/api/specs.js";
import type { MigrationPhase, MigrationProgress } from "@preman/core";
import type { GroupRunOutcome, RunOutcome } from "@preman/core/runner.js";

/** Wide enough for the bar, and narrower than the bar needs. */
const WIDE = 100;
const NARROW = 40;
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
 * Golden-output characterization of the renderers. Every paint call here is the identity
 * function and the expected strings are plain text, because `vitest.config.ts` sets `NO_COLOR`
 * for the worker. Not being a TTY is not enough on its own: picocolors also enables colour when
 * `CI` is set, which is why these cases only ever failed on a runner.
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

/**
 * The migration's progress line. Pure, so the shape is assertable without a terminal — which is
 * the point of the split: `progressWriter` owns the carriage returns and knows nothing about words.
 */
describe("renderProgress", () => {
  const at = (over: Partial<MigrationProgress>): MigrationProgress => ({
    phase: "reading-collections",
    done: 0,
    total: undefined,
    calls: 0,
    ...over,
  });

  it("givenAnUnknowableTotal_whenRendered_thenNoBarIsDrawn", () => {
    const line = renderProgress(at({ phase: "converting", calls: 1245 }), WIDE);

    // An empty bar would claim nothing has happened; what is true is that nobody knows how much
    // there is. The absence of a bar is the honest drawing of that.
    expect(line).not.toContain("░");
    expect(line).toContain("converting");
    expect(line).toContain("1245 reads");
  });

  it("givenOneRead_whenRendered_thenItIsSingular", () => {
    expect(renderProgress(at({ phase: "reading-workspace", calls: 1 }), WIDE)).toContain("1 read");
  });

  it("givenAlmostEveryUnit_whenRendered_thenTheBarIsNotYetFull", () => {
    const line = renderProgress(at({ done: 675, total: 684, calls: 1245 }), WIDE);

    // Rounding would fill the last cell at 675 of 684 and put a visibly complete bar beside "98%".
    expect(line).toContain("675/684");
    expect(line).toContain("98%");
    expect(line).toContain("░");
  });

  it("givenEveryUnit_whenRendered_thenTheBarIsFull", () => {
    expect(renderProgress(at({ done: 41, total: 41 }), WIDE)).not.toContain("░");
  });

  it("givenNoUnitsAtAll_whenRendered_thenThePhaseReadsAsFinished", () => {
    // A workspace with no environments; an empty bar there would read as stuck forever.
    expect(renderProgress(at({ phase: "reading-environments", done: 0, total: 0 }), WIDE)).toContain("100%");
  });

  it("givenANarrowTerminal_whenRendered_thenTheCountsSurviveAndTheBarIsDropped", () => {
    const line = renderProgress(at({ done: 12, total: 41 }), NARROW);

    expect(line).toContain("12/41");
    expect(line).not.toContain("░");
  });
});

describe("progressWriter", () => {
  const at = (phase: MigrationPhase, calls: number): MigrationProgress => ({
    phase,
    done: 0,
    total: undefined,
    calls,
  });

  function fake(isTTY: boolean): { stream: ProgressStream; written: string[] } {
    const written: string[] = [];
    return { stream: { isTTY, columns: WIDE, write: (chunk: string) => written.push(chunk) }, written };
  }

  it("givenATerminalThatWillNotSayHowWideItIs_whenReportsArrive_thenTheBarIsStillDrawn", () => {
    // A pty with no window size attached reports zero rather than nothing — `script -q /dev/null`
    // is one — and reading that as a width silently drops the bar on a real terminal.
    const written: string[] = [];
    progressWriter({ isTTY: true, columns: 0, write: (chunk: string) => written.push(chunk) }).report({
      phase: "reading-collections",
      done: 12,
      total: 41,
      calls: 327,
    });

    expect(written[0]).toContain("░");
  });

  it("givenATerminal_whenReportsArrive_thenOneLineIsRewrittenAndTakenBackDown", () => {
    const { stream, written } = fake(true);
    const writer = progressWriter(stream);

    writer.report(at("reading-collections", 25));
    writer.report(at("reading-collections", 50));
    writer.clear();

    expect(written).toHaveLength(3);
    // Erase-then-write, so the previous line's length never has to be remembered.
    expect(written.every((chunk) => chunk.startsWith("\u001B[2K\r"))).toBe(true);
    expect(written[2]).toBe("\u001B[2K\r");
  });

  it("givenAPipe_whenReportsArrive_thenOnlyPhaseChangesAreLogged", () => {
    const { stream, written } = fake(false);
    const writer = progressWriter(stream);

    writer.report(at("reading-collections", 25));
    writer.report(at("reading-collections", 50));
    writer.report(at("writing", 50));
    writer.clear();

    // Carriage returns in a log file are noise; a log wants to know when each phase began.
    expect(written).toHaveLength(2);
    expect(written.every((chunk) => chunk.endsWith("\n"))).toBe(true);
    expect(written.some((chunk) => chunk.includes("\r"))).toBe(false);
  });
});

/**
 * The protos view, which is the only render whose subject is a machine's setup rather than a run.
 * Built from literals rather than from a workspace: what is asserted here is the wording a person
 * repairs their machine from, and nothing about it needs a `.git` or a shared root to exist.
 */
describe("renderSpecs", () => {
  const SHARED = "/Users/Shared/postman-protos";
  const CHECKOUT = "/Users/bob/work/refund-core";
  const PLAIN = { json: false };

  function spec(link: string, rest: string, extra: Partial<DeclaredSpec> = {}): DeclaredSpec {
    const declared = `${SHARED}/${link}/${rest}`;
    return { declared, path: declared, exists: true, link, via: "link", ...extra };
  }

  function view(specs: readonly DeclaredSpec[], extra: Partial<SpecsView> = {}): SpecsView {
    return {
      root: CHECKOUT,
      resourcesPath: `${CHECKOUT}/.postman/resources.yaml`,
      sharedRoot: SHARED,
      specs: [...specs],
      links: [],
      unresolvedLinks: [],
      ownCheckout: undefined,
      ...extra,
    };
  }

  it("givenAMissingLinkForTheOwnCheckout_whenRendered_thenTheCommandCarriesTheRealPath", () => {
    const rendered = renderSpecs(
      view([spec("refund-core", "api/refund.proto", { exists: false })], {
        unresolvedLinks: ["refund-core"],
        ownCheckout: CHECKOUT,
      }),
      PLAIN,
    );

    expect(rendered).toContain(`preman protos link refund-core ${CHECKOUT}`);
    expect(rendered).not.toContain("<path-to-checkout>");
  });

  it("givenAMissingLinkForAnotherRepository_whenRendered_thenThePlaceholderIsKept", () => {
    // No checkout to stand in, which is every workspace that is not inside a repository.
    const rendered = renderSpecs(
      view([spec("zas-spec", "api/admin.proto", { exists: false })], { unresolvedLinks: ["zas-spec"] }),
      PLAIN,
    );

    expect(rendered).toContain("preman protos link zas-spec <path-to-checkout>");
  });

  it("givenSpecsFromTheOwnCheckout_whenRendered_thenTheLinkNameIsStillShown", () => {
    // Decision 9: the link is not needed here and is still needed by a workspace elsewhere, so
    // the name a person would type stays on screen rather than the row reading as plain healthy.
    const rendered = renderSpecs(
      view(
        [
          spec("refund-core", "api/refund.proto", { path: `${CHECKOUT}/api/refund.proto`, via: "own-checkout" }),
          spec("refund-core", "api/query.proto", { path: `${CHECKOUT}/api/query.proto`, via: "own-checkout" }),
        ],
        { ownCheckout: CHECKOUT },
      ),
      PLAIN,
    );

    expect(rendered).toContain("refund-core");
    expect(rendered).toContain("own checkout");
    expect(rendered).not.toContain("(missing)");
    expect(rendered).not.toContain("link(s) to fix");
  });

  it("givenALinkThatHoldsTheSpecsToo_whenRendered_thenNoRowIsLabelled", () => {
    // The machine the link was made on. Labelling every row there is noise, not information:
    // the link resolves and it points at this same checkout.
    const rendered = renderSpecs(
      view(
        [
          spec("refund-core", "api/refund.proto", { path: `${CHECKOUT}/api/refund.proto`, via: "both" }),
          spec("refund-core", "api/query.proto", { path: `${CHECKOUT}/api/query.proto`, via: "both" }),
        ],
        { ownCheckout: CHECKOUT, links: [{ name: "refund-core", target: CHECKOUT, resolves: true }] },
      ),
      PLAIN,
    );

    expect(rendered).toContain(`refund-core -> ${CHECKOUT}`);
    expect(rendered).not.toContain("own checkout");
  });

  it("givenALinkWriteThatResolvesEverySpec_whenRendered_thenItSaysAllOfThem", () => {
    const written = renderLinkWrite(
      { name: "refund-core", target: CHECKOUT, resolves: true },
      view([spec("refund-core", "api/refund.proto"), spec("refund-core", "api/query.proto")]),
      PLAIN,
    );

    expect(written).toContain("2 of 2 specs now resolve");
  });

  it("givenALinkWriteThatResolvesNothing_whenRendered_thenItSaysNoneOfThem", () => {
    // The wrong-checkout signal. `linked refund-core -> …/pkg` used to print as success and be
    // discovered later as a method picker with nothing in it.
    const written = renderLinkWrite(
      { name: "refund-core", target: `${CHECKOUT}/pkg`, resolves: true },
      view([
        spec("refund-core", "api/refund.proto", { exists: false }),
        spec("refund-core", "api/query.proto", { exists: false }),
      ]),
      PLAIN,
    );

    expect(written).toContain("0 of 2 specs now resolve");
  });

  it("givenNoWorkspaceToCountAgainst_whenRendered_thenOnlyTheWriteIsReported", () => {
    // `protos link` runs without a workspace on purpose; a count it cannot take is not a zero.
    const written = renderLinkWrite({ name: "refund-core", target: CHECKOUT, resolves: true }, undefined, PLAIN);

    expect(written).toBe(`linked refund-core -> ${CHECKOUT}`);
  });
});
