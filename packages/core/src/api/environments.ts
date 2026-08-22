import { PremanError } from "@preman/core/errors.js";
import { requireWorkspace, type Workspace } from "@preman/core/workspace/discover.js";
import {
  findEnvironment,
  listEnvironments,
  saveEnvironmentValues,
  type EnvironmentEntry,
} from "@preman/core/workspace/environments.js";

export interface EnvironmentView {
  name: string;
  file: string;
  values: Record<string, string>;
}

export interface EnvironmentWrite {
  name: string;
  file: string;
  key: string;
  value: string;
}

/**
 * Pick the environment to operate on: the named one, or the only one that exists.
 * Ambiguity is an error rather than a guess, so a `--env` typo cannot silently
 * send a request at the wrong host.
 */
export function selectEnvironment(ws: Workspace, name: string | undefined): EnvironmentEntry {
  const all = listEnvironments(ws);
  if (all.length === 0) throw new PremanError("no environments found under postman/environments");

  if (name !== undefined) {
    const found = findEnvironment(ws, name);
    if (found) return found;
    throw new PremanError(`environment "${name}" not found`, {
      details: ["available:", ...all.map((e) => `  ${e.name}`)],
    });
  }

  if (all.length === 1) return all[0]!;
  throw new PremanError("multiple environments exist; pass -e <NAME>", {
    details: ["available:", ...all.map((e) => `  ${e.name}`)],
  });
}

export function readEnvironment(dir: string, name: string | undefined): EnvironmentView {
  const env = selectEnvironment(requireWorkspace(dir), name);
  return { name: env.name, file: env.filePath, values: env.values };
}

export function writeEnvironmentValue(
  dir: string,
  name: string | undefined,
  key: string,
  value: string,
): EnvironmentWrite {
  const env = selectEnvironment(requireWorkspace(dir), name);
  saveEnvironmentValues(env.filePath, { [key]: value });
  return { name: env.name, file: env.filePath, key, value };
}
