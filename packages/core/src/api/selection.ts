/**
 * Turning a selector and an `--env` into the one request and one environment a call needs.
 *
 * Shared by `api/run.ts` and `api/command.ts` so the two cannot disagree about which environment
 * is in play — a copy that resolved `{{base_url}}` out of a different environment than a run
 * would is worse than no copy. It lives in its own module rather than in `run.ts` because
 * `run.ts` imports the runner, and the runner imports both transports; the copy path must be able
 * to reach this without loading a socket library (ADR 029).
 */
import { PremanError } from "@preman/core/errors.js";
import { resolveSelector, type RequestEntry, type RunTarget } from "@preman/core/workspace/collections.js";
import type { Workspace } from "@preman/core/workspace/discover.js";
import { listEnvironments, type EnvironmentEntry } from "@preman/core/workspace/environments.js";
import type { SelectionPort } from "./select.js";

/** Layer labels, echoed back to the user when a certificate cannot be read. */
export const CLI_CERT_LABEL = "--ssl-*";
export const CONFIG_CERT_LABEL = ".postman/preman.yaml";
export const NO_ENVIRONMENT_WARNING = "no environment selected; only --var values are available";

const SOLE = 1;
const NONE = 0;

async function chooseTarget(
  choices: RunTarget[],
  selector: string | undefined,
  port: SelectionPort,
): Promise<RunTarget> {
  if (choices.length === NONE) throw new PremanError("no requests found under postman/collections");
  if (choices.length === SOLE) return choices[0]!;
  return port.pickRequest(choices, selector);
}

export async function selectTarget(
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
  if (resolved.candidates.length > NONE) return chooseTarget(resolved.candidates, selector, port);

  throw new PremanError(`no request or collection matches "${selector}"`, {
    details: requests.length > NONE ? ["available:", ...requests.map((r) => `  ${r.path}`)] : ["no requests found"],
  });
}

export async function selectEnvironment(
  ws: Workspace,
  name: string | null | undefined,
  port: SelectionPort,
): Promise<EnvironmentEntry | undefined> {
  // "None" is an answer, not a missing one: never adopt a sole environment, never ask.
  if (name === null) return undefined;

  const all = listEnvironments(ws);

  if (name !== undefined) {
    const needle = name.trim().toLowerCase();
    const found = all.find((e) => e.name.toLowerCase() === needle);
    if (found) return found;
    throw new PremanError(`environment "${name}" not found`, {
      details: all.length > NONE ? ["available:", ...all.map((e) => `  ${e.name}`)] : ["no environments exist"],
    });
  }

  if (all.length === NONE) return undefined;
  if (all.length === SOLE) return all[0]!;
  return port.pickEnvironment(all);
}
