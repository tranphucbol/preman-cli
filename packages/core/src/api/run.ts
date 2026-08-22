import { loadIterationData, type DataRow } from "@preman/core/data/rows.js";
import { EXIT, PremanError, type ExitCode } from "@preman/core/errors.js";
import { runGroup, runRequest, type GroupRunOutcome, type RunOutcome } from "@preman/core/runner.js";
import { resolveTlsCerts, type TlsCertInput, type TlsCertLayer } from "@preman/core/tls/certs.js";
import {
  listRequests,
  resolveSelector,
  type RequestEntry,
  type RunTarget,
} from "@preman/core/workspace/collections.js";
import { loadPremanConfig } from "@preman/core/workspace/config.js";
import { requireWorkspace, type Workspace } from "@preman/core/workspace/discover.js";
import { listEnvironments, loadGlobals, type EnvironmentEntry } from "@preman/core/workspace/environments.js";
import { fileReader } from "@preman/core/workspace/files.js";
import { loadResources } from "@preman/core/workspace/resources.js";
import type { BodyStore } from "./bodies.js";
import type { RunEventSink } from "./events.js";
import { failOnAmbiguity, type SelectionPort } from "./select.js";

/** Layer labels, echoed back to the user when a certificate cannot be read. */
const CLI_CERT_LABEL = "--ssl-*";
const CONFIG_CERT_LABEL = ".postman/preman.yaml";
const NO_ENVIRONMENT_WARNING = "no environment selected; only --var values are available";
/** A single-request run has exactly one request to report progress against. */
const SINGLE_REQUEST_TOTAL = 1;

export interface RunSelectionArgs {
  dir: string;
  selector: string | undefined;
  env: string | undefined;
  url: string | undefined;
  tls: boolean | undefined;
  /** Raw `--ssl-*` and `-k` values; resolved here, where the workspace is known. */
  tlsCerts: TlsCertInput;
  /** Where relative certificate paths are anchored. Distinct from `dir`. */
  certBaseDir: string;
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
  workingDir: string | undefined;
  insecureFileRead: boolean;
  /** Expose `eval` to scripts. Also settable per workspace via `.postman/preman.yaml`. */
  safeEval: boolean;
  /** How to resolve ambiguity. Defaults to refusing and listing the candidates. */
  select?: SelectionPort;
  /** Report progress as it happens. Omitted by the CLI, which waits for the result. */
  sink?: RunEventSink;
  /** Where response bodies are deposited so the events can name them, not carry them. */
  bodies?: BodyStore;
}

export interface RunSelectionResult {
  /** Set for a single-request run. */
  outcome: RunOutcome | undefined;
  /** Set for a collection or folder run. */
  group: GroupRunOutcome | undefined;
  exitCode: ExitCode;
  /** Advisory messages, unfiltered; the caller decides whether anyone sees them. */
  warnings: string[];
}

export function resolveIterations(requested: number | undefined, rows: DataRow[]): number {
  return requested ?? (rows.length > 0 ? rows.length : 1);
}

async function chooseTarget(
  choices: RunTarget[],
  selector: string | undefined,
  port: SelectionPort,
): Promise<RunTarget> {
  if (choices.length === 0) throw new PremanError("no requests found under postman/collections");
  if (choices.length === 1) return choices[0]!;
  return port.pickRequest(choices, selector);
}

async function selectTarget(
  requests: RequestEntry[],
  selector: string | undefined,
  port: SelectionPort,
): Promise<RunTarget> {
  if (selector === undefined) {
    return chooseTarget(
      requests.map((entry) => ({ kind: "request", entry })),
      undefined,
      port,
    );
  }

  const resolved = resolveSelector(requests, selector);
  if (resolved.target) return resolved.target;
  if (resolved.candidates.length > 0) return chooseTarget(resolved.candidates, selector, port);

  throw new PremanError(`no request or collection matches "${selector}"`, {
    details: requests.length > 0 ? ["available:", ...requests.map((r) => `  ${r.path}`)] : ["no requests found"],
  });
}

async function selectRunEnvironment(
  ws: Workspace,
  name: string | undefined,
  port: SelectionPort,
): Promise<EnvironmentEntry | undefined> {
  const all = listEnvironments(ws);

  if (name !== undefined) {
    const needle = name.trim().toLowerCase();
    const found = all.find((e) => e.name.toLowerCase() === needle);
    if (found) return found;
    throw new PremanError(`environment "${name}" not found`, {
      details: all.length > 0 ? ["available:", ...all.map((e) => `  ${e.name}`)] : ["no environments exist"],
    });
  }

  if (all.length === 0) return undefined;
  if (all.length === 1) return all[0]!;
  return port.pickEnvironment(all);
}

/**
 * Resolve what to run, run it, and hand back outcomes plus warnings. Nothing here
 * knows whether a human, a file or a GUI is on the other end.
 */
export async function runSelection(args: RunSelectionArgs): Promise<RunSelectionResult> {
  const port = args.select ?? failOnAmbiguity;
  const ws = requireWorkspace(args.dir);
  const files = fileReader({ workingDir: args.workingDir ?? ws.root, allowOutside: args.insecureFileRead });
  const resources = loadResources(ws);
  const requests = listRequests(ws);
  const data = args.iterationData === undefined ? undefined : await loadIterationData(args.iterationData);

  const target = await selectTarget(requests, args.selector, port);
  const environment = await selectRunEnvironment(ws, args.env, port);
  const warnings: string[] = environment === undefined ? [NO_ENVIRONMENT_WARNING] : [];

  // Highest precedence first: an explicit flag always beats the workspace file.
  const config = loadPremanConfig(ws);
  const certLayers: TlsCertLayer[] = [
    { label: CLI_CERT_LABEL, baseDir: args.certBaseDir, input: args.tlsCerts },
    ...(config === undefined ? [] : [{ label: CONFIG_CERT_LABEL, baseDir: config.baseDir, input: config.tls }]),
  ];
  const tlsCerts = resolveTlsCerts(certLayers);
  warnings.push(...tlsCerts.warnings);

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
    // The flag forces it on; the workspace config opts a checked-out repo in once.
    safeEval: args.safeEval || config?.safeEval === true,
    preferDescriptor: args.preferDescriptor,
    save: args.save,
    ...(args.sink === undefined ? {} : { sink: args.sink }),
    ...(args.bodies === undefined ? {} : { bodies: args.bodies }),
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
    return { outcome: undefined, group, exitCode: group.exitCode, warnings };
  }

  if ((args.iterationCount ?? 1) > 1 || (data?.rows.length ?? 0) > 1) {
    throw new PremanError(`iterations require a collection or folder; "${target.entry.path}" is a single request`, {
      details: ["run its parent collection or folder instead"],
    });
  }

  // `runGroup` owns the run boundary for a group; a lone request has no group to own
  // it, so the seam that decided to run one emits it. Either way a listener sees
  // exactly one `run-start` and one `run-end`.
  const sink = args.sink;
  sink?.emit({ type: "run-start", runId: sink.runId, total: SINGLE_REQUEST_TOTAL });
  try {
    const outcome = await runRequest({ ...shared, entry: target.entry, data: data?.rows[0] });
    sink?.emit({ type: "run-end", runId: sink.runId, exitCode: outcome.exitCode });
    return { outcome, group: undefined, exitCode: outcome.exitCode, warnings };
  } catch (cause) {
    sink?.emit({ type: "run-end", runId: sink.runId, exitCode: EXIT.CLI });
    throw cause;
  }
}
