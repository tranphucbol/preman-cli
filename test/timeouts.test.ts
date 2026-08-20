import { describe, expect, it } from "vitest";
import { resolveTimeouts } from "@/cli.js";

describe("resolveTimeouts", () => {
  it("givenTimeoutOnly_whenResolving_thenTreatedAsRequestDeadlineWithWarning", () => {
    expect(resolveTimeouts({ timeout: "9000" })).toEqual({
      runMs: 0,
      requestMs: 9000,
      scriptMs: 5000,
      warning: "--timeout now means the whole-run budget; use --timeout-request for the per-call deadline",
    });
  });

  it("givenTimeoutRequestOnly_whenResolving_thenNoWarning", () => {
    expect(resolveTimeouts({ "timeout-request": "9000" })).toEqual({ runMs: 0, requestMs: 9000, scriptMs: 5000 });
  });

  it("givenBothTimeoutFlags_whenResolving_thenTimeoutIsRunBudgetAndNoWarning", () => {
    expect(resolveTimeouts({ timeout: "60000", "timeout-request": "9000" })).toEqual({
      runMs: 60000,
      requestMs: 9000,
      scriptMs: 5000,
    });
  });

  it("givenTimeoutZero_whenResolving_thenRunBudgetUnbounded", () => {
    expect(resolveTimeouts({ timeout: "0", "timeout-request": "9000" }).runMs).toBe(0);
  });

  it("givenNoTimeoutFlags_whenResolving_thenDefaultsApply", () => {
    expect(resolveTimeouts({})).toEqual({ runMs: 0, requestMs: 30000, scriptMs: 5000 });
  });

  it("givenTimeoutScript_whenResolving_thenScriptBudgetOverridden", () => {
    expect(resolveTimeouts({ "timeout-script": "250" }).scriptMs).toBe(250);
  });
});
