import pc from "picocolors";
import type { LintFinding, LintReport } from "@preman/core/api/lint.js";

const JSON_INDENT = 2;
const NONE = 0;
const ONE = 1;

export interface LintRenderOptions {
  json: boolean;
  /** Print the rule id beside every finding, for anyone writing a suppression or a bug report. */
  verbose: boolean;
}

function lintJson(report: LintReport): string {
  return JSON.stringify(report, null, JSON_INDENT);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === ONE ? "" : "s"}`;
}

/**
 * Two lines per finding: what is wrong, then what to do. The remedy is dimmed rather than
 * dropped behind `--verbose` because a finding nobody can act on is the failure mode of a linter.
 */
function paintFinding(item: LintFinding, options: LintRenderOptions): string[] {
  const badge = item.severity === "error" ? pc.red("error") : pc.yellow("warn ");
  const where = item.field === undefined ? "" : ` ${pc.cyan(item.field)}`;
  const rule = options.verbose ? ` ${pc.dim(`[${item.rule}]`)}` : "";
  return [`    ${badge}${where}  ${item.message}${rule}`, `           ${pc.dim(item.remedy)}`];
}

export function renderLint(report: LintReport, options: LintRenderOptions): string {
  if (options.json) return lintJson(report);

  const lines: string[] = [pc.dim(`workspace ${report.root}`), ""];

  if (report.workspace.length > NONE) {
    lines.push(pc.bold("workspace"));
    for (const item of report.workspace) lines.push(...paintFinding(item, options));
    lines.push("");
  }

  for (const request of report.requests) {
    lines.push(`  ${pc.cyan(request.path)}  ${pc.dim(request.file)}`);
    for (const item of request.findings) lines.push(...paintFinding(item, options));
  }

  if (report.errors === NONE && report.warnings === NONE) {
    lines.push(pc.green(`clean — ${plural(report.checked, "request")} checked`));
    return lines.join("\n");
  }

  const tally = [
    report.errors > NONE ? pc.red(plural(report.errors, "error")) : undefined,
    report.warnings > NONE ? pc.yellow(plural(report.warnings, "warning")) : undefined,
  ].filter((part): part is string => part !== undefined);
  lines.push("", `${tally.join(", ")} in ${plural(report.checked, "request")} checked`);

  return lines.join("\n");
}
