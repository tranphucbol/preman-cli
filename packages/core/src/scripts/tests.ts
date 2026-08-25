/**
 * What a `pm.test` produced, and how to add them up.
 *
 * Split out of `sandbox.ts` because counting results is not running them. A reporter, a
 * renderer and the desktop's engine host all want `countTests` and none of them want
 * `node:vm`, `chai`, `@grpc/grpc-js` or `@faker-js/faker`, which is the rest of that
 * module's import graph. Six lines of arithmetic were pulling sixteen megabytes into the
 * engine's boot path; see decision 029. `sandbox.ts` re-exports both types and the
 * function, so a caller that already has the sandbox in hand needs no second import.
 */
import type { ScriptOrigin } from "./chain.js";

export interface TestResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  /** Assertion message for `failed`, otherwise `undefined`. */
  error: string | undefined;
  /** Which collection / folder / request declared the script that ran this test. */
  origin: ScriptOrigin;
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export function countTests(tests: TestResult[]): TestSummary {
  return {
    total: tests.length,
    passed: tests.filter((test) => test.status === "passed").length,
    failed: tests.filter((test) => test.status === "failed").length,
    skipped: tests.filter((test) => test.status === "skipped").length,
  };
}
