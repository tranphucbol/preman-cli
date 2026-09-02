import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "@preman/cli/main.js";
import type { RunEvent, RunEventSink } from "@preman/core/api/events.js";
import { runSelection } from "@preman/core/api/run.js";
import { PremanError, EXIT } from "@preman/core/errors.js";
import { LOAD_OPTIONS } from "@preman/core/grpc/schema.js";
import { extractReturnCode, isBusinessSuccess } from "@preman/core/runner.js";
import { loadEnvironment } from "@preman/core/workspace/environments.js";
import {
  cloneFixtureWorkspace,
  collectionPath,
  definitionPath,
  FIXTURE_INCLUDE_DIR,
  FIXTURE_PROTO,
  FIXTURE_WS,
  dataPath,
} from "./helpers.js";

interface EchoRequest {
  text?: string;
  amount?: string;
  trans_id?: string;
  mode?: string;
}

/** Every request the in-process server received, in order. */
const received: Array<{ method: string; body: EchoRequest; metadata: Record<string, string | string[]> }> = [];

let server: grpc.Server;
let port: number;

function flattenMetadata(metadata: grpc.Metadata): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of Object.keys(metadata.getMap())) {
    const values = metadata.get(key).map(String);
    out[key] = values.length === 1 ? values[0]! : values;
  }
  return out;
}

/**
 * The handler's behaviour is driven by the request's `mode` field so a single
 * server can exercise every exit-code path.
 */
function echo(
  call: grpc.ServerUnaryCall<EchoRequest, unknown>,
  callback: grpc.sendUnaryData<unknown>,
  method: string,
): void {
  const body = call.request;
  received.push({ method, body, metadata: flattenMetadata(call.metadata) });

  const trailers = new grpc.Metadata();
  trailers.set("x-handled-by", "test-server");

  switch (body.mode) {
    case "TRANSPORT_FAIL":
      callback({ code: grpc.status.INTERNAL, details: "handler exploded", metadata: trailers });
      return;
    case "BUSINESS_FAIL":
      callback(null, { return_code: "INVALID_ARGUMENT", message: "amount is not allowed", trans_id: body.trans_id });
      return;
    default:
      callback(null, {
        return_code: "OK",
        message: "done",
        echoed: body.text,
        amount: body.amount,
        trans_id: body.trans_id,
      });
  }
}

beforeAll(async () => {
  const pkg = protoLoader.loadSync(FIXTURE_PROTO, { ...LOAD_OPTIONS, includeDirs: [FIXTURE_INCLUDE_DIR] });
  const service = pkg["test.echo.EchoService"] as grpc.ServiceDefinition;

  const handlers: grpc.UntypedServiceImplementation = {
    Echo: ((call, cb) => echo(call, cb, "Echo")) satisfies grpc.handleUnaryCall<EchoRequest, unknown>,
    Ping: ((call, cb) => echo(call, cb, "Ping")) satisfies grpc.handleUnaryCall<EchoRequest, unknown>,
  };

  server = new grpc.Server();
  server.addService(service, handlers);

  port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
      if (error) reject(error);
      else resolve(boundPort);
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
});

afterEach(() => {
  received.length = 0;
  vi.restoreAllMocks();
});

/** Run the CLI, capturing stdout/stderr instead of letting it reach the terminal. */
async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });

  try {
    const code = await main(args);
    return { code, stdout, stderr };
  } finally {
    vi.restoreAllMocks();
  }
}

const target = () => `localhost:${port}`;

