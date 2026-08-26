import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { EXIT, PremanError } from "@preman/core/errors.js";
import { TEMP_SUFFIX } from "./atomic.js";

/** Node ids are posix regardless of host, so an id means the same thing on every platform. */
const ID_SEPARATOR = "/";

export const REQUEST_SUFFIX = ".request.yaml";
export const ENVIRONMENT_SUFFIX = ".environment.yaml";
export const RESOURCES_DIR = ".resources";
export const DEFINITION_FILE = "definition.yaml";
export const COLLECTIONS_DIR = "collections";
export const ENVIRONMENTS_DIR = "environments";
export const POSTMAN_DIR = "postman";
/** The dot-directory holding `resources.yaml`; `discover.ts` looks for exactly this pair. */
export const DOT_POSTMAN_DIR = ".postman";
export const RESOURCES_FILE = "resources.yaml";
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
 * How much of a display name can survive into a filename.
 *
 * 255 bytes is the per-component limit on APFS, ext4 and NTFS alike, and it is bytes rather than
 * characters — a name in Vietnamese reaches it in two thirds of the characters. Everything a
 * caller appends after sanitising has to land inside the same 255, so the longest suffix preman
 * writes, a collision marker on top of it, and the temp suffix `writeFileAtomic` appends on top
 * of that are all reserved here rather than at each call site. Real workspaces do reach this: a
 * request named after a URL with a query string in it is over 250 characters before anything is
 * appended, and the atomic write is what finally overflowed.
 */
const MAX_SEGMENT_BYTES = 255;
const COLLISION_MARKER = ` (${COLLISION_LIMIT})`;
const MAX_NAME_BYTES = MAX_SEGMENT_BYTES - ENVIRONMENT_SUFFIX.length - COLLISION_MARKER.length - TEMP_SUFFIX.length;

/** Collapse runs of whitespace and drop what a filesystem will not keep at the end. */
function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\.+$/, "").trim();
}

/** The longest prefix of `text` that fits in `limit` bytes, never splitting a character. */
function truncateBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  let bytes = 0;
  let kept = "";
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > limit) break;
    bytes += size;
    kept += character;
  }
  return kept;
}

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
 * authoritative, and the filename only has to be unambiguous on disk. Length is lossy for the
 * same reason — a name too long for the filesystem is truncated rather than rejected, and two
 * names that truncate to the same prefix are told apart by {@link resolveCollisionWith}.
 */
export function sanitiseSegment(name: string): string {
  // The tidy pass runs again after truncation, which can strand a trailing space or dot.
  const cleaned = tidy(truncateBytes(tidy(name.replace(UNSAFE_CHARACTERS, " ")), MAX_NAME_BYTES));
  if (cleaned.length === 0 || ONLY_DOTS.test(cleaned)) {
    throw new PremanError(`"${name}" cannot be used as a file name`, {
      exitCode: EXIT.CLI,
      details: ["names must contain at least one character that is not a separator, a dot or a control code"],
    });
  }
  return cleaned;
}

/**
 * The first of `base`, `base (2)`, `base (3)`… with `suffix` appended that `isTaken` rejects.
 *
 * Postman's own disambiguation, and it keeps the base name readable — unlike a timestamp or a
 * hash. Split out from `resolveCollision` because a migration plan resolves collisions against
 * a set of names it is still building, with no filesystem to ask (ADR 033), and two
 * disambiguation conventions in one codebase is one too many.
 */
export function resolveCollisionWith(isTaken: (candidate: string) => boolean, base: string, suffix: string): string {
  let candidate = `${base}${suffix}`;
  for (let n = FIRST_COLLISION_SUFFIX; isTaken(candidate); n += 1) {
    if (n > COLLISION_LIMIT) {
      throw new PremanError(`cannot find a free name for "${base}"`, {
        exitCode: EXIT.CLI,
        details: [`tried up to "${base} (${COLLISION_LIMIT})${suffix}"`],
      });
    }
    candidate = `${base} (${n})${suffix}`;
  }
  return candidate;
}

/** Find a free path in `dir` by appending ` (2)`, ` (3)` and so on before the suffix. */
export function resolveCollision(dir: string, base: string, suffix: string): string {
  return join(
    dir,
    resolveCollisionWith((candidate) => existsSync(join(dir, candidate)), base, suffix),
  );
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
