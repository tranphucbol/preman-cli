/**
 * Reading a request document in the renderer.
 *
 * `NodeDocument.data` is `unknown` on purpose: the engine already validated the file
 * against core's zod schemas before handing it over, and re-validating here would mean
 * shipping zod into a view bundle to learn something the engine already knows.
 *
 * So this module narrows structurally, and every reader answers "what should the field
 * show" rather than "is this file valid". A field the file does not have reads as empty,
 * which is exactly what the editor needs to render a new request.
 *
 * The other half of the module is the field *paths*. An edit is a `FieldEdit` carrying a
 * path into the YAML document, so the paths are the contract between a control and the
 * file, and they live in one place so a control cannot invent one.
 */

import type { FieldEdit } from "@preman/desktop/engine/protocol.js";

const HTTP_KIND = "http-request";
const GRPC_KIND = "grpc-request";
const DEFAULT_METHOD = "GET";
const EMPTY = "";
const FIRST_INDEX = 0;

/** Postman's own verb list, in the order its method picker uses. */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/** The `body.type` values core's `src/http/body.ts` acts on, plus "none". */
export const BODY_TYPES = ["none", "raw", "urlencoded", "formdata", "file", "graphql"] as const;
export type BodyType = (typeof BODY_TYPES)[number];
export const NO_BODY: BodyType = "none";

/**
 * Script slots, keyed by the `type` core reads. gRPC and HTTP name their pre-call slot
 * differently, which is Postman's doing, not ours.
 */
export const HTTP_SCRIPT_TYPES = ["prerequest", "test"] as const;
export const GRPC_SCRIPT_TYPES = ["beforeInvoke", "test"] as const;

export const FIELD = {
  name: ["name"],
  description: ["description"],
  url: ["url"],
  method: ["method"],
  methodPath: ["methodPath"],
  message: ["message", "content"],
  bodyType: ["body", "type"],
  bodyContent: ["body", "content"],
  graphqlQuery: ["body", "graphql", "query"],
  graphqlVariables: ["body", "graphql", "variables"],
  fileSrc: ["body", "file", "src"],
  schemaLocation: ["schema", "location"],
  schemaSource: ["schema", "source"],
  authType: ["auth", "type"],
} as const satisfies Record<string, readonly string[]>;

export function edit(path: readonly (string | number)[], value: unknown): FieldEdit {
  return { path: [...path], value };
}

/**
 * The document as the editor should display it: what is on disk, with the unsaved edits
 * laid over the top.
 *
 * Without this, typing a header, switching to Body and switching back would show the value
 * from disk, because `edits` and `saved.data` are separate and only the engine merges them
 * on save. Every reader below runs against the projection, never against `saved.data`.
 *
 * A path step that has to pass through a missing container creates it, matching what
 * `doc.setIn` does in core: setting `body.graphql.query` on a request that has no `body`
 * has to work, or the editor cannot author a new request.
 */
export function project(data: unknown, edits: readonly FieldEdit[]): unknown {
  if (edits.length === 0) return data;
  let result = data;
  for (const change of edits) result = write(result, change.path, change.value);
  return result;
}

function write(target: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const [step, ...rest] = path;
  if (step === undefined) return value;

  if (typeof step === "number") {
    const list = Array.isArray(target) ? [...(target as unknown[])] : [];
    if (rest.length === 0 && value === undefined) {
      list.splice(step, 1);
      return list;
    }
    list[step] = write(list[step], rest, value);
    return list;
  }

  const holder = record(target);
  const next: Record<string, unknown> = holder === null ? {} : { ...holder };
  if (rest.length === 0 && value === undefined) {
    delete next[step];
    return next;
  }
  next[step] = write(next[step], rest, value);
  return next;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return EMPTY;
}

function at(data: unknown, path: readonly (string | number)[]): unknown {
  let cursor: unknown = data;
  for (const step of path) {
    const holder = record(cursor);
    if (holder === null) return undefined;
    cursor = holder[String(step)];
  }
  return cursor;
}

/** Read one field as a string, for a `defaultValue`. */
export function readText(data: unknown, path: readonly (string | number)[]): string {
  return text(at(data, path));
}

export function readKind(data: unknown): string {
  return text(at(data, ["$kind"]));
}