describe("preman run (end to end against a real gRPC server)", () => {
  it("givenSucceedingCall_whenRun_thenSendsInterpolatedPayloadAndExitsZero", async () => {
    const { code, stdout } = await runCli([
      "run",
      "Echo",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--no-save",
      "--json",
    ]);

    expect(code).toBe(EXIT.OK);

    const report = JSON.parse(stdout) as {
      ok: boolean;
      status: { name: string };
      returnCode: string;
      exitCode: number;
      methodPath: string;
      request: { path: string };
      request_message: EchoRequest;
      request_metadata: Record<string, string>;
      response: Record<string, unknown>;
    };
    expect(report.ok).toBe(true);
    expect(report.status.name).toBe("OK");
    expect(report.returnCode).toBe("OK");
    expect(report.exitCode).toBe(0);
    expect(report.request.path).toBe("payment/Echo");
    expect(report.methodPath).toBe("test.echo.EchoService.Echo");
    // What preman reports as sent must match what the server actually received.
    expect(report.request_message).toEqual(received[0]?.body);

    // The server saw exactly one Echo call with the fully-interpolated payload.
    expect(received).toHaveLength(1);
    const sent = received[0]!;
    expect(sent.method).toBe("Echo");
    // greeting=hello comes from the environment, overriding the globals value.
    expect(sent.body.text).toMatch(/^hello [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(sent.body.mode).toBe("SUCCEED");
    // 64-bit values survive as strings: 9007199254740993 > Number.MAX_SAFE_INTEGER.
    expect(sent.body.amount).toBe("9007199254740993");
    // trans_id was computed by the beforeInvoke script, not present in the env file.
    expect(sent.body.trans_id).toMatch(/^\d{19}$/);
    expect(sent.metadata["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.metadata["x-scripted"]).toBe("beforeInvoke");
    expect(sent.metadata["x-collection-script"]).toBe("payment");

    // And the response round-tripped back through the same schema.
    expect(report.response.echoed).toBe(sent.body.text);
    expect(report.response.amount).toBe("9007199254740993");
  });

  it("givenRequestUsingFakerVariables_whenRunning_thenServerSeesGeneratedValues", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      const request = collectionPath(clone.root, "payment", "Echo.request.yaml");
      writeFileSync(
        request,
        readFileSync(request, "utf8").replace(
          '"text": "{{greeting}} {{$guid}}"',
          '"text": "{{$randomFirstName}}|{{$randomEmail}}"',
        ),
      );

      const { code } = await runCli([
        "run",
        "Echo",
        "-d",
        clone.root,
        "-e",
        "LOCAL",
        "--url",
        target(),
        "--no-save",
        "--json",
      ]);

      expect(code).toBe(EXIT.OK);
      expect(received).toHaveLength(1);
      const [firstName, email] = received[0]?.body.text?.split("|") ?? [];
      expect(firstName).not.toBe("");
      expect(email).toContain("@");
    } finally {
      clone.cleanup();
    }
  });

  /**
   * The bug this covers: `Deep Echo` names `{{trans_id}}` in its body and a script computes it,
   * and the value that reached the wire was the one left in the environment file by the *previous*
   * run. First run of a fresh workspace: literal braces, and a server that says invalid argument.
   */
  it("givenAScriptThatSetsAVariableItsOwnBodyNames_whenRun_thenTheWireHasTheScriptsValue", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      const request = collectionPath(clone.root, "payment", "nested", "Deep Echo.request.yaml");
      appendFileSync(
        request,
        [
          "",
          "scripts:",
          "  - type: beforeInvoke",
          "    language: text/javascript",
          "    code: |-",
          '      pm.environment.set("trans_id", "set-by-the-script");',
          "      console.log(pm.request.body.raw);",
          "",
        ].join("\n"),
      );

      const { code } = await runCli([
        "run",
        "Deep Echo",
        "-d",
        clone.root,
        "-e",
        "LOCAL",
        "--url",
        target(),
        "--no-save",
        "--json",
      ]);

      expect(code).toBe(EXIT.OK);
      expect(received).toHaveLength(1);
      expect(received[0]?.body.trans_id).toBe("set-by-the-script");
    } finally {
      clone.cleanup();
    }
  });

  /**
   * Decision 041. The call succeeded and the body is already in hand, so a throw from the
   * request's own post-response script is one failed assertion about that response - not a
   * reason to report nothing. What used to be lost: the response, the assertions the script
   * managed first, and the environment writeback.
   */
  it("givenAnAfterResponseScriptThatThrows_whenRun_thenTheResponseIsStillReportedAndSaved", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      const request = collectionPath(clone.root, "payment", "nested", "Deep Echo.request.yaml");
      appendFileSync(
        request,
        [
          "",
          "scripts:",
          "  - type: afterResponse",
          "    language: text/javascript",
          "    code: |-",
          '      pm.test("grpc status is OK", () => pm.expect(pm.response.code).to.equal(0));',
          '      pm.environment.set("deep_echo_seen", "yes");',
          '      throw new Error("order amount must be a non-negative safe integer");',
          "",
        ].join("\n"),
      );

      const { code, stdout } = await runCli([
        "run",
        "Deep Echo",
        "-d",
        clone.root,
        "-e",
        "LOCAL",
        "--url",
        target(),
        "--json",
      ]);

      // A failed assertion, not a dead run: the same exit code any other failing test gives.
      expect(code).toBe(EXIT.TEST);

      const report = JSON.parse(stdout) as {
        response: Record<string, unknown>;
        tests: Array<{ name: string; status: string; error: string | null }>;
        testSummary: { passed: number; failed: number };
        savedVars: Record<string, string>;
        savedTo: string | null;
      };

      // The call happened and its body is in the report rather than thrown away with the error.
      expect(received).toHaveLength(1);
      expect(report.response.echoed).toBe("deep");

      // The assertion the script managed before it threw survives it.
      expect(report.tests[0]).toMatchObject({ name: "grpc status is OK", status: "passed" });

      // And the throw itself reads as a failed test naming the phase, carrying its message.
      expect(report.tests[1]).toMatchObject({
        name: 'script "afterResponse"',
        status: "failed",
        error: "order amount must be a non-negative safe integer",
      });
      expect(report.testSummary).toMatchObject({ passed: 1, failed: 1 });

      // The writeback the throw used to skip.
      expect(report.savedVars.deep_echo_seen).toBe("yes");
      expect(report.savedTo).not.toBeNull();
      expect(readFileSync(report.savedTo!, "utf8")).toContain("deep_echo_seen");
    } finally {
      clone.cleanup();
    }
  });

  /**
   * The price of resolving twice, and why a dynamic value is drawn once and carried. A script
   * that signs the body it was handed must be signing the body that is sent.
   */
  it("givenABodyWithADynamicVariable_whenResolvedTwice_thenTheScriptSawWhatWasSent", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      const request = collectionPath(clone.root, "payment", "nested", "Deep Echo.request.yaml");
      writeFileSync(
        request,
        readFileSync(request, "utf8").replace('"trans_id": "{{trans_id}}"', '"trans_id": "{{$guid}}"'),
      );
      appendFileSync(
        request,
        [
          "",
          "scripts:",
          "  - type: beforeInvoke",
          "    language: text/javascript",
          "    code: |-",
          '      pm.environment.set("mode", "SUCCEED");',
          "      console.log(JSON.parse(pm.request.body.raw).trans_id);",
          "",
        ].join("\n"),
      );

      const { code, stdout } = await runCli([
        "run",
        "Deep Echo",
        "-d",
        clone.root,
        "-e",
        "LOCAL",
        "--url",
        target(),
        "--no-save",
        "--json",
      ]);

      expect(code).toBe(EXIT.OK);
      const report = JSON.parse(stdout) as { console: { text: string }[] };
      const logged = report.console.map((line) => line.text).at(-1);
      expect(logged).toMatch(/^[0-9a-f-]{36}$/);
      // The script set a variable, so the body was resolved a second time - and drew the same guid.
      expect(received[0]?.body.trans_id).toBe(logged);
    } finally {
      clone.cleanup();
    }
  });

  it("givenBusinessFailure_whenRun_thenTransportIsOkButExitCodeIsThree", async () => {
    const { code, stdout } = await runCli([
      "run",
      "Echo",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--var",
      "mode=BUSINESS_FAIL",
      "--no-save",
      "--json",
    ]);

    expect(code).toBe(EXIT.BUSINESS);
    const report = JSON.parse(stdout) as { ok: boolean; status: { name: string }; returnCode: string };
    expect(report.ok).toBe(true);
    expect(report.status.name).toBe("OK");
    expect(report.returnCode).toBe("INVALID_ARGUMENT");
    expect(received[0]?.body.mode).toBe("BUSINESS_FAIL");
  });

  it("givenServerError_whenRun_thenExitCodeIsTwo", async () => {
    const { code, stdout } = await runCli([
      "run",
      "Echo",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--var",
      "mode=TRANSPORT_FAIL",
      "--no-save",
      "--json",
    ]);

    expect(code).toBe(EXIT.TRANSPORT);
    const report = JSON.parse(stdout) as {
      ok: boolean;
      status: { code: number; name: string; message: string };
      trailers: Record<string, string>;
    };
    expect(report.ok).toBe(false);
    expect(report.status.code).toBe(grpc.status.INTERNAL);
    expect(report.status.name).toBe("INTERNAL");
    expect(report.status.message).toContain("handler exploded");
    expect(report.trailers["x-handled-by"]).toBe("test-server");
  });

  /**
   * A rejection is where servers attach structured detail, so unlike a success this
   * path puts the trailers on the wire for the window as well as in the batch report.
   */
  it("givenGrpcCallRejected_whenRun_thenTrailersReachTheSink", async () => {
    const sink: RunEventSink & { events: RunEvent[] } = {
      runId: "run-under-test",
      events: [],
      emit(event) {
        this.events.push(event);
      },
    };
    await runSelection({
      dir: FIXTURE_WS,
      selector: "Echo",
      env: "LOCAL",
      url: target(),
      tls: undefined,
      tlsCerts: {},
      certBaseDir: FIXTURE_WS,
      timeoutMs: 10_000,
      runTimeoutMs: 0,
      scriptTimeoutMs: 5_000,
      iterationCount: undefined,
      iterationData: undefined,
      delayRequestMs: 0,
      vars: { mode: "TRANSPORT_FAIL" },
      save: false,
      preferDescriptor: false,
      bail: false,
      workingDir: undefined,
      insecureFileRead: false,
      safeEval: false,
      sink,
    });

    const failure = sink.events.find((event) => event.type === "response-failure");
    expect(failure?.message).toContain("handler exploded");
    expect(failure?.trailers).toContainEqual(["x-handled-by", "test-server"]);
  });

  it("givenUnreachableTarget_whenRun_thenReportsUnavailableWithinTheDeadline", async () => {
    const { code, stdout, stderr } = await runCli([
      "run",
      "Echo",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      "localhost:1",
      "--timeout",
      "2000",
      "--no-save",
      "--json",
    ]);

    expect(code).toBe(EXIT.TRANSPORT);
    const report = JSON.parse(stdout) as { ok: boolean; status: { name: string } };
    expect(report.ok).toBe(false);
    expect(["UNAVAILABLE", "DEADLINE_EXCEEDED"]).toContain(report.status.name);
    expect(stderr).toContain("--timeout now means the whole-run budget");
  });

  it("givenSelectorPointingAtANestedRequest_whenRun_thenTheNestedRequestIsInvoked", async () => {
    const { code } = await runCli([
      "run",
      "payment/nested/Deep Echo",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--no-save",
      "--json",
    ]);
    expect(code).toBe(EXIT.OK);
    expect(received[0]?.body.text).toBe("deep");
  });

  it("givenVerboseHumanOutput_whenRun_thenShowsScriptLogsTargetAndStatus", async () => {
    const { code, stdout } = await runCli([
      "run",
      "Echo",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--no-save",
      "-v",
    ]);

    expect(code).toBe(EXIT.OK);
    expect(stdout).toContain("payment/Echo");
    expect(stdout).toContain("test.echo.EchoService.Echo");
    expect(stdout).toContain(target());
    expect(stdout).toContain("plaintext");
    expect(stdout).toContain("proto-file");
    expect(stdout).toContain("generated trans_id");
    expect(stdout).toContain("x-request-id");
    expect(stdout).toContain("return_code");
  });

  it("givenSaveEnabled_whenScriptSetsAVariable_thenItIsPersistedWithCommentsIntact", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      const before = readFileSync(clone.workspace.postmanDir + "/environments/LOCAL.environment.yaml", "utf8");
      expect(before).toContain("# Local development environment.");

      const { code, stdout } = await runCli([
        "run",
        "Echo",
        "-d",
        clone.root,
        "-e",
        "LOCAL",
        "--url",
        target(),
        "--json",
      ]);
      expect(code).toBe(EXIT.OK);

      const report = JSON.parse(stdout) as { savedVars: Record<string, string>; savedTo: string };
      // trans_id comes from the beforeInvoke script, last_return_code from afterResponse:
      // the writeback has to happen after the post-response scripts to catch both.
      expect(Object.keys(report.savedVars)).toEqual(["trans_id", "last_return_code"]);
      expect(report.savedVars.last_return_code).toBe("OK");
      expect(report.savedTo).toContain("LOCAL.environment.yaml");

      const envPath = `${clone.workspace.postmanDir}/environments/LOCAL.environment.yaml`;
      const after = readFileSync(envPath, "utf8");
      expect(after).toContain("# Local development environment.");
      expect(loadEnvironment(envPath).values.trans_id).toBe(report.savedVars.trans_id);
      expect(report.savedVars.trans_id).toBe(received[0]?.body.trans_id);
      // A key the environment file did not have before is appended.
      expect(loadEnvironment(envPath).values.last_return_code).toBe("OK");
      // Untouched keys keep their values.
      expect(loadEnvironment(envPath).values.greeting).toBe("hello");
    } finally {
      clone.cleanup();
    }
  });

  it("givenNoSave_whenScriptSetsAVariable_thenTheFileIsUntouched", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      const envPath = `${clone.workspace.postmanDir}/environments/LOCAL.environment.yaml`;
      const before = readFileSync(envPath, "utf8");
      const { code } = await runCli([
        "run",
        "Echo",
        "-d",
        clone.root,
        "-e",
        "LOCAL",
        "--url",
        target(),
        "--no-save",
        "--json",
      ]);
      expect(code).toBe(EXIT.OK);
      expect(readFileSync(envPath, "utf8")).toBe(before);
    } finally {
      clone.cleanup();
    }
  });

  it("givenDescriptorOnlyRequest_whenRun_thenTheEmbeddedDescriptorIsUsed", async () => {
    // The target does not serve pe.aev2, so the call fails at the transport level —
    // but reaching that point proves the descriptor produced an invocable method.
    const { code, stdout } = await runCli([
      "run",
      "Descriptor Only",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--no-save",
      "--json",
    ]);

    expect(code).toBe(EXIT.TRANSPORT);
    const report = JSON.parse(stdout) as { schemaSource: string; status: { name: string }; warnings: string[] };
    expect(report.schemaSource).toBe("descriptor");
    expect(report.status.name).toBe("UNIMPLEMENTED");
    expect(report.warnings.join("\n")).toContain("stale or partial");
  });
});

