import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { CliError } from "@/errors.js";

export interface Workspace {
  /** Directory containing `postman/`, and usually `.postman/`. */
  root: string;
  /**
   * Absolute path to `<root>/.postman/resources.yaml`, or undefined when the
   * workspace was found via `postman/collections` alone. Only gRPC needs it.
   */
  resourcesPath: string | undefined;
  /** Absolute path to `<root>/postman`. */
  postmanDir: string;
}

const RESOURCES_REL = join(".postman", "resources.yaml");
const COLLECTIONS_REL = join("postman", "collections");

/**
 * Walk up from `startDir` looking for `.postman/resources.yaml`, falling back to
 * `postman/collections`.
 *
 * The fallback exists because HTTP-only workspaces have no reason to declare proto
 * specs, and real repos ship `postman/` without `.postman/`. `.postman/resources.yaml`
 * still wins within a single directory so gRPC specs are never silently dropped.
 *
 * Returns null rather than throwing so callers can decide the message.
 */
export function findWorkspace(startDir: string): Workspace | null {
  let dir = resolve(startDir);
  const stopAt = parse(dir).root;

  for (;;) {
    const resources = join(dir, RESOURCES_REL);
    if (existsSync(resources)) {
      return { root: dir, resourcesPath: resources, postmanDir: join(dir, "postman") };
    }
    if (existsSync(join(dir, COLLECTIONS_REL))) {
      return { root: dir, resourcesPath: undefined, postmanDir: join(dir, "postman") };
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
    details: [`looked for ${RESOURCES_REL} or ${COLLECTIONS_REL}`, "pass --dir <path> to point at the repo explicitly"],
  });
}
