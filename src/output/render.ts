import pc from "picocolors";
import { EXIT } from "../errors.js";
import { NO_RESPONSE_STATUS } from "../http/invoke.js";
import {
  countTests,
  type GroupRunItem,
  type GroupRunOutcome,
  type GrpcRunOutcome,
  type HttpRunOutcome,
  type ItemStatus,
  type RunOutcome,
} from "../runner.js";
import type { ScriptOrigin } from "../scripts/chain.js";
import type { TestResult } from "../scripts/sandbox.js";

const TEST_MARK: Record<TestResult["status"], { mark: string; paint: (s: string) => string }> = {
  passed: { mark: "✓", paint: pc.green },
  failed: { mark: "✗", paint: pc.red },
  skipped: { mark: "-", paint: pc.dim },
};

/**
 * Header values worth hiding: a verbose run is the thing people paste into a
 * ticket, and these carry live credentials. Enough of the value survives to tell
 * two tokens apart.
 */
const REDACTED_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-csrf-token"]);
const REDACT_KEEP = 8;
const NO_RESPONSE_LABEL = "no response";

export interface RenderOptions {
  verbose: boolean;
  /** Emit a single machine-readable JSON object instead of a human report. */
  json: boolean;
}

/** Pretty-print with syntax colouring. Falls back to plain text when colour is off. */
export function colorizeJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  if (!pc.isColorSupported) return text;

  return text.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, str: string | undefined, colon: string | undefined, literal: string | undefined, num: string | undefined) => {
      if (str !== undefined) return colon ? pc.cyan(str) + colon : pc.green(str);
      if (literal !== undefined) return pc.magenta(literal);
      if (num !== undefined) return pc.yellow(num);
      return match;
    },
  );
}

