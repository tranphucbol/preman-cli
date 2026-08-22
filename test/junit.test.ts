import { parseStringPromise } from "xml2js";
import { describe, expect, it } from "vitest";
import { EXIT } from "@preman/core/errors.js";
import { junitReporter } from "@preman/cli/reporters/junit.js";
import type { GroupRunItem, GroupRunOutcome, RunOutcome } from "@preman/core/runner.js";
import type { TestResult } from "@preman/core/scripts/sandbox.js";

const REQUEST_ORIGIN = { level: "request", label: "request" } as const;

function test(name: string, status: TestResult["status"], error?: string): TestResult {
  return { name, status, error, origin: REQUEST_ORIGIN };
}

function outcome(
  options: {
    path?: string;
    tests?: TestResult[];
    exitCode?: RunOutcome["exitCode"];
    returnCode?: string;
    message?: string;
    durationMs?: number;
  } = {},
): RunOutcome {
  const path = options.path ?? "payment/Echo";
  return {
    protocol: "grpc",
    entry: { name: path.split("/").at(-1), path },
    tests: options.tests ?? [],
    exitCode: options.exitCode ?? EXIT.OK,
    returnCode: options.returnCode ?? "OK",
    invoke: { durationMs: options.durationMs ?? 140, message: options.message ?? "", codeName: "OK" },
  } as unknown as RunOutcome;
}

function item(run: RunOutcome, status: GroupRunItem["status"]): GroupRunItem {
  return { entry: run.entry, iteration: 0, status, outcome: run, error: undefined };
}

function group(items: GroupRunItem[]): GroupRunOutcome {
  return {
    groupPath: "payment",
    items,
    bailed: false,
    bailReason: undefined,
    iterations: 1,
    savedVars: {},
    savedTo: undefined,
    durationMs: 812,
    tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
    exitCode: EXIT.OK,
  };
}

function render(run: RunOutcome): string {
  return junitReporter.render({ kind: "single", outcome: run }, { exportPath: undefined, verbose: false });
}

describe("JUnit reporter", () => {
  it("givenPassingAssertion_whenRender_thenTestcaseHasNoFailure", () => {
    const xml = render(outcome({ tests: [test("status is OK", "passed")] }));
    expect(xml).toContain('<testcase classname="payment/Echo" name="status is OK" time="0"/>');
    expect(xml).not.toContain("<failure");
  });

  it("givenFailingAssertion_whenRender_thenFailureElementCarriesMessage", () => {
    const xml = render(outcome({ tests: [test("return_code is OK", "failed", "expected FAIL to equal OK")] }));
    expect(xml).toContain('<failure type="AssertionError">expected FAIL to equal OK</failure>');
  });

  it("givenSkippedAssertion_whenRender_thenSkippedElementAndCountedInTests", () => {
    const xml = render(outcome({ tests: [test("later", "skipped")] }));
    expect(xml).toContain('tests="1" failures="0" errors="0"');
    expect(xml).toContain("<skipped/>");
  });

  it("givenInheritedScriptTest_whenRender_thenNameIncludesOrigin", () => {
    const inherited = {
      ...test("shared check", "passed"),
      origin: { level: "collection", label: "collection payment" } as const,
    };
    expect(render(outcome({ tests: [inherited] }))).toContain('name="shared check [collection payment]"');
  });

  it("givenTransportFailure_whenRender_thenSyntheticErrorTestcase", () => {
    const xml = render(outcome({ exitCode: EXIT.TRANSPORT, message: "handler exploded" }));
    expect(xml).toContain('name="request"');
    expect(xml).toContain("<error>handler exploded</error>");
  });

  it("givenBusinessFailure_whenRender_thenSyntheticFailureTestcase", () => {
    const xml = render(outcome({ exitCode: EXIT.BUSINESS, returnCode: "INVALID_ARGUMENT" }));
    expect(xml).toContain("<failure");
    expect(xml).toContain("return_code: INVALID_ARGUMENT");
  });

  it("givenSkippedRequest_whenRender_thenSuiteWithSkippedTestcase", () => {
    const run = outcome({ path: "payment/Legacy" });
    const skipped: GroupRunItem = {
      entry: run.entry,
      iteration: 0,
      status: "skipped",
      outcome: undefined,
      error: { message: "unsupported", details: [] },
    };
    const xml = junitReporter.render(
      { kind: "group", outcome: group([skipped]) },
      { exportPath: undefined, verbose: false },
    );
    expect(xml).toContain('<testsuite name="payment/Legacy" tests="1"');
    expect(xml).toContain("<skipped/>");
  });

  it("givenRequestWithNoAssertions_whenRender_thenEmptySuite", () => {
    expect(render(outcome())).toContain('<testsuite name="payment/Echo" tests="0" failures="0" errors="0"');
  });

  it("givenAssertionMessageWithMarkup_whenRender_thenEscapedAndWellFormed", async () => {
    const xml = render(outcome({ tests: [test('value < "limit"', "failed", "a < b & c")] }));
    expect(xml).toContain("a &lt; b &amp; c");
    await expect(parseStringPromise(xml)).resolves.toBeDefined();
  });

  it("givenGroup_whenRender_thenSuiteTotalsMatchTestcaseCounts", () => {
    const passing = outcome({ path: "payment/Passing", tests: [test("one", "passed"), test("two", "skipped")] });
    const failing = outcome({ path: "payment/Failing", tests: [test("three", "failed", "nope")] });
    const errored = outcome({ path: "payment/Error" });
    const errorItem: GroupRunItem = {
      entry: errored.entry,
      iteration: 0,
      status: "error",
      outcome: undefined,
      error: { message: "bad config", details: ["missing field"] },
    };
    const xml = junitReporter.render(
      { kind: "group", outcome: group([item(passing, "ok"), item(failing, "test"), errorItem]) },
      { exportPath: undefined, verbose: false },
    );
    expect(xml).toContain('<testsuites name="preman" tests="4" failures="1" errors="1" time="0.812">');
    expect(xml.match(/<testsuite /g)).toHaveLength(3);
  });
});
