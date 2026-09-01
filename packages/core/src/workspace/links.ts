import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { EXIT, PremanError } from "@preman/core/errors.js";

/**
 * Where checkouts are linked so that a declared spec path means the same thing on
 * every machine.
 *
 * A path, not a front-end concern: the CLI and the desktop app both resolve specs
 * and must agree on this value, or a request that runs in one fails in the other.
 * Hence core owns it rather than either front end.
 */
export const DEFAULT_SHARED_PROTO_ROOT = "/Users/Shared/postman-protos";

/** Overrides {@link DEFAULT_SHARED_PROTO_ROOT}; the desktop sets it from its settings. */
export const SHARED_PROTO_ROOT_ENV = "PREMAN_SHARED_PROTO_ROOT";

export function sharedProtoRoot(): string {
  const override = process.env[SHARED_PROTO_ROOT_ENV];
  return override === undefined || override === "" ? DEFAULT_SHARED_PROTO_ROOT : resolve(override);
}

/**
 * The link `path` is reached through, or `undefined` if it does not sit under one.
 *
 * Deliberately does not check that the entry is a symlink: a real directory placed in
 * the shared root serves the same purpose, and refusing it would only produce a
 * confusing partial failure.
 */
export function linkRootFor(path: string, sharedRoot: string): string | undefined {
  const rel = relative(sharedRoot, resolve(path));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  const name = rel.split(sep)[0];
  return name === undefined || name === "" ? undefined : join(sharedRoot, name);
}

/** The link segment `path` is reached through — the name that has to exist locally. */
export function linkNameFor(path: string, sharedRoot: string): string | undefined {
  const linkRoot = linkRootFor(path, sharedRoot);
  return linkRoot === undefined ? undefined : linkRoot.slice(sharedRoot.length + sep.length);
}

/**
 * Reads a declared spec path against this machine's shared root.
 *
 * Spec paths are always *written* with {@link DEFAULT_SHARED_PROTO_ROOT} so that the
 * file means the same thing everywhere; a machine that has overridden the root swaps
 * the prefix on the way in. Without this the override would silently break the very
 * portability the shared root exists to provide.
 */
export function resolveSharedPath(declared: string, sharedRoot: string): string {
  if (sharedRoot === DEFAULT_SHARED_PROTO_ROOT) return declared;
  const rel = relative(DEFAULT_SHARED_PROTO_ROOT, declared);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return declared;
  return join(sharedRoot, rel);
}

/** The canonical, machine-independent way to declare a path reached through a link. */
export function declaredSharedPath(name: string, rest: string): string {
  return join(DEFAULT_SHARED_PROTO_ROOT, name, rest);
}

/**
 * How a resolved path should be written down, or `undefined` when it is not on a link.
 *
 * The inverse of {@link resolveSharedPath}: the index reports where a proto was read
 * from on this machine, and anything written into a workspace file has to name it the
 * canonical way instead. A method picker is the caller that needs this — it holds a
 * resolved spec path and has to put a `schema.location` in a request. Writing the
 * relative path from the request to a linked proto would count `../` segments off how
 * deep this checkout happens to sit, which is exactly the machine-dependence the shared
 * root removes.
 */
export function canonicalSharedPath(path: string, sharedRoot: string): string | undefined {
  const rel = relative(sharedRoot, resolve(path));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return join(DEFAULT_SHARED_PROTO_ROOT, rel);
}

/** What marks the top of a checkout: a directory in a clone, a file in a worktree. */
const REPO_MARKER = ".git";

/**
 * The checkout `path` belongs to, or `undefined` when nothing above it looks like one.
 *
 * The repository root is what a link points at, because linking it reproduces exactly
 * the import roots the same protos get when the workspace lives inside the repo — the
 * whole tree is walkable, so a package-qualified import resolves the way its authors
 * meant it to. A narrower target would have to guess which directory imports are
 * written against, and real repos disagree: one keeps them under `api/proto`, the next
 * under `api`, a third beside the file.
 */
export function repoRootFor(path: string): string | undefined {
  let dir = resolve(path);
  const stopAt = parse(dir).root;
  for (;;) {
    if (existsSync(join(dir, REPO_MARKER))) return dir;
    if (dir === stopAt) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface SharedLink {
  /** The single path segment under the shared root, e.g. `acquiring-core`. */
  name: string;
  /** Where it points, or `undefined` when the entry is a real directory. */
  target: string | undefined;
  /** Whether what it points at is there. A dangling link is the teammate-setup case. */
  resolves: boolean;
}

/** Reads one entry of the shared root, or `undefined` when the name is free. */
export function readSharedLink(sharedRoot: string, name: string): SharedLink | undefined {
  const path = join(sharedRoot, name);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return undefined;
  }
  const target = stat.isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : undefined;
  return { name, target, resolves: existsSync(path) };
}

/** Every entry of the shared root, name-sorted. Absent or unreadable roots list as empty. */
export function listSharedLinks(sharedRoot: string): SharedLink[] {
  let names: string[];
  try {
    names = readdirSync(sharedRoot);
  } catch {
    // Not an error: a machine that has never linked a checkout simply has no root yet.
    return [];
  }
  const links: SharedLink[] = [];
  for (const name of names.sort()) {
    const link = readSharedLink(sharedRoot, name);
    if (link !== undefined) links.push(link);
  }
  return links;
}

/**
 * Points `name` at `target`, creating the shared root if this is the machine's first link.
 *
 * Repointing is refused unless asked for explicitly. An existing link is load-bearing
 * for every workspace that declares a path through it, including ones that are not
 * open, so silently moving it would break them somewhere far from here.
 */
export function writeSharedLink(
  sharedRoot: string,
  name: string,
  target: string,
  options: { repoint?: boolean } = {},
): SharedLink {
  if (name === "" || name.includes(sep) || name === "." || name === "..") {
    throw new PremanError(`"${name}" is not a usable link name`, {
      details: ["a link name is one path segment, normally the repository directory name"],
    });
  }

  const resolvedTarget = resolve(target);
  if (!existsSync(resolvedTarget)) {
    throw new PremanError(`cannot link ${name}: ${resolvedTarget} does not exist`);
  }

  const path = join(sharedRoot, name);
  const existing = readSharedLink(sharedRoot, name);
  if (existing !== undefined) {
    if (existing.target === resolvedTarget) return existing;
    if (existing.target === undefined) {
      throw new PremanError(`${path} is a real directory, not a link`, {
        details: ["move it aside, or link this checkout under a different name"],
      });
    }
    if (options.repoint !== true) {
      throw new PremanError(`${name} already points at ${existing.target}`, {
        details: [
          `wanted: ${resolvedTarget}`,
          "repoint it only if no other workspace depends on the current target,",
          "otherwise link this checkout under a different name",
        ],
      });
    }
    unlinkSync(path);
  }

  try {
    mkdirSync(sharedRoot, { recursive: true });
    symlinkSync(resolvedTarget, path, "dir");
  } catch (cause) {
    throw new PremanError(`failed to link ${path} -> ${resolvedTarget}: ${(cause as Error).message}`, {
      exitCode: EXIT.CLI,
    });
  }
  return { name, target: resolvedTarget, resolves: true };
}

/** The link name a checkout would take: its own directory name. */
export function linkNameForRepo(repoRoot: string): string {
  return basename(resolve(repoRoot));
}
