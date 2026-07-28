import pc from "picocolors";
import { loadIterationData, type DataRow } from "../data/rows.js";
import { CliError, type ExitCode } from "../errors.js";
import type { ReportableRun, ResolvedReporter } from "../output/reporter.js";
import { runGroup, runRequest, type GroupRunOutcome, type RunOutcome } from "../runner.js";
import {
  listRequests,
  resolveSelector,
  targetLabel,
  type RequestEntry,
  type RunTarget,
} from "../workspace/collections.js";
import { resolveTlsCerts, type TlsCertInput, type TlsCertLayer } from "../tls/certs.js";
import { loadPremanConfig } from "../workspace/config.js";
import { requireWorkspace } from "../workspace/discover.js";
import { listEnvironments, loadGlobals } from "../workspace/environments.js";
import type { EnvironmentEntry } from "../workspace/environments.js";
import { loadResources } from "../workspace/resources.js";
import type { Workspace } from "../workspace/discover.js";
import { fileReader } from "../workspace/files.js";

export interface RunArgs {
  dir: string;
  selector: string | undefined;
  env: string | undefined;
  url: string | undefined;
  tls: boolean | undefined;
  /** Raw `--ssl-*` and `-k` values; resolved here, where the workspace is known. */
  tlsCerts: TlsCertInput;
  timeoutMs: number;
  runTimeoutMs: number;
  scriptTimeoutMs: number;
  iterationCount: number | undefined;
  iterationData: string | undefined;
  delayRequestMs: number;
  vars: Record<string, string>;
  save: boolean;
  preferDescriptor: boolean;
  /** Stop a collection run at the first request that does not fully succeed. */
  bail: boolean;
  reporters: ResolvedReporter[];
  verbose: boolean;
  workingDir: string | undefined;
  insecureFileRead: boolean;
}

/** Layer labels, echoed back to the user when a certificate cannot be read. */
const CLI_CERT_LABEL = "--ssl-*";
const CONFIG_CERT_LABEL = ".postman/preman.yaml";

export interface RunCommandResult {
  output: string;
  files: Array<{ path: string; content: string }>;
  exitCode: ExitCode;
  /** Set for a single-request run. */
  outcome: RunOutcome | undefined;
  /** Set for a collection or folder run. */
  group: GroupRunOutcome | undefined;
}

function renderReports(result: ReportableRun, reporters: ResolvedReporter[], verbose: boolean) {
  let output = "";
  const files: Array<{ path: string; content: string }> = [];
  for (const { reporter, exportPath } of reporters) {
    const content = reporter.render(result, { exportPath, verbose });
    if (exportPath === undefined) output = content;
    else files.push({ path: exportPath, content });
  }
  return { output, files };
}

function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function pickTarget(
  requests: RequestEntry[],
  candidates: RunTarget[],
  selector: string | undefined,
): Promise<RunTarget> {
  const choices: RunTarget[] =
    candidates.length > 0 ? candidates : requests.map((entry) => ({ kind: "request", entry }));

  if (choices.length === 0) {
    throw new CliError("no requests found under postman/collections");
  }
  if (choices.length === 1) return choices[0]!;

  if (!isInteractive()) {
    const heading = selector === undefined ? "several requests exist; name one" : `"${selector}" is ambiguous`;
    throw new CliError(heading, { details: ["candidates:", ...choices.map((t) => `  ${targetLabel(t)}`)] });
  }

  const { search } = await import("@inquirer/prompts");
  return search<RunTarget>({
    message: selector === undefined ? "Select a request" : `Select what to run matching "${selector}"`,
    source: (term) => {
      const needle = (term ?? "").toLowerCase();
      return choices
        .filter((t) => needle.length === 0 || targetLabel(t).toLowerCase().includes(needle))
        .map((t) => ({ name: targetLabel(t), value: t }));
    },
  });
}