interface TestReport {
  exitCode: number;
  ok: boolean;
  returnCode: string | null;
  warnings: string[];
  tests: Array<{ name: string; status: string; error: string | null }>;
  testSummary: { total: number; passed: number; failed: number; skipped: number };
}

/** Base args for a single-request run against the live fixture server. */
const runArgs = (selector: string, ...extra: string[]) => [
  "run",
  selector,
  "-d",
  FIXTURE_WS,
  "-e",
  "LOCAL",
  "--url",
  target(),
  "--no-save",
  ...extra,
];

describe("preman run (test scripts)", () => {
  it("givenPassingAfterResponseTests_whenRun_thenReportedAndExitStaysZero", async () => {
    const { code, stdout } = await runCli(runArgs("Echo", "--json"));

    expect(code).toBe(EXIT.OK);
    const report = JSON.parse(stdout) as TestReport;
    expect(report.tests.map((t) => [t.name, t.status])).toEqual([
      ["return_code is as expected", "passed"],
      ["grpc status is OK", "passed"],
    ]);
    expect(report.testSummary).toEqual({ total: 2, passed: 2, failed: 0, skipped: 0 });
  });

  it("givenFailingAssertion_whenCallAndReturnCodeAreFine_thenExitCodeIsFour", async () => {
    const { code, stdout } = await runCli(runArgs("Echo", "--var", "expected_code=NOPE", "--json"));

    expect(code).toBe(EXIT.TEST);
    const report = JSON.parse(stdout) as TestReport;
    // The call itself was perfectly fine; only the assertion failed.
    expect(report.ok).toBe(true);
    expect(report.returnCode).toBe("OK");
    expect(report.exitCode).toBe(EXIT.TEST);
    expect(report.testSummary).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0 });
    const failed = report.tests.find((t) => t.status === "failed");
    expect(failed?.name).toBe("return_code is as expected");
    expect(failed?.error).toContain("NOPE");
  });

  it("givenFailingAssertion_whenHumanOutput_thenTheFailureIsVisibleWithoutVerbose", async () => {
    const { stdout } = await runCli(runArgs("Echo", "--var", "expected_code=NOPE"));

    expect(stdout).toContain("return_code is as expected");
    expect(stdout).toContain("grpc status is OK");
    expect(stdout).toContain("2 tests");
    expect(stdout).toContain("1 passed");
    expect(stdout).toContain("1 failed");
  });

  it("givenOnMessageScript_whenRun_thenItRunsWithPmMessageBound", async () => {
    const { code, stdout } = await runCli(runArgs("Ping", "--json"));

    expect(code).toBe(EXIT.OK);
    const report = JSON.parse(stdout) as TestReport;
    expect(report.tests).toEqual([
      {
        name: "message echoes what we sent",
        status: "passed",
        error: null,
        origin: { level: "request", label: "request" },
      },
    ]);
  });

  it("givenBusinessFailureAndFailingTest_whenRun_thenBusinessOutranksTheTestFailure", async () => {
    const { code, stdout } = await runCli(runArgs("Echo", "--var", "mode=BUSINESS_FAIL", "--json"));

    // return_code is INVALID_ARGUMENT, so the afterResponse assertion fails too —
    // but the business failure is the more informative signal.
    expect(code).toBe(EXIT.BUSINESS);
    const report = JSON.parse(stdout) as TestReport;
    expect(report.returnCode).toBe("INVALID_ARGUMENT");
    expect(report.testSummary.failed).toBe(1);
  });

  it("givenTransportFailure_whenRun_thenPostResponseScriptsAreSkippedWithAWarning", async () => {
    const { code, stdout } = await runCli(runArgs("Echo", "--var", "mode=TRANSPORT_FAIL", "--json"));

    expect(code).toBe(EXIT.TRANSPORT);
    const report = JSON.parse(stdout) as TestReport;
    expect(report.tests).toEqual([]);
    expect(report.testSummary).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 });
    expect(report.warnings.join("\n")).toContain("afterResponse scripts skipped");
  });
});

describe("preman run (reporters)", () => {
  it("givenJunitReporterWithExport_whenRun_thenFileWrittenAndStdoutStillHuman", async () => {
    const clone = cloneFixtureWorkspace();
    const reportPath = `${clone.root}/junit.xml`;
    try {
      const { code, stdout } = await runCli([
        "run",
        "Echo",
        "-d",
        clone.root,
        "-e",
        "LOCAL",
        "--url",
        target(),
        "--no-save",
        "-r",
        "cli,junit",
        "--reporter-junit-export",
        reportPath,
      ]);

      expect(code).toBe(EXIT.OK);
      expect(stdout).toContain("payment/Echo");
      const xml = readFileSync(reportPath, "utf8");
      expect(xml).toContain('<testsuites name="preman" tests="2" failures="0" errors="0"');
      expect(xml).toContain('name="return_code is as expected"');
    } finally {
      clone.cleanup();
    }
  });

  it("givenJunitReporterWithoutExport_whenRun_thenXmlOnStdout", async () => {
    const { code, stdout } = await runCli(runArgs("Echo", "-r", "junit"));
    expect(code).toBe(EXIT.OK);
    expect(stdout).toMatch(/^<testsuites name="preman"/);
    expect(stdout).toContain('<testsuite name="payment/Echo"');
  });

  it("givenJsonFlagAndCliReporter_whenRun_thenRejectsBothStdoutReportersBeforeRunning", async () => {
    await expect(runCli(runArgs("Echo", "--json", "-r", "cli"))).rejects.toThrow(/"cli", "json".*stdout/);
    expect(received).toHaveLength(0);
  });

  it("givenFailingRun_whenJunitExported_thenExitCodeStillReflectsFailure", async () => {
    const clone = cloneFixtureWorkspace();
    const reportPath = `${clone.root}/failed.xml`;
    try {
      const { code } = await runCli([
        "run",
        "Echo",
        "-d",
        clone.root,
        "-e",
        "LOCAL",
        "--url",
        target(),
        "--no-save",
        "--var",
        "expected_code=NOPE",
        "-r",
        "junit",
        "--reporter-junit-export",
        reportPath,
      ]);
      expect(code).toBe(EXIT.TEST);
      expect(readFileSync(reportPath, "utf8")).toContain('failures="1"');
    } finally {
      clone.cleanup();
    }
  });

  it("givenUnwritableExportPath_whenRun_thenErrorNamesThePath", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      await expect(
        runCli([
          "run",
          "Echo",
          "-d",
          clone.root,
          "-e",
          "LOCAL",
          "--url",
          target(),
          "--no-save",
          "-r",
          "junit",
          "--reporter-junit-export",
          clone.root,
        ]),
      ).rejects.toThrow(`could not write reporter output to "${clone.root}"`);
    } finally {
      clone.cleanup();
    }
  });
});

