import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isMap, isSeq, parseDocument, type Document } from "yaml";
import { PremanError } from "@preman/core/errors.js";
import { environmentSchema } from "./schemas.js";
import type { Workspace } from "./discover.js";
import { personalEnvironmentsDirFor } from "./paths.js";

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
  /** Set when the file lives in the user's personal directory rather than the workspace. */
  personal?: true;
}

/**
 * Every environment a run can select: the workspace's shared ones, then the user's personal
 * ones for this workspace (`personalEnvironmentsDirFor`), sorted together by name.
 *
 * Personal environments are files outside the checkout, so they can hold a developer's own
 * hosts and credentials without a diff in the repository. Both kinds are addressed by name and
 * nothing else; {@link findEnvironment} refuses a name that both answer to.
 */
export function listEnvironments(ws: Workspace): EnvironmentEntry[] {
  const shared = listEnvironmentsIn(join(ws.postmanDir, ENV_DIR));
  const personal = listEnvironmentsIn(personalEnvironmentsDirFor(ws.root)).map((entry) => ({
    ...entry,
    personal: true as const,
  }));
  return personal.length === 0 ? shared : [...shared, ...personal].sort((a, b) => a.name.localeCompare(b.name));
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
  const pick = (entries: readonly EnvironmentEntry[]): EnvironmentEntry | undefined =>
    entries.find((e) => e.name.toLowerCase() === needle) ??
    entries.find((e) => stemOf(e.filePath).toLowerCase() === needle);

  const shared = pick(all.filter((e) => e.personal !== true));
  const personal = pick(all.filter((e) => e.personal === true));
  // Creation refuses a name the other directory already uses, so this is a file someone copied
  // in by hand. Picking either would send at a host the user may not have meant.
  if (shared !== undefined && personal !== undefined) {
    throw new PremanError(`environment "${name}" is both a shared and a personal environment`, {
      details: [`shared: ${shared.filePath}`, `personal: ${personal.filePath}`, "rename or delete one of them"],
    });
  }
  return shared ?? personal;
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
  setKeyedValues(doc, VALUES_FIELD, updates, filePath);
  writeFileSync(filePath, doc.toString(), "utf8");
}

const VALUES_FIELD = "values";

/**
 * Set `updates` on the `{ key, value }` list under `field`, creating the list when the document
 * has none. Shared by environment files (`values:`) and collection definitions (`variables:`),
 * which are the same list under two names.
 */
export function setKeyedValues(doc: Document, field: string, updates: Record<string, string>, filePath: string): void {
  let seq = doc.get(field);
  if (!isSeq(seq)) {
    doc.set(field, (seq = doc.createNode([])));
    if (!isSeq(seq)) throw new PremanError(`cannot write ${field} into ${filePath}`);
  }

  for (const [key, value] of Object.entries(updates)) {
    const existing = seq.items.find((item) => isMap(item) && item.get("key") === key);
    if (existing && isMap(existing)) {
      existing.set("value", value);
    } else {
      seq.add(doc.createNode({ key, value }));
    }
  }
}
