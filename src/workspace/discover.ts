import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { CliError } from "../errors.js";

export interface Workspace {
  /** Directory containing `.postman/` and `postman/`. */
  root: string;
  /** Absolute path to `<root>/.postman/resources.yaml`. */
  resourcesPath: string;
  /** Absolute path to `<root>/postman`. */
  postmanDir: string;
}

const RESOURCES_REL = join(".postman", "resources.yaml");

/**
 * Walk up from `startDir` looking for `.postman/resources.yaml`.
 * Returns null rather than throwing so callers can decide the message.
 */
export function findWorkspace(startDir: string): Workspace | null {
  let dir = resolve(startDir);
  const stopAt = parse(dir).root;

  for (;;) {
    const candidate = join(dir, RESOURCES_REL);
    if (existsSync(candidate)) {
      return { root: dir, resourcesPath: candidate, postmanDir: join(dir, "postman") };
    }
    if (dir === stopAt) return null;
    const parent = dirname(dir);
    // Defensive: dirname() of a root is the root itself on every platform.
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Same as {@link findWorkspace} but throws a user-facing error when not found. */
export function requireWorkspace(startDir: string): Workspace {
  const ws = findWorkspace(startDir);
  if (ws) return ws;
  throw new CliError(`no Postman workspace found in ${resolve(startDir)} or any parent directory`, {
    details: [`looked for ${RESOURCES_REL}`, "pass --dir <path> to point at the repo explicitly"],
  });
}