async function pickEnvironment(ws: Workspace, name: string | undefined): Promise<EnvironmentEntry | undefined> {
  const all = listEnvironments(ws);

  if (name !== undefined) {
    const needle = name.trim().toLowerCase();
    const found = all.find((e) => e.name.toLowerCase() === needle);
    if (found) return found;
    throw new CliError(`environment "${name}" not found`, {
      details: all.length > 0 ? ["available:", ...all.map((e) => `  ${e.name}`)] : ["no environments exist"],
    });
  }

  if (all.length === 0) return undefined;
  if (all.length === 1) return all[0]!;

  if (!isInteractive()) {
    throw new CliError("multiple environments exist; pass -e <NAME>", {
      details: ["available:", ...all.map((e) => `  ${e.name}`)],
    });
  }

  const { select } = await import("@inquirer/prompts");
  return select<EnvironmentEntry>({
    message: "Select an environment",
    choices: all.map((e) => ({ name: e.name, value: e })),
  });
}

export function resolveIterations(requested: number | undefined, rows: DataRow[]): number {
  return requested ?? (rows.length > 0 ? rows.length : 1);
}

export async function commandRun(args: RunArgs): Promise<RunCommandResult> {
  const ws = requireWorkspace(args.dir);
  const files = fileReader({ workingDir: args.workingDir ?? ws.root, allowOutside: args.insecureFileRead });
  const resources = loadResources(ws);
  const requests = listRequests(ws);
  const data = args.iterationData === undefined ? undefined : await loadIterationData(args.iterationData);

  let target: RunTarget;
  if (args.selector === undefined) {
    target = await pickTarget(requests, [], undefined);
  } else {
    const resolved = resolveSelector(requests, args.selector);
    if (resolved.target) {
      target = resolved.target;
    } else if (resolved.candidates.length > 0) {
      target = await pickTarget(requests, resolved.candidates, args.selector);
    } else {
      throw new CliError(`no request or collection matches "${args.selector}"`, {
        details: requests.length > 0 ? ["available:", ...requests.map((r) => `  ${r.path}`)] : ["no requests found"],
      });
    }
  }

  const environment = await pickEnvironment(ws, args.env);
  const humanOutput = args.reporters.some(({ reporter }) => reporter.name === "cli");
  if (environment === undefined && humanOutput) {
    process.stderr.write(`${pc.yellow("warn: no environment selected; only --var values are available")}\n`);
  }

  // Highest precedence first: an explicit flag always beats the workspace file.
  const config = loadPremanConfig(ws);
  const certLayers: TlsCertLayer[] = [
    { label: CLI_CERT_LABEL, baseDir: process.cwd(), input: args.tlsCerts },
    ...(config === undefined
      ? []
      : [{ label: CONFIG_CERT_LABEL, baseDir: config.baseDir, input: config.tls }]),
  ];
  const tlsCerts = resolveTlsCerts(certLayers);
  if (humanOutput) {
    for (const warning of tlsCerts.warnings) {
      process.stderr.write(`${pc.yellow(`warn: ${warning}`)}\n`);
    }
  }

  const shared = {
    workspace: ws,
    tlsCerts,
    files,
    resources,
    environment,
    globals: loadGlobals(ws),
    localVars: args.vars,
    urlOverride: args.url,
    tlsOverride: args.tls,
    timeoutMs: args.timeoutMs,
    scriptTimeoutMs: args.scriptTimeoutMs,
    preferDescriptor: args.preferDescriptor,
    save: args.save,
  };

  if (target.kind === "group") {
    const group = await runGroup({
      ...shared,
      entries: target.group.requests,
      groupPath: target.group.path,
      bail: args.bail,
      iterationCount: resolveIterations(args.iterationCount, data?.rows ?? []),
      data: data?.rows ?? [],
      delayRequestMs: args.delayRequestMs,
      runTimeoutMs: args.runTimeoutMs,
    });
    const reports = renderReports({ kind: "group", outcome: group }, args.reporters, args.verbose);
    return {
      ...reports,
      exitCode: group.exitCode,
      outcome: undefined,
      group,
    };
  }

  if ((args.iterationCount ?? 1) > 1 || (data?.rows.length ?? 0) > 1) {
    throw new CliError(`iterations require a collection or folder; "${target.entry.path}" is a single request`, {
      details: ["run its parent collection or folder instead"],
    });
  }

  const outcome = await runRequest({ ...shared, entry: target.entry, data: data?.rows[0] });
  const reports = renderReports({ kind: "single", outcome }, args.reporters, args.verbose);
  return {
    ...reports,
    exitCode: outcome.exitCode,
    outcome,
    group: undefined,
  };
}
