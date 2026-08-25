import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import { PremanError } from "@preman/core/errors.js";
import { environmentSchema } from "./schemas.js";
import type { Workspace } from "./discover.js";

const ENV_SUFFIX = ".environment.yaml";
const ENV_DIR = "environments";
const GLOBALS_DIR = "globals";
const GLOBALS_FILE = "workspace.globals.yaml";

export interface EnvironmentEntry {
  filePath: string;
  /** `name` from the YAML, falling back to the filename stem. */
  name: string;
  /** Enabled key/value pairs, coerced to strings. */
  values: Record<string, string>;
}

export function listEnvironments(ws: Workspace): EnvironmentEntry[] {
  return listEnvironmentsIn(join(ws.postmanDir, ENV_DIR));
}

/**
 * The same list, given the directory rather than the workspace.
 *
 * For the mutation seam, which creates a file inside that directory and has a root rather
 * than a discovered workspace. Reading through here rather than scanning again is what keeps
 * a creation's idea of what already exists identical to a lookup's.
 */
export function listEnvironmentsIn(dir: string): EnvironmentEntry[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(ENV_SUFFIX))
    .map((e) => loadEnvironment(join(dir, e.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The filename stem, which `findEnvironment` accepts as a name and `loadEnvironment` falls back to. */
function stemOf(filePath: string): string {
  return basename(filePath).slice(0, -ENV_SUFFIX.length);
}

/** Where workspace globals live, whether or not anyone has written the file yet. */
export function globalsFile(ws: Workspace): string {
  return join(ws.postmanDir, GLOBALS_DIR, GLOBALS_FILE);
}

/**
 * Workspace globals (`postman/globals/workspace.globals.yaml`).
 * Same file shape as an environment; absent file means "no globals".
 */
export function loadGlobals(ws: Workspace): Record<string, string> {
  const filePath = globalsFile(ws);
  return existsSync(filePath) ? loadEnvironment(filePath).values : {};
}

export function loadEnvironment(filePath: string): EnvironmentEntry {
  let raw: unknown;
  try {
    raw = parseDocument(readFileSync(filePath, "utf8")).toJS() ?? {};
  } catch (cause) {
    throw new PremanError(`failed to parse ${filePath}: ${(cause as Error).message}`);
  }

  const parsed = environmentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PremanError(`unexpected shape in ${filePath}`, {
      details: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
    });
  }

  const values: Record<string, string> = {};
  for (const item of parsed.data.values) {
    // `enabled: false` mirrors an unchecked row in the Postman UI.
    if (item.enabled === false) continue;
    values[item.key] = item.value == null ? "" : String(item.value);
  }

  const stem = basename(filePath).slice(0, -ENV_SUFFIX.length);
  return { filePath, name: parsed.data.name?.trim() || stem, values };
}

export function findEnvironment(ws: Workspace, name: string): EnvironmentEntry | undefined {
  const needle = name.trim().toLowerCase();
  const all = listEnvironments(ws);
  return (
    all.find((e) => e.name.toLowerCase() === needle) ?? all.find((e) => stemOf(e.filePath).toLowerCase() === needle)
  );
}

/**
 * The display name `name` would already resolve to in `dir`, if any.
 *
 * Deliberately `findEnvironment`'s matching rather than a filename check: an environment is
 * addressed by name — by `-e`, by the picker, by `writeEnvironmentValue` — so two files a
 * lookup cannot tell apart are two files one of them silently loses. A creation that would
 * produce that pair has to be refused, and it can only know so by asking the same question
 * the lookup will ask. Returns the existing name, so the refusal can quote it.
 */
export function existingEnvironmentName(dir: string, name: string): string | undefined {
  const needle = name.trim().toLowerCase();
  return listEnvironmentsIn(dir).find(
    (entry) => entry.name.toLowerCase() === needle || stemOf(entry.filePath).toLowerCase() === needle,
  )?.name;
}

/**
 * Write `updates` into an environment file **in place**.
 *
 * Uses the YAML CST document rather than re-serialising a JS object, so comments,
 * key order and quoting style all survive. Keys not already present are appended
 * to `values` in the same shape Postman writes them.
 */
export function saveEnvironmentValues(filePath: string, updates: Record<string, string>): void {
  const keys = Object.keys(updates);
  if (keys.length === 0) return;

  const doc = parseDocument(readFileSync(filePath, "utf8"));
  let seq = doc.get("values");
  if (!isSeq(seq)) {
    doc.set("values", (seq = doc.createNode([])));
    if (!isSeq(seq)) throw new PremanError(`cannot write values into ${filePath}`);
  }

  for (const key of keys) {
    const value = updates[key] ?? "";
    const existing = seq.items.find((item) => isMap(item) && item.get("key") === key);
    if (existing && isMap(existing)) {
      existing.set("value", value);
    } else {
      seq.add(doc.createNode({ key, value }));
    }
  }

  writeFileSync(filePath, doc.toString(), "utf8");
}
