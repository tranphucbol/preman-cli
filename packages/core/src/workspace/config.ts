import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CliError } from "@preman/core/errors.js";
import type { TlsCertInput } from "@preman/core/tls/certs.js";
import { premanConfigSchema } from "./schemas.js";
import type { Workspace } from "./discover.js";

export interface PremanConfig {
  tls: TlsCertInput;
  /** Expose `eval` to scripts for every run in this workspace. */
  safeEval: boolean;
  /** Directory the config's relative paths resolve against: `<root>/.postman`. */
  baseDir: string;
}

const PREMAN_CONFIG_REL = join(".postman", "preman.yaml");

/** Where the config lives, whether or not it exists. */
export function premanConfigPath(ws: Workspace): string {
  return join(ws.root, PREMAN_CONFIG_REL);
}

/**
 * Read `.postman/preman.yaml`.
 *
 * Returns undefined when the file is absent: the config is optional, so a missing
 * one is the normal case and never a warning. A malformed one is an error, because
 * silently ignoring a config the user wrote is worse than refusing to run.
 */
export function loadPremanConfig(ws: Workspace): PremanConfig | undefined {
  const path = premanConfigPath(ws);
  if (!existsSync(path)) return undefined;

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new CliError(`failed to parse ${path}: ${(cause as Error).message}`);
  }

  const parsed = premanConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new CliError(`unexpected shape in ${path}`, {
      details: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
    });
  }

  // Certificate paths are relative to `.postman/`, matching resources.yaml's specs.
  return { tls: parsed.data.tls ?? {}, safeEval: parsed.data.safeEval === true, baseDir: dirname(path) };
}