describe("preman run (error paths)", () => {
  it("givenUnsupportedKind_whenRun_thenRejectedWithTheSupportedKinds", async () => {
    await expect(runCli(["run", "Legacy Http", "-d", FIXTURE_WS, "-e", "LOCAL", "--json"])).rejects.toThrow(
      /websocket-request, which preman does not support yet/,
    );
  });

  it("givenUnknownSelector_whenRun_thenListsAvailableRequests", async () => {
    try {
      await runCli(["run", "does-not-exist", "-d", FIXTURE_WS, "-e", "LOCAL"]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PremanError);
      expect((error as PremanError).details.join("\n")).toContain("payment/Echo");
    }
  });

  it("givenUnknownEnvironment_whenRun_thenListsAvailableEnvironments", async () => {
    await expect(runCli(["run", "Echo", "-d", FIXTURE_WS, "-e", "NOPE"])).rejects.toThrow(
      /environment "NOPE" not found/,
    );
  });

  it("givenAmbiguousSelectorAndNoTty_whenRun_thenListsCandidatesInsteadOfGuessing", async () => {
    // "Echo" matches payment/Echo exactly, so use a substring that hits several.
    try {
      await runCli(["run", "Ech", "-d", FIXTURE_WS, "-e", "LOCAL", "--url", target()]);
      expect.unreachable("should have thrown instead of picking one");
    } catch (error) {
      expect(error).toBeInstanceOf(PremanError);
      const details = (error as PremanError).details.join("\n");
      expect(details).toContain("payment/Echo");
      expect(details).toContain("payment/nested/Deep Echo");
    }
    expect(received).toHaveLength(0);
  });

  it("givenNoEnvironmentAtAll_whenRun_thenMissingVariablesFailBeforeAnyCall", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      // Without the environment file, {{greeting}} and {{mode}} are undefined.
      rmSync(`${clone.workspace.postmanDir}/environments`, { recursive: true, force: true });
      await expect(runCli(["run", "Echo", "-d", clone.root, "--url", target()])).rejects.toThrow(
        /could not resolve all variables in message body/,
      );
      expect(received).toHaveLength(0);
    } finally {
      clone.cleanup();
    }
  });

  it("givenMutuallyExclusiveTlsFlags_whenRun_thenRejected", async () => {
    await expect(runCli(["run", "Echo", "-d", FIXTURE_WS, "--tls", "--plaintext"])).rejects.toThrow(
      /mutually exclusive/,
    );
  });

  it.each([
    ["--timeout", "0"],
    ["--timeout", "abc"],
  ])("givenInvalidTimeout_whenRun_thenRejected: %s %s", async (flag, value) => {
    await expect(runCli(["run", "Echo", "-d", FIXTURE_WS, flag, value])).rejects.toThrow(/invalid --timeout/);
  });

  it("givenMalformedVar_whenRun_thenRejected", async () => {
    await expect(runCli(["run", "Echo", "-d", FIXTURE_WS, "--var", "novalue"])).rejects.toThrow(/expected key=value/);
  });
});

describe("exit-code classification", () => {
  it.each([
    [{ return_code: "OK" }, "OK", true],
    [{ returnCode: "OK" }, "OK", true],
    [{ return_code: "1" }, "1", true],
    [{ return_code: "INVALID_ARGUMENT" }, "INVALID_ARGUMENT", false],
    [{ return_code: "RETURN_CODE_UNSPECIFIED" }, "RETURN_CODE_UNSPECIFIED", false],
  ])("givenResponse_whenClassified_thenMatchesReturnCodeSemantics: %j", (response, expectedCode, success) => {
    expect(extractReturnCode(response)).toBe(expectedCode);
    expect(isBusinessSuccess(extractReturnCode(response))).toBe(success);
  });

  it("givenResponseWithoutReturnCode_whenClassified_thenTreatedAsNeutral", () => {
    expect(extractReturnCode({ other: 1 })).toBeUndefined();
    expect(extractReturnCode(null)).toBeUndefined();
    expect(extractReturnCode("string")).toBeUndefined();
    // A missing return_code must not by itself mark the run as a business failure.
    expect(isBusinessSuccess(undefined)).toBe(false);
  });
});

describe("preman list / env", () => {
  it("givenFixtureWorkspace_whenListing_thenGroupsRequestsAndFlagsUnsupportedKinds", async () => {
    const { code, stdout } = await runCli(["list", "-d", FIXTURE_WS, "-v"]);
    expect(code).toBe(EXIT.OK);
    expect(stdout).toContain("payment");
    expect(stdout).toContain("Echo");
    expect(stdout).toContain("websocket-request");
    expect(stdout).toContain("LOCAL");
    expect(stdout).toContain("echo.proto");
  });

  it("givenJsonList_whenListing_thenEmitsRequestsAndEnvironments", async () => {
    const { stdout } = await runCli(["list", "-d", FIXTURE_WS, "--json"]);
    const report = JSON.parse(stdout) as { requests: Array<{ path: string; kind: string }>; environments: unknown[] };
    expect(report.requests.map((r) => r.path)).toEqual([
      "payment/Ping",
      "payment/Echo",
      "payment/Legacy Http",
      "payment/Descriptor Only",
      "payment/nested/Deep Echo",
    ]);
    expect(report.environments).toHaveLength(1);
  });

  it("givenEnvShow_whenRun_thenPrintsResolvedValues", async () => {
    const { code, stdout } = await runCli(["env", "show", "-d", FIXTURE_WS, "-e", "LOCAL", "--json"]);
    expect(code).toBe(EXIT.OK);
    const report = JSON.parse(stdout) as { values: Record<string, string> };
    expect(report.values.greeting).toBe("hello");
    // Disabled rows are not part of the resolved set.
    expect(report.values.disabled_var).toBeUndefined();
  });

  it("givenEnvSet_whenRun_thenPersistsToTheClonedWorkspace", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      const { code } = await runCli(["env", "set", "greeting", "howdy", "-d", clone.root, "-e", "LOCAL"]);
      expect(code).toBe(EXIT.OK);
      const envPath = `${clone.workspace.postmanDir}/environments/LOCAL.environment.yaml`;
      expect(loadEnvironment(envPath).values.greeting).toBe("howdy");
      expect(readFileSync(envPath, "utf8")).toContain("# Local development environment.");
    } finally {
      clone.cleanup();
    }
  });

  it("givenNoArgs_whenRun_thenPrintsHelpAndExitsOne", async () => {
    const { code, stdout } = await runCli([]);
    expect(code).toBe(EXIT.CLI);
    expect(stdout).toContain("usage");
  });

  it("givenHelpFlag_whenRun_thenPrintsHelpAndExitsZero", async () => {
    const { code, stdout } = await runCli(["--help"]);
    expect(code).toBe(EXIT.OK);
    expect(stdout).toContain("preman");
  });

  it("givenVersionFlag_whenRun_thenPrintsVersion", async () => {
    const { stdout } = await runCli(["--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("givenUnknownCommand_whenRun_thenRejected", async () => {
    await expect(runCli(["nope", "-d", FIXTURE_WS])).rejects.toThrow(/unknown command "nope"/);
  });

  it("givenUnknownFlag_whenRun_thenRejectedWithUsageHint", async () => {
    await expect(runCli(["list", "--bogus"])).rejects.toThrow(PremanError);
  });
});

interface GroupReport {
  group: string;
  iterations: number;
  items: Array<{
    request: { path: string; kind: string };
    status: string;
    error: { message: string; details: string[] } | null;
    run: { request_message: EchoRequest; returnCode: string | null; status: { name: string } } | null;
    iteration: number;
  }>;
  bailed: boolean;
  bailReason: string | null;
  tests: { total: number; passed: number; failed: number; skipped: number };
  savedVars: Record<string, string>;
  savedTo: string | null;
  exitCode: number;
}

