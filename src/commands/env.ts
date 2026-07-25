import pc from "picocolors";
import { CliError } from "../errors.js";
import { requireWorkspace } from "../workspace/discover.js";
import { findEnvironment, listEnvironments, saveEnvironmentValues } from "../workspace/environments.js";
import type { EnvironmentEntry } from "../workspace/environments.js";
import type { Workspace } from "../workspace/discover.js";

export interface EnvArgs {
  dir: string;
  env: string | undefined;
  json: boolean;
}

/**
 * Pick the environment to operate on: the named one, or the only one that exists.
 * Ambiguity is an error rather than a guess, so a `--env` typo cannot silently
 * send a request at the wrong host.
 */
export function selectEnvironment(ws: Workspace, name: string | undefined): EnvironmentEntry {
  const all = listEnvironments(ws);
  if (all.length === 0) throw new CliError("no environments found under postman/environments");

  if (name !== undefined) {
    const found = findEnvironment(ws, name);
    if (found) return found;
    throw new CliError(`environment "${name}" not found`, {
      details: ["available:", ...all.map((e) => `  ${e.name}`)],
    });
  }

  if (all.length === 1) return all[0]!;
  throw new CliError("multiple environments exist; pass -e <NAME>", {
    details: ["available:", ...all.map((e) => `  ${e.name}`)],
  });
}

export function commandEnvShow(args: EnvArgs): string {
  const ws = requireWorkspace(args.dir);
  const env = selectEnvironment(ws, args.env);

  if (args.json) return JSON.stringify({ name: env.name, file: env.filePath, values: env.values }, null, 2);

  const lines = [pc.bold(env.name), pc.dim(env.filePath), ""];
  const keys = Object.keys(env.values).sort();
  if (keys.length === 0) lines.push(pc.yellow("(no variables)"));
  for (const key of keys) {
    const value = env.values[key] ?? "";
    lines.push(`  ${pc.cyan(key)} = ${value.length > 0 ? value : pc.dim("(empty)")}`);
  }
  return lines.join("\n");
}

export function commandEnvSet(args: EnvArgs & { key: string; value: string }): string {
  const ws = requireWorkspace(args.dir);
  const env = selectEnvironment(ws, args.env);
  saveEnvironmentValues(env.filePath, { [args.key]: args.value });

  if (args.json) return JSON.stringify({ name: env.name, file: env.filePath, key: args.key, value: args.value }, null, 2);
  return `set ${pc.cyan(args.key)}=${args.value} in ${env.name} ${pc.dim(`(${env.filePath})`)}`;
}