export function isHttp(data: unknown): boolean {
  return readKind(data) === HTTP_KIND;
}

export function isGrpc(data: unknown): boolean {
  return readKind(data) === GRPC_KIND;
}

export function readMethod(data: unknown): string {
  const raw = readText(data, FIELD.method);
  return raw === EMPTY ? DEFAULT_METHOD : raw.toUpperCase();
}

export function readBodyType(data: unknown): BodyType {
  const raw = readText(data, FIELD.bodyType);
  const known = BODY_TYPES.find((candidate) => candidate === raw);
  return known ?? (raw === EMPTY ? NO_BODY : "raw");
}

/**
 * `methodDescriptor` is the base64 `FileDescriptorSet` Postman embeds. Decision 7: the app
 * never regenerates it, so the editor only ever reports whether one is present.
 */
export function hasDescriptor(data: unknown): boolean {
  return readText(data, ["methodDescriptor"]) !== EMPTY;
}

/**
 * Headers and query params appear as a YAML map in some files and a Postman-style array in
 * others, and core accepts both. The editor reads either and, crucially, *writes back the
 * shape it found*: turning a hand-written map into an array on the first keystroke would
 * rewrite a file the user did not ask to restructure.
 */
export type PairShape = "map" | "array" | "absent";

export interface Pair {
  readonly key: string;
  readonly value: string;
  readonly disabled: boolean;
  /** Where this pair lives: the map key, or the array index. */
  readonly at: string | number;
}

export interface PairList {
  readonly shape: PairShape;
  readonly pairs: readonly Pair[];
}

export function readPairs(data: unknown, field: string): PairList {
  const raw = at(data, [field]);
  if (Array.isArray(raw)) {
    const pairs = raw.map((entry, index) => {
      const holder = record(entry);
      return {
        key: text(holder?.["key"]),
        value: text(holder?.["value"]),
        disabled: holder?.["disabled"] === true,
        at: index,
      };
    });
    return { shape: "array", pairs };
  }
  const holder = record(raw);
  if (holder !== null) {
    const pairs = Object.entries(holder).map(([key, value]) => ({
      key,
      value: text(value),
      disabled: false,
      at: key,
    }));
    return { shape: "map", pairs };
  }
  return { shape: "absent", pairs: [] };
}

/**
 * gRPC metadata is a pair list like any other, in either the map or the array shape. It used
 * to be read as array-only on the belief that the format allowed nothing else, which is how a
 * real workspace ended up holding a map-shaped `metadata:` that the editor would open and edit
 * but core would refuse to run or save.
 */
export function readMetadata(data: unknown): readonly Pair[] {
  return readPairs(data, "metadata").pairs;
}

/**
 * The edits that change one pair's value in place.
 *
 * A map has no place to record "disabled", so toggling a row in a map-shaped file has to
 * migrate that field to the array shape. That is a real restructure, so it is a separate,
 * explicitly-named operation rather than something a checkbox does quietly.
 *
 * All five of these branch on `map` and treat every other shape as the array: an `absent`
 * field is one the file has not written yet, and the format's own default for every pair list
 * is the array. Reading `absent` as a map instead - which two of these used to do, by testing
 * `=== "array"` rather than `=== "map"` - writes `metadata: {key: value}` into a request whose
 * schema declares a list, and core rightly refuses the whole save with
 * `metadata: Expected array, received object`. The refusal names a field the user may not have
 * touched in this session, because a rejected edit stays in `tab.edits` until it is saved or
 * discarded.
 */
export function editPairValue(field: string, list: PairList, pair: Pair, value: string): FieldEdit {
  if (list.shape === "map") return edit([field, pair.key], value);
  if (list.shape === "absent") return edit([field], [asEntry({ ...pair, value })]);
  return edit([field, pair.at, "value"], value);
}

/**
 * Renaming a map key is a delete plus an add, which drops any comment attached to the old
 * key. Named here so the loss is visible at the call site rather than discovered in a diff.
 */
export function editPairKey(field: string, list: PairList, pair: Pair, key: string): FieldEdit[] {
  if (list.shape === "map") return [edit([field, pair.key], undefined), edit([field, key], pair.value)];
  if (list.shape === "absent") return [edit([field], [asEntry({ ...pair, key })])];
  return [edit([field, pair.at, "key"], key)];
}