describe("preman run <collection> (whole-collection runs)", () => {
  it("givenCollectionSelector_whenRun_thenEveryRequestRunsInOrder", async () => {
    const { code, stdout } = await runCli([
      "run",
      "payment",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--no-save",
      "--json",
    ]);

    const report = JSON.parse(stdout) as GroupReport;
    expect(report.group).toBe("payment");
    expect(report.items.map((i) => i.request.path)).toEqual([
      "payment/Ping",
      "payment/Echo",
      "payment/Legacy Http",
      "payment/Descriptor Only",
      "payment/nested/Deep Echo",
    ]);

    // Legacy Http is skipped as an unsupported kind and Descriptor Only targets a
    // server that does not serve pe.aev2; neither stops the rest of the run.
    expect(report.items.map((i) => i.status)).toEqual(["ok", "ok", "skipped", "transport", "ok"]);
    expect(report.bailed).toBe(false);
    expect(report.tests).toEqual({ total: 3, passed: 3, failed: 0, skipped: 0 });

    // The transport failure is the worst outcome, so it decides the exit code.
    expect(report.exitCode).toBe(EXIT.TRANSPORT);
    expect(code).toBe(EXIT.TRANSPORT);

    // Every runnable request actually hit the wire, in order.
    expect(received.map((r) => r.method)).toEqual(["Ping", "Echo", "Echo"]);
    expect(received[2]?.body.text).toBe("deep");
  });

  it("givenRequestThatCannotRun_whenInAGroup_thenItIsAnErrorItemAndOutranksTransport", async () => {
    // `--descriptor` forces the embedded-descriptor path, which only one fixture
    // request has — the others fail before reaching the wire.
    const { code, stdout } = await runCli([
      "run",
      "payment",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--descriptor",
      "--no-save",
      "--json",
    ]);

    const report = JSON.parse(stdout) as GroupReport;
    expect(report.items.map((i) => i.status)).toEqual(["error", "error", "skipped", "transport", "error"]);
    expect(report.items[0]?.error?.message).toContain("no usable schema");
    // A hard error outranks a transport failure: the run itself is misconfigured.
    expect(report.exitCode).toBe(EXIT.CLI);
    expect(code).toBe(EXIT.CLI);
    expect(received).toHaveLength(0);
  });

  it("givenFolderSelector_whenRun_thenOnlyThatFolderRuns", async () => {
    const { code, stdout } = await runCli([
      "run",
      "payment/nested",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--no-save",
      "--json",
    ]);

    expect(code).toBe(EXIT.OK);
    const report = JSON.parse(stdout) as GroupReport;
    expect(report.group).toBe("payment/nested");
    expect(report.items).toHaveLength(1);
    expect(report.items[0]?.request.path).toBe("payment/nested/Deep Echo");
    expect(received).toHaveLength(1);
  });

  it("givenIterationCountTwoOverDataFile_whenRunningFolder_thenServerSeesEachRowOnce", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      const request = collectionPath(clone.root, "payment", "nested", "Deep Echo.request.yaml");
      writeFileSync(request, readFileSync(request, "utf8").replace('"text": "deep"', '"text": "{{msisdn}}"'));

      const { code, stdout } = await runCli([
        "run",
        "payment/nested",
        "-d",
        clone.root,
        "-e",
        "LOCAL",
        "--url",
        target(),
        "--iteration-count",
        "2",
        "--iteration-data",
        dataPath("users.json"),
        "--no-save",
        "--json",
      ]);

      expect(code).toBe(EXIT.OK);
      const report = JSON.parse(stdout) as GroupReport;
      expect(report.iterations).toBe(2);
      expect(report.items.map((item) => item.iteration)).toEqual([0, 1]);
      expect(received.map((item) => item.body.text)).toEqual(["84900000001", "84900000002"]);
    } finally {
      clone.cleanup();
    }
  });

  it("givenIterationCountThree_whenFolderRuns_thenStoreIsSharedAcrossPasses", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment/nested",
        definitionWithScript(
          "nested",
          "grpc:beforeInvoke",
          [
            'const seen = Number(pm.environment.get("seen") || "0") + 1;',
            'pm.environment.set("seen", seen);',
            "const message = JSON.parse(pm.request.body.raw);",
            "message.text = String(seen);",
            "pm.request.body.raw = JSON.stringify(message);",
          ].join("\n"),
        ),
      );

      const { code } = await runCli([
        "run",
        "payment/nested",
        "-d",
        clone.root,
        "-e",
        "LOCAL",
        "--url",
        target(),
        "-n",
        "3",
        "--no-save",
        "--json",
      ]);

      expect(code).toBe(EXIT.OK);
      expect(received.map((item) => item.body.text)).toEqual(["1", "2", "3"]);
    } finally {
      clone.cleanup();
    }
  });

  it("givenBailAndFailureInFirstIteration_whenFolderRuns_thenSecondIterationNeverStarts", async () => {
    const { code, stdout } = await runCli([
      "run",
      "payment/nested",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--var",
      "mode=BUSINESS_FAIL",
      "-n",
      "2",
      "--bail",
      "--no-save",
      "--json",
    ]);

    const report = JSON.parse(stdout) as GroupReport;
    expect(code).toBe(EXIT.BUSINESS);
    expect(report.iterations).toBe(1);
    expect(report.items.map((item) => item.iteration)).toEqual([0]);
    expect(report.bailReason).toBe("bail-flag");
    expect(received).toHaveLength(1);
  });

  it("givenIterationCount_whenSingleRequestSelected_thenPremanError", async () => {
    await expect(runCli(["run", "Echo", "-d", FIXTURE_WS, "-n", "2"])).rejects.toThrow(
      /iterations require a collection or folder/,
    );
    expect(received).toHaveLength(0);
  });

  it("givenRunBudgetExpiresBetweenIterations_whenFolderRuns_thenStopsWithTimeoutReason", async () => {
    const { code, stdout, stderr } = await runCli([
      "run",
      "payment/nested",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "-n",
      "2",
      "--delay-request",
      "20",
      "--timeout",
      "1",
      "--timeout-request",
      "30000",
      "--no-save",
      "--json",
    ]);

    const report = JSON.parse(stdout) as GroupReport;
    expect(code).toBe(EXIT.TRANSPORT);
    expect(report.items).toHaveLength(1);
    expect(report.bailReason).toBe("timeout");
    expect(received).toHaveLength(1);
    expect(stderr).not.toContain("--timeout now means the whole-run budget");
  });

  it("givenBusinessFailureInGroup_whenRun_thenAggregateExitIsThree", async () => {
    const { code, stdout } = await runCli([
      "run",
      "nested",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--var",
      "mode=BUSINESS_FAIL",
      "--no-save",
      "--json",
    ]);

    expect(code).toBe(EXIT.BUSINESS);
    const report = JSON.parse(stdout) as GroupReport;
    expect(report.items[0]?.status).toBe("business");
    expect(report.items[0]?.run?.returnCode).toBe("INVALID_ARGUMENT");
  });

  it("givenBail_whenAnEarlyRequestFails_thenTheRestAreNotRun", async () => {
    const { code, stdout } = await runCli([
      "run",
      "payment",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--bail",
      "--no-save",
      "--json",
    ]);

    expect(code).toBe(EXIT.TRANSPORT);
    const report = JSON.parse(stdout) as GroupReport;
    // Descriptor Only is the 4th request and the first failure, so Deep Echo,
    // which follows it, is never attempted. A skip does not trip --bail.
    expect(report.bailed).toBe(true);
    expect(report.items.map((i) => i.status)).toEqual(["ok", "ok", "skipped", "transport"]);
    expect(received.map((r) => r.method)).toEqual(["Ping", "Echo"]);
  });

  it("givenSkippedRequest_whenRun_thenItsKindIsReported", async () => {
    const { stdout } = await runCli([
      "run",
      "payment",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--no-save",
      "--json",
    ]);

    const report = JSON.parse(stdout) as GroupReport;
    const skipped = report.items.find((i) => i.status === "skipped");
    expect(skipped?.request.kind).toBe("websocket-request");
    expect(skipped?.error?.message).toContain("not supported yet");
    expect(skipped?.run).toBeNull();
  });

  it("givenCollectionRun_whenScriptsSetVariables_thenTheyCarryToLaterRequestsAndSaveOnce", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      const envPath = `${clone.workspace.postmanDir}/environments/LOCAL.environment.yaml`;
      const { stdout } = await runCli(["run", "payment", "-d", clone.root, "-e", "LOCAL", "--url", target(), "--json"]);

      const report = JSON.parse(stdout) as GroupReport;
      // Echo's script sets trans_id; Deep Echo runs later with the same store, so
      // the value is written once, at the end, and matches what Echo sent.
      expect(Object.keys(report.savedVars)).toEqual(["trans_id", "last_return_code"]);
      // received[0] is Ping; received[1] is Echo, the request whose script ran.
      expect(report.savedVars.trans_id).toBe(received[1]?.body.trans_id);
      expect(report.savedTo).toContain("LOCAL.environment.yaml");
      // Deep Echo ran after Echo with the same store, so it sent Echo's trans_id.
      expect(received[2]?.body.trans_id).toBe(report.savedVars.trans_id);
      expect(loadEnvironment(envPath).values.trans_id).toBe(report.savedVars.trans_id);
      expect(readFileSync(envPath, "utf8")).toContain("# Local development environment.");
    } finally {
      clone.cleanup();
    }
  });

  it("givenCollectionRun_whenHuman_thenPrintsATableAndCounts", async () => {
    const { stdout } = await runCli([
      "run",
      "payment",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--no-save",
    ]);

    expect(stdout).toContain("payment");
    expect(stdout).toContain("5 requests");
    expect(stdout).toContain("payment/Echo");
    expect(stdout).toContain("skipped");
    expect(stdout).toContain("3 ok");
    expect(stdout).toContain("1 failed");
    expect(stdout).toContain("1 skipped");
  });

  it("givenVerboseCollectionRun_whenHuman_thenEachRequestGetsAFullReport", async () => {
    const { stdout } = await runCli([
      "run",
      "payment/nested",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--no-save",
      "-v",
    ]);

    expect(stdout).toContain("request body:");
    expect(stdout).toContain("test.echo.EchoService.Echo");
    expect(stdout).toContain("1 request");
  });

  it("givenFailingTestInGroup_whenRun_thenTheItemIsATestFailureAndTransportStillOutranksIt", async () => {
    const { code, stdout } = await runCli([
      "run",
      "payment",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--no-save",
      "--var",
      "expected_code=NOPE",
      "--json",
    ]);

    const report = JSON.parse(stdout) as GroupReport;
    expect(report.items.map((i) => i.status)).toEqual(["ok", "test", "skipped", "transport", "ok"]);
    // Descriptor Only still fails at the transport level, which outranks a test failure.
    expect(report.exitCode).toBe(EXIT.TRANSPORT);
    expect(code).toBe(EXIT.TRANSPORT);
  });

  it("givenBail_whenATestFails_thenTheRunStopsAndExitsFour", async () => {
    const { code, stdout } = await runCli([
      "run",
      "payment",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--no-save",
      "--var",
      "expected_code=NOPE",
      "--bail",
      "--json",
    ]);

    const report = JSON.parse(stdout) as GroupReport;
    // Ping passes, Echo's assertion fails, and nothing after it runs.
    expect(report.items.map((i) => [i.request.path, i.status])).toEqual([
      ["payment/Ping", "ok"],
      ["payment/Echo", "test"],
    ]);
    expect(report.bailed).toBe(true);
    expect(report.exitCode).toBe(EXIT.TEST);
    expect(code).toBe(EXIT.TEST);
    expect(received.map((r) => r.method)).toEqual(["Ping", "Echo"]);
  });

  it("givenFailingTestInGroup_whenHuman_thenTheFailedAssertionIsListedInline", async () => {
    const { stdout } = await runCli([
      "run",
      "payment/nested",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--no-save",
    ]);
    // Sanity: the nested folder's inherited script only sets a variable, so no
    // test suffix should appear.
    expect(stdout).not.toContain("tests");

    const { stdout: withTests } = await runCli([
      "run",
      "payment",
      "-d",
      FIXTURE_WS,
      "-e",
      "LOCAL",
      "--url",
      target(),
      "--no-save",
      "--var",
      "expected_code=NOPE",
    ]);

    expect(withTests).toContain("1 with failed tests");
    expect(withTests).toContain("return_code is as expected");
    expect(withTests).toContain("1/2 tests");
    expect(withTests).toContain("3 assertions");
    expect(withTests).toContain("2 passed");
    expect(withTests).toContain("1 failed");
  });
});

