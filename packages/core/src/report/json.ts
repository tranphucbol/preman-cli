import { countTests } from "@preman/core/scripts/sandbox.js";
import type { GroupRunOutcome, RunOutcome } from "@preman/core/runner.js";

/** `undefined` when the text is not JSON, so an error page survives as-is. */
function parseJson(text: string): { value: unknown } | undefined {
  if (text.trim() === "") return undefined;
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/** Stable machine-readable shape for `--json` on a collection run. */
export function toGroupJsonReport(outcome: GroupRunOutcome) {
  return {
    group: outcome.groupPath,
    items: outcome.items.map((item) => ({
      request: { name: item.entry.name, path: item.entry.path, file: item.entry.filePath, kind: item.entry.kind },
      iteration: item.iteration,
      status: item.status,
      error: item.error ?? null,
      run: item.outcome ? toJsonReport(item.outcome) : null,
    })),
    bailed: outcome.bailed,
    bailReason: outcome.bailReason ?? null,
    iterations: outcome.iterations,
    tests: outcome.tests,
    savedVars: outcome.savedVars,
    savedTo: outcome.savedTo ?? null,
    durationMs: Number(outcome.durationMs.toFixed(3)),
    exitCode: outcome.exitCode,
  };
}

function commonJsonReport(outcome: RunOutcome) {
  return {
    request: { name: outcome.entry.name, path: outcome.entry.path, file: outcome.entry.filePath },
    protocol: outcome.protocol,
    target: outcome.target,
    warnings: outcome.warnings,
    console: outcome.consoleLines,
    sideRequests: outcome.sideRequests,
    tests: outcome.tests.map((t) => ({ name: t.name, status: t.status, error: t.error ?? null, origin: t.origin })),
    testSummary: countTests(outcome.tests),
    savedVars: outcome.savedVars,
    savedTo: outcome.savedTo ?? null,
    exitCode: outcome.exitCode,
  };
}

/** Stable machine-readable shape for `--json`. */
export function toJsonReport(outcome: RunOutcome) {
  if (outcome.protocol === "grpc") {
    return {
      ...commonJsonReport(outcome),
      methodPath: outcome.methodPath,
      schemaSource: outcome.schemaSource,
      request_message: outcome.sentMessage,
      request_metadata: outcome.metadata,
      /** True only when the gRPC status was OK; `exitCode` also folds in `return_code`. */
      ok: outcome.invoke.ok,
      status: { code: outcome.invoke.code, name: outcome.invoke.codeName, message: outcome.invoke.message },
      durationMs: Number(outcome.invoke.durationMs.toFixed(3)),
      response: outcome.invoke.response ?? null,
      responseMetadata: outcome.invoke.metadata,
      trailers: outcome.invoke.trailers,
      returnCode: outcome.returnCode ?? null,
    };
  }

  const { invoke } = outcome;
  const parsed = parseJson(invoke.body);
  return {
    ...commonJsonReport(outcome),
    method: invoke.method,
    url: invoke.url,
    finalUrl: invoke.finalUrl,
    request_headers: invoke.requestHeaders,
    request_body: invoke.requestBody ?? null,
    /** True only for 2xx; `exitCode` folds in failed `pm.test` assertions too. */
    ok: invoke.ok,
    status: { code: invoke.statusCode, name: invoke.statusMessage, message: invoke.message },
    durationMs: Number(invoke.durationMs.toFixed(3)),
    /** Parsed when the body is JSON, so `--json` output stays queryable. */
    response: parsed === undefined ? (invoke.body === "" ? null : invoke.body) : parsed.value,
    responseHeaders: invoke.headers,
    setCookies: invoke.setCookies,
    redirects: invoke.redirects,
  };
}