export function editPairRemoved(field: string, list: PairList, pair: Pair): FieldEdit[] {
  if (list.shape !== "array") return [edit([field, pair.key], undefined)];
  const remaining = list.pairs.filter((candidate) => candidate.at !== pair.at).map(asEntry);
  return [edit([field], remaining)];
}

export function editPairAdded(field: string, list: PairList, key: string, value: string): FieldEdit[] {
  if (list.shape === "map") return [edit([field, key], value)];
  const entries = [...list.pairs.map(asEntry), { key, value }];
  return [edit([field], entries)];
}

/**
 * Toggling `disabled` needs the array shape, so a map-shaped field is migrated whole. The
 * caller warns first; this only performs it.
 */
export function editPairEnabled(field: string, list: PairList, pair: Pair, disabled: boolean): FieldEdit[] {
  const entries = list.pairs.map((candidate) => {
    const entry = asEntry(candidate);
    const flagged = candidate.at === pair.at ? disabled : candidate.disabled;
    return flagged ? { ...entry, disabled: true } : entry;
  });
  return [edit([field], entries)];
}

interface PairEntry {
  key: string;
  value: string;
  disabled?: boolean;
}

function asEntry(pair: Pair): PairEntry {
  return pair.disabled ? { key: pair.key, value: pair.value, disabled: true } : { key: pair.key, value: pair.value };
}

/** `key: value` per line, the text form of a grid. Blank lines and `#` comments are skipped. */
const BULK_SEPARATOR = ":";
const BULK_COMMENT = "#";
const BULK_LINE_BREAK = "\n";
const DISABLED_PREFIX = "//";

export function pairsToText(pairs: readonly Pair[]): string {
  return pairs
    .map((pair) => `${pair.disabled ? DISABLED_PREFIX : EMPTY}${pair.key}${BULK_SEPARATOR} ${pair.value}`)
    .join(BULK_LINE_BREAK);
}

export function textToPairs(value: string): readonly PairEntry[] {
  const entries: PairEntry[] = [];
  for (const line of value.split(BULK_LINE_BREAK)) {
    const trimmed = line.trim();
    if (trimmed === EMPTY || trimmed.startsWith(BULK_COMMENT)) continue;
    const disabled = trimmed.startsWith(DISABLED_PREFIX);
    const body = disabled ? trimmed.slice(DISABLED_PREFIX.length).trim() : trimmed;
    const split = body.indexOf(BULK_SEPARATOR);
    const key = split === -1 ? body : body.slice(FIRST_INDEX, split);
    const text = split === -1 ? EMPTY : body.slice(split + BULK_SEPARATOR.length).trim();
    if (key.trim() === EMPTY) continue;
    entries.push(disabled ? { key: key.trim(), value: text, disabled: true } : { key: key.trim(), value: text });
  }
  return entries;
}

export interface ScriptSlot {
  readonly type: string;
  readonly code: string;
  /** Index in the `scripts` array, or null when the file has no such slot yet. */
  readonly at: number | null;
}

export function readScripts(data: unknown, types: readonly string[]): readonly ScriptSlot[] {
  const raw = at(data, ["scripts"]);
  const existing = Array.isArray(raw) ? raw : [];
  return types.map((type) => {
    const index = existing.findIndex((entry) => text(record(entry)?.["type"]) === type);
    const holder = index === -1 ? null : record(existing[index]);
    return { type, code: text(holder?.["code"]), at: index === -1 ? null : index };
  });
}

const SCRIPT_LANGUAGE = "javascript";

export function editScript(data: unknown, slot: ScriptSlot, code: string): FieldEdit[] {
  if (slot.at !== null) return [edit(["scripts", slot.at, "code"], code)];
  const raw = at(data, ["scripts"]);
  const existing = Array.isArray(raw) ? raw : [];
  return [edit(["scripts", existing.length], { type: slot.type, language: SCRIPT_LANGUAGE, code })];
}

/**
 * `settings` is an open record in the format, so the editor surfaces the keys the file
 * already has rather than inventing a form for values core may never read.
 */
export function readSettings(data: unknown): readonly Pair[] {
  const holder = record(at(data, ["settings"]));
  if (holder === null) return [];
  return Object.entries(holder).map(([key, value]) => ({ key, value: text(value), disabled: false, at: key }));
}