interface RunReport {
  warnings: string[];
  console: Array<{ level: string; text: string; origin: { level: string; label: string } }>;
  tests: Array<{ name: string; status: string; origin: { level: string; label: string } }>;
  request_metadata: Record<string, string | string[]>;
  request_message: EchoRequest;
}

/** Overwrite a group's `definition.yaml` inside a clone. */
function writeDefinition(root: string, group: string, body: string): void {
  writeFileSync(definitionPath(root, ...group.split("/")), body);
}

/** A group definition carrying nothing but the given script. */
function definitionWithScript(name: string, type: string, code: string): string {
  const indented = code
    .trimEnd()
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
  return `$kind: collection\nname: ${name}\nscripts:\n  - type: ${type}\n    code: |\n${indented}\n`;
}

/** A group definition carrying nothing but the given `auth:` block. */
function definitionWithAuth(name: string, auth: string): string {
  return `$kind: collection\nname: ${name}\nauth:\n${auth}`;
}

/** Append extra top-level YAML keys to a request file inside a clone. */
function appendToRequest(root: string, request: string, yaml: string): void {
  appendFileSync(collectionPath(root, ...request.split("/")) + ".request.yaml", yaml);
}

function writeScriptedGrpcRequest(
  root: string,
  options: { script: string; methodPath?: string; body?: string; metadata?: string },
): void {
  const script = options.script
    .trimEnd()
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
  const body = (options.body ?? '{"text":"original","mode":"SUCCEED"}')
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
  writeFileSync(
    collectionPath(root, "payment", "Echo") + ".request.yaml",
    [
      "$kind: grpc-request",
      "name: Echo",
      'url: "{{grpc_url}}"',
      `methodPath: ${options.methodPath ?? "test.echo.EchoService.Echo"}`,
      "message:",
      "  content: |-",
      body,
      "schema:",
      "  source: file",
      "  location: ../../../src/main/proto/echo/echo.proto",
      options.metadata ?? "",
      "scripts:",
      "  - type: beforeInvoke",
      "    code: |",
      script,
      "order: 20",
      "",
    ].join("\n"),
  );
}

const deepEcho = (root: string, extra: string[] = []) => [
  "run",
  "Deep Echo",
  "-d",
  root,
  "-e",
  "LOCAL",
  "--url",
  target(),
  "--no-save",
  "--json",
  ...extra,
];

const paymentGroup = (root: string, extra: string[] = []) => [
  "run",
  "payment",
  "-d",
  root,
  "-e",
  "LOCAL",
  "--url",
  target(),
  "--no-save",
  "--json",
  ...extra,
];

