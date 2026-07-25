import pc from "picocolors";
import { EXIT } from "../errors.js";
import { countTests, type GroupRunItem, type GroupRunOutcome, type ItemStatus, type RunOutcome } from "../runner.js";
import type { TestResult } from "../scripts/sandbox.js";

const TEST_MARK: Record<TestResult["status"], { mark: string; paint: (s: string) => string }> = {
  passed: { mark: "✓", paint: pc.green },
  failed: { mark: "✗", paint: pc.red },
  skipped: { mark: "-", paint: pc.dim },
};

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

function statusLabel(outcome: RunOutcome): string {
  const { invoke, returnCode } = outcome;
  const ms = `${invoke.durationMs.toFixed(0)}ms`;

  if (!invoke.ok) return `${pc.red(`✗ ${invoke.codeName}`)} ${pc.dim(ms)}`;

  // The call itself succeeded, so the mark reflects the whole verdict: a failed
  // `pm.test` turns it yellow even though `return_code` was fine.
  const label = returnCode === undefined ? "OK" : `OK / ${returnCode}`;
  return outcome.exitCode === EXIT.OK
    ? `${pc.green(`✓ ${label}`)} ${pc.dim(ms)}`
    : `${pc.yellow(`✗ ${label}`)} ${pc.dim(ms)}`;
}

/** Per-test lines plus a one-line tally. Always shown: a silent test is a useless test. */
function renderTests(tests: TestResult[], out: string[]): void {
  if (tests.length === 0) return;
  const summary = countTests(tests);

  out.push("");
  for (const test of tests) {
    const style = TEST_MARK[test.status];
    out.push(`${style.paint(style.mark)} ${test.name}`);
    if (test.error !== undefined) out.push(pc.red(`  ${test.error}`));
  }

  const parts = [`${summary.total} ${summary.total === 1 ? "test" : "tests"}`];
  if (summary.passed > 0) parts.push(pc.green(`${summary.passed} passed`));
  if (summary.failed > 0) parts.push(pc.red(`${summary.failed} failed`));
  if (summary.skipped > 0) parts.push(pc.dim(`${summary.skipped} skipped`));
  out.push(pc.dim(parts.join(" · ")));
}

function renderMetadata(label: string, entries: Record<string, string | string[]>, out: string[]): void {
  const keys = Object.keys(entries);
  if (keys.length === 0) return;
  out.push(pc.dim(`${label}:`));
  for (const key of keys.sort()) {
    const value = entries[key];
    out.push(pc.dim(`  ${key}: ${Array.isArray(value) ? value.join(", ") : value}`));
  }
}

/** The human-facing report for a completed run. */
export function renderOutcome(outcome: RunOutcome, options: RenderOptions): string {
  if (options.json) return JSON.stringify(toJsonReport(outcome), null, 2);

  const lines: string[] = [];
  const tlsLabel = outcome.target.tls ? "tls" : "plaintext";

  lines.push(
    `${pc.bold(outcome.entry.path)}  ${pc.dim("→")}  ${pc.cyan(outcome.methodPath)}`,
    pc.dim(`target ${outcome.target.authority} [${tlsLabel}] (${outcome.target.source}) · schema ${outcome.schemaSource}`),
  );

  for (const warning of outcome.warnings) lines.push(pc.yellow(`warn: ${warning}`));

  if (options.verbose) {
    for (const line of outcome.consoleLines) lines.push(pc.dim(`script ${line.level}: ${line.text}`));
    if (Object.keys(outcome.metadata).length > 0) {
      renderMetadata("request metadata", outcome.metadata, lines);
    }
    lines.push(pc.dim("request body:"), colorizeJson(outcome.sentMessage));
  }

  lines.push("", statusLabel(outcome));

  if (!outcome.invoke.ok) {
    if (outcome.invoke.message) lines.push(pc.red(outcome.invoke.message));
  } else {
    lines.push(colorizeJson(outcome.invoke.response));
  }

  if (options.verbose) {
    renderMetadata("response metadata", outcome.invoke.metadata, lines);
    renderMetadata("trailers", outcome.invoke.trailers, lines);
  }

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

/** Short right-hand column for one request in a collection run. */
function itemLabel(item: GroupRunItem): string {
  if (item.status === "skipped") return pc.dim(`skipped: ${item.error?.message ?? "unsupported"}`);
  if (item.status === "error") return pc.red(`error: ${item.error?.message ?? "failed"}`);

  const outcome = item.outcome;
  if (outcome === undefined) return "";
  const ms = pc.dim(`${outcome.invoke.durationMs.toFixed(0)}ms`);
  if (!outcome.invoke.ok) return `${pc.red(outcome.invoke.codeName)} ${ms}`;
  const status = outcome.returnCode === undefined ? "OK" : `OK / ${outcome.returnCode}`;
  const painted = item.status === "ok" ? pc.green(status) : pc.yellow(status);

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
      lines.push(`${style.paint(style.mark)} ${item.entry.path.padEnd(width)}  ${itemLabel(item)}`);
      for (const detail of item.error?.details ?? []) lines.push(pc.dim(`  ${detail}`));
      lines.push(...failedTestLines(item));
    }
    lines.push("");
  }

  lines.push(countsLine(outcome));
  if (outcome.bailed) lines.push(pc.yellow("stopped early: --bail"));

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
      status: item.status,
      error: item.error ?? null,
      run: item.outcome ? toJsonReport(item.outcome) : null,
    })),
    bailed: outcome.bailed,
    savedVars: outcome.savedVars,
    savedTo: outcome.savedTo ?? null,
    durationMs: Number(outcome.durationMs.toFixed(3)),
    exitCode: outcome.exitCode,
  };
}

/** Stable machine-readable shape for `--json`. */
export function toJsonReport(outcome: RunOutcome) {
  return {
    request: { name: outcome.entry.name, path: outcome.entry.path, file: outcome.entry.filePath },
    methodPath: outcome.methodPath,
    target: outcome.target,
    schemaSource: outcome.schemaSource,
    warnings: outcome.warnings,
    console: outcome.consoleLines,
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
    tests: outcome.tests.map((t) => ({ name: t.name, status: t.status, error: t.error ?? null })),
    testSummary: countTests(outcome.tests),
    savedVars: outcome.savedVars,
    savedTo: outcome.savedTo ?? null,
    exitCode: outcome.exitCode,
  };
}
