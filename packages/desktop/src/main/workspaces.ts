/**
 * Making a workspace, and the only place that knows where a new one goes.
 *
 * Construction only: this creates directories and hands back a path. Registering the result and
 * starting a host for it stays in `main.ts`, on the same path an existing workspace takes, so
 * creating one cannot grow a second host lifecycle of its own.
 */
import { mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";

import type { CreateWorkspaceResult } from "@preman/desktop/preload/bridge.js";

/**
 * Where every workspace this app creates lives, spelled out once so the location is reviewable in
 * one declaration rather than assembled from literals across the success and failure paths.
 *
 * A Linux-shaped path on every platform, deliberately. It is a product decision about where preman
 * keeps the workspaces it makes, not a guess at what the OS would prefer, so `documents`,
 * `userData` and `XDG_DATA_HOME` are all wrong answers to it. A user who wants a root elsewhere
 * creates it outside the app and uses `Open workspace…`.
 */
const WORKSPACE_PARENT_SEGMENTS = [".local", "share", "preman", "workspace"] as const;
/**
 * The one hierarchy a new workspace gets, and nothing else: no sample collection, no request, no
 * environment, no `.postman/resources.yaml`. Core already accepts `postman/collections` on its own
 * as a workspace marker (`packages/core/src/workspace/discover.ts`), so this is the whole of what
 * makes the result openable.
 */
const SCAFFOLD_SEGMENTS = ["postman", "collections"] as const;

/** The names that are a path instruction rather than a directory name. */
const RESERVED_NAMES = new Set([".", ".."]);
/** `/` and `\` both, on every platform: a name is one segment, never a path. */
const SEPARATORS = /[/\\]/;
/** Below this is NUL and the C0 controls; `0x7f` is DEL. None belongs in a name from a text field. */
const FIRST_PRINTABLE_CODE = 0x20;
const DELETE_CODE = 0x7f;

const EXISTS_CODE = "EEXIST";

const EMPTY_NAME_MESSAGE = "A workspace needs a name.";
const UNSAFE_NAME_MESSAGE =
  "A workspace name must be a single directory name: no slashes, no control characters, and not . or ..";

/** A name from a text field, so a scan rather than a regex — `no-control-regex` is right to object. */
function hasControlCharacter(name: string): boolean {
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code < FIRST_PRINTABLE_CODE || code === DELETE_CODE) return true;
  }
  return false;
}

function isUnsafe(name: string): boolean {
  return RESERVED_NAMES.has(name) || SEPARATORS.test(name) || hasControlCharacter(name);
}

/** Never swallow the cause: the whole value of an I/O failure is what the file system said. */
function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function alreadyExists(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === EXISTS_CODE;
}

/**
 * Undo exactly what was made, and only while it is still empty.
 *
 * Deepest first and non-recursive, because recursive deletion of a path this call did not fill
 * would risk bytes it does not own. The first directory that will not come away stops the walk;
 * the error the caller is already returning names the path, so nothing is lost by leaving it.
 */
async function removeScaffold(root: string): Promise<void> {
  const made = SCAFFOLD_SEGMENTS.map((_segment, index) => join(root, ...SCAFFOLD_SEGMENTS.slice(0, index + 1)));
  for (const path of [...made].reverse().concat(root)) {
    try {
      await rmdir(path);
    } catch {
      return;
    }
  }
}

/**
 * Create an empty workspace called `name` under `homeDir`.
 *
 * `homeDir` is a parameter rather than a `homedir()` call inside, so a test can point the whole
 * operation at a temporary directory and never write to the real one.
 */
export async function createWorkspace(homeDir: string, name: string): Promise<CreateWorkspaceResult> {
  // Trim and validate before anything is created: an unusable name has no file system side effect.
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, message: EMPTY_NAME_MESSAGE };
  if (isUnsafe(trimmed)) return { ok: false, message: UNSAFE_NAME_MESSAGE };

  const parent = join(homeDir, ...WORKSPACE_PARENT_SEGMENTS);
  const root = join(parent, trimmed);

  try {
    await mkdir(parent, { recursive: true });
  } catch (cause) {
    return { ok: false, message: `Could not create ${parent}: ${reason(cause)}` };
  }

  try {
    // Not `recursive`, and that is the point: an exclusive `mkdir` is what turns an existing
    // directory, file or symlink into a reported collision instead of a silent adoption, and it
    // leaves no gap for a second attempt to slip through between a check and a create.
    await mkdir(root);
  } catch (cause) {
    if (alreadyExists(cause)) {
      return { ok: false, message: `${root} already exists. Choose another name, or open it with Open workspace…` };
    }
    return { ok: false, message: `Could not create ${root}: ${reason(cause)}` };
  }

  const scaffold = join(root, ...SCAFFOLD_SEGMENTS);
  try {
    await mkdir(scaffold, { recursive: true });
  } catch (cause) {
    await removeScaffold(root);
    return { ok: false, message: `Could not create ${scaffold}: ${reason(cause)}` };
  }

  return { ok: true, root };
}