describe("group-level scripts (gRPC)", () => {
  it("givenFolderScript_whenRequestRunsAlone_thenInheritedScriptStillRuns", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment/nested",
        definitionWithScript(
          "nested",
          "grpc:beforeInvoke",
          'const body = JSON.parse(pm.request.body.raw); body.trans_id = "from-folder"; pm.request.body.raw = JSON.stringify(body);',
        ),
      );

      const { code } = await runCli(deepEcho(clone.root));

      expect(code).toBe(EXIT.OK);
      // Postman runs a folder script for a single-request run too (decision 1).
      expect(received[0]?.body.trans_id).toBe("from-folder");
    } finally {
      clone.cleanup();
    }
  });

  it("givenCollectionAndFolderAndRequestScripts_whenRun_thenOrderIsOuterToInner", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment",
        definitionWithScript("payment", "grpc:beforeInvoke", 'console.log("mark:collection");'),
      );
      writeDefinition(
        clone.root,
        "payment/nested",
        definitionWithScript("nested", "grpc:beforeInvoke", 'console.log("mark:folder");'),
      );
      appendToRequest(
        clone.root,
        "payment/nested/Deep Echo",
        'scripts:\n  - type: beforeInvoke\n    code: |\n      console.log("mark:request");\n',
      );

      const { stdout } = await runCli(deepEcho(clone.root));

      const report = JSON.parse(stdout) as RunReport;
      expect(report.console.map((line) => line.text)).toEqual(["mark:collection", "mark:folder", "mark:request"]);
    } finally {
      clone.cleanup();
    }
  });

  it("givenInheritedScriptLogs_whenJson_thenOriginIsReported", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment/nested",
        definitionWithScript("nested", "grpc:beforeInvoke", 'console.log("from the folder");'),
      );

      const { stdout } = await runCli(deepEcho(clone.root));

      const report = JSON.parse(stdout) as RunReport;
      expect(report.console[0]?.origin).toEqual({ level: "folder", label: "folder nested" });
    } finally {
      clone.cleanup();
    }
  });

  it("givenInheritedScriptLogs_whenVerbose_thenLineIsTaggedWithOrigin", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment/nested",
        definitionWithScript("nested", "grpc:beforeInvoke", 'console.log("from the folder");'),
      );

      const { stdout } = await runCli([
        "run",
        "Deep Echo",
        "-d",
        clone.root,
        "-e",
        "LOCAL",
        "--url",
        target(),
        "--no-save",
        "-v",
      ]);

      expect(stdout).toContain("script log [folder nested]: from the folder");
      // Decision 8: request-level lines keep the untagged format.
      expect(stdout).not.toContain("script log [request]");
    } finally {
      clone.cleanup();
    }
  });

  it("givenUnprefixedGroupScript_whenRun_thenWarnsAndSkips", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment/nested",
        definitionWithScript("nested", "beforeInvoke", 'console.log("never runs");'),
      );

      const { code, stdout } = await runCli(deepEcho(clone.root));

      expect(code).toBe(EXIT.OK);
      const report = JSON.parse(stdout) as RunReport;
      expect(report.warnings).toEqual([
        'folder nested script type "beforeInvoke" has no protocol prefix, so it was not run ' +
          '(expected "grpc:<event>" or "http:<event>")',
      ]);
      expect(report.console).toEqual([]);
    } finally {
      clone.cleanup();
    }
  });

  it("givenUnknownEventInGroupScript_whenRun_thenWarnsAndSkips", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment/nested",
        definitionWithScript("nested", "grpc:onLunarEclipse", 'console.log("never runs");'),
      );

      const { code, stdout } = await runCli(deepEcho(clone.root));

      expect(code).toBe(EXIT.OK);
      const report = JSON.parse(stdout) as RunReport;
      expect(report.warnings[0]).toMatch(/^folder nested script type "grpc:onLunarEclipse" is not recognised/);
      expect(report.console).toEqual([]);
    } finally {
      clone.cleanup();
    }
  });

  it("givenInheritedPreScriptThrows_whenGroupRuns_thenGroupAbortsImmediately", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment",
        definitionWithScript("payment", "grpc:beforeInvoke", 'throw new Error("shared login broke");'),
      );

      const { code, stdout } = await runCli(paymentGroup(clone.root));

      const report = JSON.parse(stdout) as GroupReport;
      // Decision 6: a broken shared precondition stops the group at the first request
      // instead of printing the same failure once per request.
      expect(report.items.map((i) => [i.request.path, i.status])).toEqual([["payment/Ping", "error"]]);
      expect(report.items[0]?.error?.message).toContain("collection payment script");
      expect(report.items[0]?.error?.message).toContain("shared login broke");
      expect(report.bailed).toBe(true);
      expect(report.bailReason).toBe("inherited-script");
      expect(report.exitCode).toBe(EXIT.CLI);
      expect(code).toBe(EXIT.CLI);
      expect(received).toHaveLength(0);
    } finally {
      clone.cleanup();
    }
  });

  /**
   * The carve-out decision 041 does not make. A request's own post-response throw is one
   * failed assertion about a response it can still report; an inherited one is the same broken
   * shared precondition it was before the response arrived, so decision 6 still stops the group.
   */
  it("givenInheritedPostScriptThrows_whenGroupRuns_thenGroupStillAbortsAfterTheResponse", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment",
        definitionWithScript("payment", "grpc:afterResponse", 'throw new Error("shared teardown broke");'),
      );

      const { code, stdout } = await runCli(paymentGroup(clone.root));

      const report = JSON.parse(stdout) as GroupReport;
      expect(report.items.map((i) => [i.request.path, i.status])).toEqual([["payment/Ping", "error"]]);
      expect(report.items[0]?.error?.message).toContain("collection payment script");
      expect(report.items[0]?.error?.message).toContain("shared teardown broke");
      expect(report.bailReason).toBe("inherited-script");
      expect(code).toBe(EXIT.CLI);
      // The call itself went out - this aborts on the way back, not on the way in.
      expect(received).toHaveLength(1);
    } finally {
      clone.cleanup();
    }
  });

  it("givenInheritedAbort_whenHuman_thenTheSummaryExplainsItWasNotBail", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment",
        definitionWithScript("payment", "grpc:beforeInvoke", 'throw new Error("shared login broke");'),
      );

      const { stdout } = await runCli([
        "run",
        "payment",
        "-d",
        clone.root,
        "-e",
        "LOCAL",
        "--url",
        target(),
        "--no-save",
      ]);

      expect(stdout).toContain("aborted: collection payment script");
      expect(stdout).not.toContain("stopped early: --bail");
    } finally {
      clone.cleanup();
    }
  });

  it("givenInheritedTestFails_whenGroupRuns_thenRemainingRequestsStillRun", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment",
        definitionWithScript(
          "payment",
          "grpc:afterResponse",
          'pm.test("shared assertion", function () { pm.expect(1).to.equal(2); });',
        ),
      );

      const { stdout } = await runCli(paymentGroup(clone.root));

      const report = JSON.parse(stdout) as GroupReport;
      // Decision 7: a failing assertion is a result, not a broken precondition.
      expect(report.items.map((i) => i.status)).toEqual(["test", "test", "skipped", "transport", "test"]);
      expect(report.bailed).toBe(false);
      expect(report.bailReason).toBeNull();
      expect(received.map((r) => r.method)).toEqual(["Ping", "Echo", "Echo"]);
    } finally {
      clone.cleanup();
    }
  });

  it("givenRequestScriptThrows_whenGroupRuns_thenOnlyThatRequestErrors", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      // Ping already declares an `onMessage` script, so the file is rewritten rather
      // than appended to — a second `scripts:` key would be invalid YAML.
      writeFileSync(
        collectionPath(clone.root, "payment", "Ping.request.yaml"),
        [
          "$kind: grpc-request",
          "name: Ping",
          'url: "{{grpc_url}}"',
          "methodPath: test.echo.EchoService.Ping",
          "message:",
          "  content: |-",
          '    { "text": "ping" }',
          "schema:",
          "  source: file",
          "  location: ../../../src/main/proto/echo/echo.proto",
          "scripts:",
          "  - type: beforeInvoke",
          "    code: |",
          '      throw new Error("just this one");',
          "order: 10",
          "",
        ].join("\n"),
      );

      const { code, stdout } = await runCli(paymentGroup(clone.root));

      const report = JSON.parse(stdout) as GroupReport;
      expect(report.items.map((i) => i.status)).toEqual(["error", "ok", "skipped", "transport", "ok"]);
      expect(report.items[0]?.error?.message).toBe('script "beforeInvoke" failed: just this one');
      expect(report.bailed).toBe(false);
      expect(code).toBe(EXIT.CLI);
    } finally {
      clone.cleanup();
    }
  });

  it("givenTransportFailure_whenInheritedAfterResponseExists_thenSkipWarningMentionsIt", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment",
        definitionWithScript("payment", "grpc:afterResponse", 'console.log("never reached");'),
      );

      const { code, stdout } = await runCli([
        "run",
        "Descriptor Only",
        "-d",
        clone.root,
        "-e",
        "LOCAL",
        "--url",
        target(),
        "--no-save",
        "--json",
      ]);

      expect(code).toBe(EXIT.TRANSPORT);
      const report = JSON.parse(stdout) as RunReport;
      expect(report.warnings).toContain("afterResponse scripts skipped: the call failed at the transport level");
    } finally {
      clone.cleanup();
    }
  });

  it("givenPingRequestScript_whenGrpcPrefixedAtGroupLevel_thenBothStagesInherit", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment/nested",
        `$kind: collection\nname: nested\nscripts:\n` +
          `  - type: grpc:beforeInvoke\n    code: |\n      console.log("pre");\n` +
          `  - type: grpc:afterResponse\n    code: |\n      pm.test("post ran", function () { pm.expect(true).to.be.true; });\n`,
      );

      const { code, stdout } = await runCli(deepEcho(clone.root));

      expect(code).toBe(EXIT.OK);
      const report = JSON.parse(stdout) as RunReport;
      expect(report.console.map((l) => l.text)).toEqual(["pre"]);
      expect(report.tests).toEqual([
        { name: "post ran", status: "passed", error: null, origin: { level: "folder", label: "folder nested" } },
      ]);
    } finally {
      clone.cleanup();
    }
  });
});