/** `undefined` when the text is not JSON, so an error page renders as-is. */
function parseJson(text: string): { value: unknown } | undefined {
  if (text.trim() === "") return undefined;
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

function redactValue(key: string, value: string): string {
  if (!REDACTED_HEADERS.has(key.toLowerCase()) || value.length <= REDACT_KEEP) return value;
  return `${value.slice(0, REDACT_KEEP)}…`;
}

function grpcStatusLabel(outcome: GrpcRunOutcome, ms: string): string {
  if (!outcome.invoke.ok) return `${pc.red(`✗ ${outcome.invoke.codeName}`)} ${pc.dim(ms)}`;

  // The call itself succeeded, so the mark reflects the whole verdict: a failed
  // `pm.test` turns it yellow even though `return_code` was fine.
  const label = outcome.returnCode === undefined ? "OK" : `OK / ${outcome.returnCode}`;
  return outcome.exitCode === EXIT.OK
    ? `${pc.green(`✓ ${label}`)} ${pc.dim(ms)}`
    : `${pc.yellow(`✗ ${label}`)} ${pc.dim(ms)}`;
}

/** HTTP has no separate business field, so the status line *is* the verdict. */
function httpStatusLabel(outcome: HttpRunOutcome, ms: string): string {
  const { invoke } = outcome;
  if (invoke.statusCode === NO_RESPONSE_STATUS) return `${pc.red(`✗ ${NO_RESPONSE_LABEL}`)} ${pc.dim(ms)}`;

  const label = `${invoke.statusCode} ${invoke.statusMessage}`.trim();
  return outcome.exitCode === EXIT.OK
    ? `${pc.green(`✓ ${label}`)} ${pc.dim(ms)}`
    : `${pc.yellow(`✗ ${label}`)} ${pc.dim(ms)}`;
}

function statusLabel(outcome: RunOutcome): string {
  const ms = `${outcome.invoke.durationMs.toFixed(0)}ms`;
  return outcome.protocol === "grpc" ? grpcStatusLabel(outcome, ms) : httpStatusLabel(outcome, ms);
}

/**
 * Decision 8: only a non-request origin is named. Inheritance must not reformat the output
 * of the request-level scripts that were the only kind preman used to run.
 */
function originTag(origin: ScriptOrigin): string {
  return origin.level === "request" ? "" : ` [${origin.label}]`;
}

/** Per-test lines plus a one-line tally. Always shown: a silent test is a useless test. */
function renderTests(tests: TestResult[], out: string[]): void {
  if (tests.length === 0) return;
  const summary = countTests(tests);

  out.push("");
  for (const test of tests) {
    const style = TEST_MARK[test.status];
    out.push(`${style.paint(style.mark)} ${test.name}${pc.dim(originTag(test.origin))}`);
    if (test.error !== undefined) out.push(pc.red(`  ${test.error}`));
  }

  const parts = [`${summary.total} ${summary.total === 1 ? "test" : "tests"}`];
  if (summary.passed > 0) parts.push(pc.green(`${summary.passed} passed`));
  if (summary.failed > 0) parts.push(pc.red(`${summary.failed} failed`));
  if (summary.skipped > 0) parts.push(pc.dim(`${summary.skipped} skipped`));
  out.push(pc.dim(parts.join(" · ")));
}

function renderEntries(label: string, entries: Record<string, string | string[]>, out: string[]): void {
  const keys = Object.keys(entries);
  if (keys.length === 0) return;
  out.push(pc.dim(`${label}:`));
  for (const key of keys.sort()) {
    const value = entries[key];
    const shown = (Array.isArray(value) ? value : [value ?? ""]).map((v) => redactValue(key, v)).join(", ");
    out.push(pc.dim(`  ${key}: ${shown}`));
  }
}

function grpcRequestLines(outcome: GrpcRunOutcome, out: string[]): void {
  if (Object.keys(outcome.metadata).length > 0) renderEntries("request metadata", outcome.metadata, out);
  out.push(pc.dim("request body:"), colorizeJson(outcome.sentMessage));
}

function httpRequestLines(outcome: HttpRunOutcome, out: string[]): void {
  renderEntries("request headers", outcome.invoke.requestHeaders, out);
  const body = outcome.invoke.requestBody;
  if (body !== undefined && body !== "") {
    const json = parseJson(body);
    out.push(pc.dim("request body:"), json === undefined ? body : colorizeJson(json.value));
  }
}

function grpcResponseLines(outcome: GrpcRunOutcome, verbose: boolean, out: string[]): void {
  if (!outcome.invoke.ok) {
    if (outcome.invoke.message) out.push(pc.red(outcome.invoke.message));
  } else {
    out.push(colorizeJson(outcome.invoke.response));
  }

  if (!verbose) return;
  renderEntries("response metadata", outcome.invoke.metadata, out);
  renderEntries("trailers", outcome.invoke.trailers, out);
}

function httpResponseLines(outcome: HttpRunOutcome, verbose: boolean, out: string[]): void {
  const { invoke } = outcome;
  if (invoke.statusCode === NO_RESPONSE_STATUS) {
    if (invoke.message) out.push(pc.red(invoke.message));
    return;
  }

  if (invoke.body !== "") {
    const json = parseJson(invoke.body);
    out.push(json === undefined ? invoke.body : colorizeJson(json.value));
  }

  if (!verbose) return;
  for (const hop of invoke.redirects) out.push(pc.dim(`redirect ${hop.status}: ${hop.from} → ${hop.to}`));
  renderEntries("response headers", invoke.headers, out);
  if (invoke.setCookies.length > 0) {
    out.push(pc.dim("set-cookie:"));
    for (const cookie of invoke.setCookies) out.push(pc.dim(`  ${redactValue("set-cookie", cookie)}`));
  }
}

function headerLines(outcome: RunOutcome): string[] {
  const tlsLabel = outcome.target.tls ? "tls" : "plaintext";

  if (outcome.protocol === "grpc") {
    return [
      `${pc.bold(outcome.entry.path)}  ${pc.dim("→")}  ${pc.cyan(outcome.methodPath)}`,
      pc.dim(
        `target ${outcome.target.authority} [${tlsLabel}] (${outcome.target.source}) · schema ${outcome.schemaSource}`,
      ),
    ];
  }

  const url = new URL(outcome.invoke.url);
  return [
    `${pc.bold(outcome.entry.path)}  ${pc.dim("→")}  ${pc.cyan(`${outcome.invoke.method} ${url.pathname}${url.search}`)}`,
    pc.dim(`target ${outcome.target.origin} [${tlsLabel}] (${outcome.target.source})`),
  ];
}

/**
 * Certificate provenance, so a surprising handshake result can be traced to the
 * flag or config file that supplied the material.
 */
function certSourceLines(outcome: RunOutcome, out: string[]): void {
  for (const [field, source] of Object.entries(outcome.tlsSources)) {
    out.push(pc.dim(`cert ${field} ← ${source}`));
  }
}

/** The human-facing report for a completed run. */
export function renderOutcome(outcome: RunOutcome, options: RenderOptions): string {
  if (options.json) return JSON.stringify(toJsonReport(outcome), null, 2);

  const lines: string[] = headerLines(outcome);
  if (options.verbose) certSourceLines(outcome, lines);

  for (const warning of outcome.warnings) lines.push(pc.yellow(`warn: ${warning}`));

  if (options.verbose) {
    for (const line of outcome.consoleLines) {
      lines.push(pc.dim(`script ${line.level}${originTag(line.origin)}: ${line.text}`));
    }
    for (const side of outcome.sideRequests) {
      const status = side.statusCode === NO_RESPONSE_STATUS ? NO_RESPONSE_LABEL : `${side.statusCode} ${side.statusMessage}`;
      lines.push(pc.dim(`script request ${side.method} ${side.url} → ${status} ${side.durationMs}ms`));
    }
    if (outcome.protocol === "grpc") grpcRequestLines(outcome, lines);
    else httpRequestLines(outcome, lines);
  }

  lines.push("", statusLabel(outcome));

  if (outcome.protocol === "grpc") grpcResponseLines(outcome, options.verbose, lines);
  else httpResponseLines(outcome, options.verbose, lines);

  renderTests(outcome.tests, lines);

  const savedKeys = Object.keys(outcome.savedVars);
  if (savedKeys.length > 0 && outcome.savedTo) {
    const pairs = savedKeys.map((k) => `${k}=${outcome.savedVars[k]}`).join(" ");
    lines.push(pc.dim(`saved ${pairs} → ${outcome.savedTo}`));
  }

  return lines.join("\n");
}

const STATUS_STYLE: Record<ItemStatus, { mark: string; paint: (s: string) => string }> = {
  ok: { mark: "✓", paint: pc.green },
  business: { mark: "✗", paint: pc.yellow },
  test: { mark: "✗", paint: pc.yellow },
  transport: { mark: "✗", paint: pc.red },
  error: { mark: "✗", paint: pc.red },
  skipped: { mark: "-", paint: pc.dim },
};

/** The status half of an item label, without the test tally. */
function itemStatusText(outcome: RunOutcome, status: ItemStatus): string {
  if (outcome.protocol === "grpc") {
    if (!outcome.invoke.ok) return pc.red(outcome.invoke.codeName);
    const label = outcome.returnCode === undefined ? "OK" : `OK / ${outcome.returnCode}`;
    return status === "ok" ? pc.green(label) : pc.yellow(label);
  }

  const { invoke } = outcome;
  if (invoke.statusCode === NO_RESPONSE_STATUS) return pc.red(NO_RESPONSE_LABEL);
  const label = `${invoke.statusCode} ${invoke.statusMessage}`.trim();
  return status === "ok" ? pc.green(label) : pc.yellow(label);
}

/** Short right-hand column for one request in a collection run. */
function itemLabel(item: GroupRunItem): string {
  if (item.status === "skipped") return pc.dim(`skipped: ${item.error?.message ?? "unsupported"}`);
  if (item.status === "error") return pc.red(`error: ${item.error?.message ?? "failed"}`);

  const outcome = item.outcome;
  if (outcome === undefined) return "";
  const ms = pc.dim(`${outcome.invoke.durationMs.toFixed(0)}ms`);
  const painted = itemStatusText(outcome, item.status);

  const tests = countTests(outcome.tests);
  if (tests.total === 0) return `${painted} ${ms}`;
  const tally = `${tests.passed}/${tests.total} tests`;
  return `${painted} ${ms} ${tests.failed > 0 ? pc.red(tally) : pc.dim(tally)}`;
}

/** Failed assertion names, so a collection run explains itself without `--verbose`. */
function failedTestLines(item: GroupRunItem): string[] {
  return (item.outcome?.tests ?? [])
    .filter((t) => t.status === "failed")
    .flatMap((t) => [pc.red(`  ✗ ${t.name}`), ...(t.error === undefined ? [] : [pc.dim(`    ${t.error}`)])]);
}

function countsLine(outcome: GroupRunOutcome): string {
  const tally = (status: ItemStatus) => outcome.items.filter((i) => i.status === status).length;
  const total = outcome.items.length;
  const parts = [`${total} ${total === 1 ? "request" : "requests"}`, pc.green(`${tally("ok")} ok`)];
  if (outcome.iterations > 1) parts.unshift(`${outcome.iterations} iterations`);

  const optional: Array<[ItemStatus, (n: number) => string, (s: string) => string]> = [
    ["business", (n) => `${n} business`, pc.yellow],
    // Counts requests, not assertions, so the wording stays honest either way.
    ["test", (n) => `${n} with failed tests`, pc.yellow],
    ["transport", (n) => `${n} failed`, pc.red],
    ["error", (n) => `${n} errored`, pc.red],
    ["skipped", (n) => `${n} skipped`, pc.dim],
  ];
  for (const [status, label, paint] of optional) {
    const n = tally(status);
    if (n > 0) parts.push(paint(label(n)));
  }
  parts.push(pc.dim(`${outcome.durationMs.toFixed(0)}ms`));
  return parts.join(pc.dim(" · "));
}

const BAIL_FLAG_LINE = "stopped early: --bail";
const ABORT_FALLBACK = "an inherited script failed";
const TIMEOUT_BAIL_LINE = "stopped early: run budget exhausted";

/**
 * Explains why a group run stopped short. `--bail` is the user's own doing; an
 * inherited-script abort is not, so it names the script that broke the group.
 */
function stoppedLine(outcome: GroupRunOutcome): string | undefined {
  if (outcome.bailReason === "bail-flag") return pc.yellow(BAIL_FLAG_LINE);
  if (outcome.bailReason === "timeout") return pc.red(TIMEOUT_BAIL_LINE);
  if (outcome.bailReason !== "inherited-script") return undefined;
  const cause = outcome.items[outcome.items.length - 1]?.error?.message ?? ABORT_FALLBACK;
  return pc.red(`aborted: ${cause}`);
}

/** The human-facing report for a collection or folder run. */
export function renderGroupOutcome(outcome: GroupRunOutcome, options: RenderOptions): string {
  if (options.json) return JSON.stringify(toGroupJsonReport(outcome), null, 2);

  const lines: string[] = [];
  const total = outcome.items.length;
  lines.push(`${pc.bold(outcome.groupPath)}  ${pc.dim(`${total} ${total === 1 ? "request" : "requests"}`)}`, "");

  if (options.verbose) {
    // Verbose mode shows each request's full report, so the compact table would
    // only repeat it.
    for (const item of outcome.items) {
      const style = STATUS_STYLE[item.status];
      if (item.outcome) {
        lines.push(renderOutcome(item.outcome, { verbose: true, json: false }), "");
        continue;
      }
      lines.push(`${style.paint(style.mark)} ${pc.bold(item.entry.path)}  ${itemLabel(item)}`);
      for (const detail of item.error?.details ?? []) lines.push(pc.dim(`  ${detail}`));
      lines.push("");
    }
  } else {
    const width = Math.max(...outcome.items.map((i) => i.entry.path.length));
    for (const item of outcome.items) {
      const style = STATUS_STYLE[item.status];
      const iteration = outcome.iterations > 1 ? `[${item.iteration}] ` : "";
      lines.push(`${iteration}${style.paint(style.mark)} ${item.entry.path.padEnd(width)}  ${itemLabel(item)}`);
      for (const detail of item.error?.details ?? []) lines.push(pc.dim(`  ${detail}`));
      lines.push(...failedTestLines(item));
    }
    lines.push("");
  }

  lines.push(countsLine(outcome));
  const stopped = stoppedLine(outcome);
  if (stopped) lines.push(stopped);

  const savedKeys = Object.keys(outcome.savedVars);
  if (savedKeys.length > 0 && outcome.savedTo) {
    const pairs = savedKeys.map((k) => `${k}=${outcome.savedVars[k]}`).join(" ");
    lines.push(pc.dim(`saved ${pairs} → ${outcome.savedTo}`));
  }

  return lines.join("\n");
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
