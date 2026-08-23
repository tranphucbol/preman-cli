import { EXIT } from "@preman/core/errors.js";
import type { GroupRunItem, GroupRunOutcome, RunOutcome } from "@preman/core/runner.js";
import { originTag } from "./origin.js";
import { renderXml, type XmlElement } from "./xml.js";

/** Either shape a run can end in, and so either shape a report can be rendered from. */
export type RunReport = { kind: "single"; outcome: RunOutcome } | { kind: "group"; outcome: GroupRunOutcome };

const SUITES_NAME = "preman";
const CLASSNAME_SEPARATOR = "/";
const SYNTHETIC_CASE_NAME = "request";
const MS_PER_SECOND = 1000;
const ASSERTION_ERROR_TYPE = "AssertionError";

type CaseResult = "passed" | "failed" | "error" | "skipped";

interface JunitCase {
  result: CaseResult;
  element: XmlElement;
}

interface JunitSuite {
  tests: number;
  failures: number;
  errors: number;
  element: XmlElement;
}

function seconds(durationMs: number): string {
  return (durationMs / MS_PER_SECOND).toFixed(3);
}

function testcase(
  classname: string,
  name: string,
  result: CaseResult,
  message?: string,
  failureType?: string,
): JunitCase {
  let child: XmlElement | undefined;
  if (result === "failed") {
    child = { name: "failure", attributes: { type: failureType }, text: message ?? "request failed" };
  } else if (result === "error") {
    child = { name: "error", text: message ?? "request errored" };
  } else if (result === "skipped") {
    child = { name: "skipped" };
  }
  return {
    result,
    element: {
      name: "testcase",
      attributes: { classname, name, time: 0 },
      ...(child === undefined ? {} : { children: [child] }),
    },
  };
}

function assertionCases(outcome: RunOutcome): JunitCase[] {
  return outcome.tests.map((test) =>
    testcase(
      outcome.entry.path.split(CLASSNAME_SEPARATOR).join(CLASSNAME_SEPARATOR),
      `${test.name}${originTag(test.origin)}`,
      test.status === "failed" ? "failed" : test.status,
      test.error,
      test.status === "failed" ? ASSERTION_ERROR_TYPE : undefined,
    ),
  );
}

function transportMessage(outcome: RunOutcome): string {
  return outcome.invoke.message || (outcome.protocol === "grpc" ? outcome.invoke.codeName : "no response");
}

function businessMessage(outcome: RunOutcome): string {
  if (outcome.protocol === "grpc") return `return_code: ${outcome.returnCode ?? "missing"}`;
  return `HTTP status: ${outcome.invoke.statusCode} ${outcome.invoke.statusMessage}`.trim();
}

function outcomeCases(outcome: RunOutcome): JunitCase[] {
  if (outcome.exitCode === EXIT.TRANSPORT) {
    return [testcase(outcome.entry.path, SYNTHETIC_CASE_NAME, "error", transportMessage(outcome))];
  }

  const assertions = assertionCases(outcome);
  if (outcome.exitCode === EXIT.BUSINESS) {
    assertions.push(testcase(outcome.entry.path, SYNTHETIC_CASE_NAME, "failed", businessMessage(outcome)));
  }
  return assertions;
}

function suite(name: string, durationMs: number, cases: JunitCase[]): JunitSuite {
  const failures = cases.filter((item) => item.result === "failed").length;
  const errors = cases.filter((item) => item.result === "error").length;
  return {
    tests: cases.length,
    failures,
    errors,
    element: {
      name: "testsuite",
      attributes: { name, tests: cases.length, failures, errors, time: seconds(durationMs) },
      children: cases.map((item) => item.element),
    },
  };
}

function groupSuite(item: GroupRunItem): JunitSuite {
  if (item.status === "skipped") {
    return suite(item.entry.path, 0, [testcase(item.entry.path, SYNTHETIC_CASE_NAME, "skipped")]);
  }
  if (item.status === "error" || item.outcome === undefined) {
    const details = item.error === undefined ? [] : [item.error.message, ...item.error.details];
    return suite(item.entry.path, 0, [testcase(item.entry.path, SYNTHETIC_CASE_NAME, "error", details.join("\n"))]);
  }
  return suite(item.entry.path, item.outcome.invoke.durationMs, outcomeCases(item.outcome));
}

/** JUnit XML for a finished run. The only report format preman renders as XML. */
export function toJunitReport(result: RunReport): string {
  const suites =
    result.kind === "single"
      ? [suite(result.outcome.entry.path, result.outcome.invoke.durationMs, outcomeCases(result.outcome))]
      : result.outcome.items.map(groupSuite);
  const durationMs = result.kind === "single" ? result.outcome.invoke.durationMs : result.outcome.durationMs;
  const total = (field: "tests" | "failures" | "errors") => suites.reduce((sum, item) => sum + item[field], 0);

  return renderXml({
    name: "testsuites",
    attributes: {
      name: SUITES_NAME,
      tests: total("tests"),
      failures: total("failures"),
      errors: total("errors"),
      time: seconds(durationMs),
    },
    children: suites.map((item) => item.element),
  });
}