describe("mutable pm.request (gRPC)", () => {
  it("givenGrpcPreRequestScriptSettingMetadata_whenRun_thenServerReceivesMetadata", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeScriptedGrpcRequest(clone.root, { script: 'pm.request.metadata.upsert("X-Scripted", "yes");' });
      const { code } = await runCli(runArgs("Echo", "-d", clone.root, "--json"));
      expect(code).toBe(EXIT.OK);
      expect(received[0]?.metadata["x-scripted"]).toBe("yes");
    } finally {
      clone.cleanup();
    }
  });

  it("givenGrpcPreRequestScriptEditingBody_whenRun_thenServerReceivesEditedMessage", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeScriptedGrpcRequest(clone.root, {
        script:
          'const body = JSON.parse(pm.request.body.raw); body.text = "edited"; pm.request.body.raw = JSON.stringify(body);',
      });
      const { code } = await runCli(runArgs("Echo", "-d", clone.root, "--json"));
      expect(code).toBe(EXIT.OK);
      expect(received[0]?.body.text).toBe("edited");
    } finally {
      clone.cleanup();
    }
  });

  it("givenGrpcPreRequestScriptWritingInvalidJson_whenRun_thenErrorNamesScripts", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeScriptedGrpcRequest(clone.root, { script: 'pm.request.body.raw = "not json";' });
      await expect(runCli(runArgs("Echo", "-d", clone.root, "--json"))).rejects.toThrow(
        /not valid JSON after pre-request scripts/,
      );
      expect(received).toHaveLength(0);
    } finally {
      clone.cleanup();
    }
  });

  it("givenGrpcPreRequestScriptChangingMethodPath_whenRun_thenOtherMethodInvoked", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeScriptedGrpcRequest(clone.root, { script: 'pm.request.methodPath = "test.echo.EchoService.Ping";' });
      const { code } = await runCli(runArgs("Echo", "-d", clone.root, "--json"));
      expect(code).toBe(EXIT.OK);
      expect(received[0]?.method).toBe("Ping");
    } finally {
      clone.cleanup();
    }
  });

  it("givenGrpcPreRequestScriptAddingDuplicateMetadata_whenRun_thenEveryValueReachesTheServer", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeScriptedGrpcRequest(clone.root, {
        script: 'pm.request.metadata.add("X-Repeat", "one"); pm.request.metadata.add("x-repeat", "two");',
      });
      const { code, stdout } = await runCli(runArgs("Echo", "-d", clone.root, "--json"));
      const report = JSON.parse(stdout) as RunReport;

      expect(code).toBe(EXIT.OK);
      // grpc-js preserves both string values and joins them with a comma on the wire.
      expect(received[0]?.metadata["x-repeat"]).toBe("one, two");
      expect(report.request_metadata["x-repeat"]).toEqual(["one", "two"]);
    } finally {
      clone.cleanup();
    }
  });

  it("givenDisabledGrpcMetadata_whenScriptReadsIt_thenItDoesNotReachTheServer", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeScriptedGrpcRequest(clone.root, {
        metadata: "metadata:\n  - key: X-Disabled\n    value: hidden\n    disabled: true",
        script: [
          'const entry = pm.request.metadata.all().find((item) => item.key === "X-Disabled");',
          'if (!entry || entry.disabled !== true) throw new Error("disabled metadata missing");',
        ].join("\n"),
      });
      const { code } = await runCli(runArgs("Echo", "-d", clone.root, "--json"));

      expect(code).toBe(EXIT.OK);
      expect(received[0]?.metadata["x-disabled"]).toBeUndefined();
    } finally {
      clone.cleanup();
    }
  });

  /**
   * The map shape has always been legal for HTTP headers, and real gRPC exports write metadata
   * the same way. Reading only the array meant such a request parsed as a shape error, so it
   * could be opened and edited in the desktop app but never run or saved.
   */
  it("givenMapShapedGrpcMetadata_whenRun_thenItReachesTheWireInterpolated", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeScriptedGrpcRequest(clone.root, {
        metadata: 'metadata:\n  client-id: "{{greeting}}"\n  x-plain: literal',
        script: "// nothing",
      });
      const { code } = await runCli(runArgs("Echo", "-d", clone.root, "--json"));

      expect(code).toBe(EXIT.OK);
      expect(received[0]?.metadata["x-plain"]).toBe("literal");
      expect(received[0]?.metadata["client-id"]).toBe("hello");
    } finally {
      clone.cleanup();
    }
  });
});

describe("group-level auth (gRPC)", () => {
  it("givenGrpcBearerAuth_whenRun_thenAuthorizationMetadataOnTheWire", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment/nested",
        definitionWithAuth("nested", "  type: bearer\n  credentials:\n    token: folder-token\n"),
      );

      const { code, stdout } = await runCli(deepEcho(clone.root));

      expect(code).toBe(EXIT.OK);
      expect(received[0]?.metadata.authorization).toBe("Bearer folder-token");
      const report = JSON.parse(stdout) as RunReport;
      expect(report.warnings).toContain("auth inherited from folder nested");
      expect(report.request_metadata.authorization).toBe("Bearer folder-token");
    } finally {
      clone.cleanup();
    }
  });

  it("givenGrpcBasicAuth_whenRun_thenCredentialsAreBase64Encoded", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment/nested",
        definitionWithAuth("nested", "  type: basic\n  credentials:\n    username: bob\n    password: s3cret\n"),
      );

      const { code } = await runCli(deepEcho(clone.root));

      expect(code).toBe(EXIT.OK);
      const expected = `Basic ${Buffer.from("bob:s3cret").toString("base64")}`;
      expect(received[0]?.metadata.authorization).toBe(expected);
    } finally {
      clone.cleanup();
    }
  });

  it("givenRequestNoauth_whenFolderDeclaresAuth_thenUnauthenticated", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment/nested",
        definitionWithAuth("nested", "  type: bearer\n  credentials:\n    token: folder-token\n"),
      );
      appendToRequest(clone.root, "payment/nested/Deep Echo", "auth:\n  type: noauth\n");

      const { code } = await runCli(deepEcho(clone.root));

      expect(code).toBe(EXIT.OK);
      expect(received[0]?.metadata.authorization).toBeUndefined();
    } finally {
      clone.cleanup();
    }
  });

  it("givenGrpcExplicitAuthorizationMetadata_whenAuthBlockPresent_thenMetadataWinsWithWarning", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment/nested",
        definitionWithAuth("nested", "  type: bearer\n  credentials:\n    token: folder-token\n"),
      );
      appendToRequest(
        clone.root,
        "payment/nested/Deep Echo",
        "metadata:\n  - key: authorization\n    value: Bearer explicit\n",
      );

      const { code, stdout } = await runCli(deepEcho(clone.root));

      expect(code).toBe(EXIT.OK);
      expect(received[0]?.metadata.authorization).toBe("Bearer explicit");
      const report = JSON.parse(stdout) as RunReport;
      expect(report.warnings).toContain('request metadata "authorization" overrides the bearer auth block');
    } finally {
      clone.cleanup();
    }
  });

  it("givenGrpcApikeyInQuery_whenRun_thenWarnsAndSkips", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment/nested",
        definitionWithAuth(
          "nested",
          "  type: apikey\n  credentials:\n    key: X-Api-Key\n    value: abc\n    in: query\n",
        ),
      );

      const { code, stdout } = await runCli(deepEcho(clone.root));

      expect(code).toBe(EXIT.OK);
      expect(received[0]?.metadata["x-api-key"]).toBeUndefined();
      const report = JSON.parse(stdout) as RunReport;
      expect(report.warnings).toContain(
        "apikey auth targets the query string, which gRPC has none of; sending the call unauthenticated",
      );
    } finally {
      clone.cleanup();
    }
  });

  it("givenGrpcApikeyInHeader_whenRun_thenLowercasedMetadataEntry", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(
        clone.root,
        "payment/nested",
        definitionWithAuth("nested", "  type: apikey\n  credentials:\n    key: X-Api-Key\n    value: abc\n"),
      );

      const { code } = await runCli(deepEcho(clone.root));

      expect(code).toBe(EXIT.OK);
      // gRPC metadata keys are case-insensitive, and @grpc/grpc-js normalises them anyway.
      expect(received[0]?.metadata["x-api-key"]).toBe("abc");
    } finally {
      clone.cleanup();
    }
  });

  it("givenUnsupportedAuthType_whenInherited_thenPremanErrorListsTheSupportedSet", async () => {
    const clone = cloneFixtureWorkspace();
    try {
      writeDefinition(clone.root, "payment/nested", definitionWithAuth("nested", "  type: oauth2\n"));

      await expect(runCli(deepEcho(clone.root))).rejects.toThrow(/auth type "oauth2" is not supported/);
    } finally {
      clone.cleanup();
    }
  });
});
