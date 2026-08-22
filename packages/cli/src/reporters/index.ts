import { PremanError } from "@preman/core/errors.js";
import type { GroupRunOutcome, RunOutcome } from "@preman/core/runner.js";
import { cliReporter } from "./cli.js";
import { jsonReporter } from "./json.js";
import { junitReporter } from "./junit.js";

const DEFAULT_REPORTER = "cli";
const REPORTER_SEPARATOR = ",";
const STDOUT_TARGET = "stdout";

export interface ReporterContext {
  /** Where this reporter's output goes. undefined means stdout. */
  exportPath: string | undefined;
  verbose: boolean;
}

export interface Reporter {
  readonly name: string;
  /** Whether an export path may be given; the cli reporter says no. */
  readonly exportable: boolean;
  render(result: ReportableRun, context: ReporterContext): string;
}

/** Either shape a run can end in. */
export type ReportableRun = { kind: "single"; outcome: RunOutcome } | { kind: "group"; outcome: GroupRunOutcome };

export interface ResolvedReporter {
  reporter: Reporter;
  exportPath: string | undefined;
}

const REPORTERS: Record<string, Reporter> = {
  [cliReporter.name]: cliReporter,
  [jsonReporter.name]: jsonReporter,
  [junitReporter.name]: junitReporter,
};

export function reporterNames(): string[] {
  return Object.keys(REPORTERS);
}

export interface RenderedReports {
  /** The one reporter without an export path, if any. */
  output: string;
  files: Array<{ path: string; content: string }>;
}

export function renderReports(result: ReportableRun, reporters: ResolvedReporter[], verbose: boolean): RenderedReports {
  let output = "";
  const files: Array<{ path: string; content: string }> = [];
  for (const { reporter, exportPath } of reporters) {
    const content = reporter.render(result, { exportPath, verbose });
    if (exportPath === undefined) output = content;
    else files.push({ path: exportPath, content });
  }
  return { output, files };
}

/** True when a person is reading stdout, which is the only time warnings are shown. */
export function hasHumanReporter(reporters: ResolvedReporter[]): boolean {
  return reporters.some(({ reporter }) => reporter.name === DEFAULT_REPORTER);
}

export function resolveReporters(names: string[]): Reporter[] {
  const requested = names.flatMap((name) => name.split(REPORTER_SEPARATOR)).map((name) => name.trim());
  const unique = [...new Set(requested.length === 0 ? [DEFAULT_REPORTER] : requested)];

  return unique.map((name) => {
    const reporter = REPORTERS[name];
    if (reporter === undefined) {
      throw new PremanError(`unknown reporter "${name}"`, {
        details: [`available reporters: ${reporterNames().join(", ")}`],
      });
    }
    return reporter;
  });
}

export function resolveReporterTargets(
  names: string[],
  exportPaths: Readonly<Record<string, string | undefined>>,
): ResolvedReporter[] {
  const reporters = resolveReporters(names);
  const enabled = new Set(reporters.map((reporter) => reporter.name));

  for (const [name, exportPath] of Object.entries(exportPaths)) {
    if (exportPath !== undefined && !enabled.has(name)) {
      throw new PremanError(`--reporter-${name}-export requires reporter "${name}" to be enabled`);
    }
  }

  const resolved = reporters.map((reporter) => {
    const exportPath = exportPaths[reporter.name];
    if (exportPath !== undefined && !reporter.exportable) {
      throw new PremanError(`reporter "${reporter.name}" cannot be exported to a file`);
    }
    return { reporter, exportPath };
  });
  const stdout = resolved.filter((item) => item.exportPath === undefined);
  if (stdout.length > 1) {
    throw new PremanError(
      `reporters ${stdout.map((item) => `"${item.reporter.name}"`).join(", ")} all target ${STDOUT_TARGET}`,
      {
        details: ["give each additional reporter an export path"],
      },
    );
  }
  return resolved;
}
