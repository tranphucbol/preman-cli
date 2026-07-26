import pc from "picocolors";
import { CliError, type ExitCode } from "../errors.js";
import { renderGroupOutcome, renderOutcome } from "../output/render.js";
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

export interface RunArgs {
  dir: string;
  selector: string | undefined;
  env: string | undefined;
  url: string | undefined;
  tls: boolean | undefined;
  /** Raw `--ssl-*` and `-k` values; resolved here, where the workspace is known. */
  tlsCerts: TlsCertInput;
  timeoutMs: number;
  vars: Record<string, string>;
  save: boolean;
  preferDescriptor: boolean;
  /** Stop a collection run at the first request that does not fully succeed. */
  bail: boolean;
  json: boolean;
  verbose: boolean;
}

/** Layer labels, echoed back to the user when a certificate cannot be read. */
const CLI_CERT_LABEL = "--ssl-*";
const CONFIG_CERT_LABEL = ".postman/preman.yaml";

export interface RunCommandResult {
  output: string;
  exitCode: ExitCode;
  /** Set for a single-request run. */
  outcome: RunOutcome | undefined;
  /** Set for a collection or folder run. */
  group: GroupRunOutcome | undefined;
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

export async function commandRun(args: RunArgs): Promise<RunCommandResult> {
  const ws = requireWorkspace(args.dir);
  const resources = loadResources(ws);
  const requests = listRequests(ws);

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
  if (environment === undefined && !args.json) {
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
  if (!args.json) {
    for (const warning of tlsCerts.warnings) {
      process.stderr.write(`${pc.yellow(`warn: ${warning}`)}\n`);
    }
  }

  const shared = {
    workspace: ws,
    tlsCerts,
    resources,
    environment,
    globals: loadGlobals(ws),
    localVars: args.vars,
    urlOverride: args.url,
    tlsOverride: args.tls,
    timeoutMs: args.timeoutMs,
    preferDescriptor: args.preferDescriptor,
    save: args.save,
  };

  if (target.kind === "group") {
    const group = await runGroup({ ...shared, entries: target.group.requests, groupPath: target.group.path, bail: args.bail });
    return {
      output: renderGroupOutcome(group, { verbose: args.verbose, json: args.json }),
      exitCode: group.exitCode,
      outcome: undefined,
      group,
    };
  }

  const outcome = await runRequest({ ...shared, entry: target.entry });
  return {
    output: renderOutcome(outcome, { verbose: args.verbose, json: args.json }),
    exitCode: outcome.exitCode,
    outcome,
    group: undefined,
  };
}
