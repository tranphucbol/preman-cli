import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { EXIT, PremanError } from "@preman/core/errors.js";

/** Node ids are posix regardless of host, so an id means the same thing on every platform. */
const ID_SEPARATOR = "/";

export const REQUEST_SUFFIX = ".request.yaml";
export const ENVIRONMENT_SUFFIX = ".environment.yaml";
export const RESOURCES_DIR = ".resources";
export const DEFINITION_FILE = "definition.yaml";
export const COLLECTIONS_DIR = "collections";
export const ENVIRONMENTS_DIR = "environments";
export const POSTMAN_DIR = "postman";
/**
 * The gap left between siblings. 1000 because real workspaces already write
 * `order: 1000` and `order: 3000`, so an insert lands between two siblings
 * without rewriting either.
 */
export const ORDER_STEP = 1000;

/**
 * Anything a filesystem or a human would misread inside a path segment. The control
 * range is the point of the rule, not an accident, hence the suppression.
 */
// eslint-disable-next-line no-control-regex -- a control code in a filename is exactly what this rejects
const UNSAFE_CHARACTERS = /[/\\:*?"<>|\u0000-\u001f]/g;
/** A segment that is entirely dots means "here" or "up one"; neither is a name. */
const ONLY_DOTS = /^\.+$/;
const COLLISION_LIMIT = 100;
const FIRST_COLLISION_SUFFIX = 2;

/**
 * The stable identity of a request, folder or collection: its path relative to the
 * workspace root, in posix form.
 *
 * The one place this is derived, so a `CatalogNode.id` and the `nodeId` on a run
 * event are the same string and the renderer can correlate them without a lookup
 * table.
 */
export function nodeIdFor(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join(ID_SEPARATOR);
}

/**
 * Turn a display name into a filesystem-safe path segment.
 *
 * Deliberately lossy and not reversible: the `name` field inside the file stays
 * authoritative, and the filename only has to be unambiguous on disk.
 */
export function sanitiseSegment(name: string): string {
  const cleaned = name.replace(UNSAFE_CHARACTERS, " ").replace(/\s+/g, " ").trim().replace(/\.+$/, "").trim();
  if (cleaned.length === 0 || ONLY_DOTS.test(cleaned)) {
    throw new PremanError(`"${name}" cannot be used as a file name`, {
      exitCode: EXIT.CLI,
      details: ["names must contain at least one character that is not a separator, a dot or a control code"],
    });
  }
  return cleaned;
}

/**
 * Find a free path by appending ` (2)`, ` (3)` and so on before the suffix.
 *
 * Postman's own disambiguation, and it keeps the base name readable — unlike a
 * timestamp or a hash.
 */
export function resolveCollision(dir: string, base: string, suffix: string): string {
  let candidate = join(dir, `${base}${suffix}`);
  for (let n = FIRST_COLLISION_SUFFIX; existsSync(candidate); n += 1) {
    if (n > COLLISION_LIMIT) {
      throw new PremanError(`cannot find a free name for "${base}" in ${dir}`, {
        exitCode: EXIT.CLI,
        details: [`tried up to "${base} (${COLLISION_LIMIT})${suffix}"`],
      });
    }
    candidate = join(dir, `${base} (${n})${suffix}`);
  }
  return candidate;
}

/** Where a request with this display name lives inside `dir`, collisions resolved. */
export function requestPathFor(dir: string, name: string): string {
  return resolveCollision(dir, sanitiseSegment(name), REQUEST_SUFFIX);
}

/** Where a group with this display name lives inside `dir`, collisions resolved. */
export function groupPathFor(dir: string, name: string): string {
  return resolveCollision(dir, sanitiseSegment(name), "");
}

/** Where an environment with this display name lives inside `dir`, collisions resolved. */
export function environmentPathFor(dir: string, name: string): string {
  return resolveCollision(dir, sanitiseSegment(name), ENVIRONMENT_SUFFIX);
}

/** The definition file that names and orders a collection or folder directory. */
export function definitionPathFor(dir: string): string {
  return join(dir, RESOURCES_DIR, DEFINITION_FILE);
}

/** The directory collections live in, given a workspace root. */
export function collectionsDirFor(root: string): string {
  return join(root, POSTMAN_DIR, COLLECTIONS_DIR);
}

/** The directory environments live in, given a workspace root. */
export function environmentsDirFor(root: string): string {
  return join(root, POSTMAN_DIR, ENVIRONMENTS_DIR);
}

/**
 * The `order` that puts a new sibling after every sibling that declares one.
 *
 * Not "last": a sibling with no `order` at all sorts after any number, and no value
 * here can beat that. Renumbering those siblings to fix it would rewrite files the
 * user did not touch, so the new node lands last among the ordered ones instead.
 */
export function nextOrder(existing: readonly (number | undefined)[]): number {
  const declared = existing.filter((order): order is number => typeof order === "number");
  if (declared.length === 0) return ORDER_STEP;
  return Math.max(...declared) + ORDER_STEP;
}
