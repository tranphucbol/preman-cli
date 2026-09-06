import { PremanError } from "@preman/core/errors.js";
import type { Property } from "@preman/core/scripts/property-list.js";
import type { KeyValueSource } from "@preman/core/workspace/schemas.js";

export type KeyValue = Property;

function scalarToString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new PremanError(`unsupported value type ${typeof value}`);
}

/**
 * Flatten a map-or-array collection into ordered `{key, value}` pairs.
 *
 * Keys keep their original casing and disabled rows remain available to the live
 * request. Wire-oriented callers use {@link normalizeKeyValues} to omit them.
 */
export function normalizeProperties(source: KeyValueSource | undefined, label: string): KeyValue[] {
  if (source === undefined) return [];

  try {
    // A scalar here means the YAML said `headers: something`, which cannot be read
    // as either shape. Guessing would silently drop the author's intent.
    if (typeof source !== "object" || source === null)
      throw new PremanError(`expected a map or a list, got ${typeof source}`);
    if (Array.isArray(source)) {
      return source
        .map((entry) => ({
          key: entry.key.trim(),
          value: scalarToString(entry.value),
          ...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
        }))
        .filter((entry) => entry.key.length > 0);
    }
    return Object.entries(source)
      .map(([key, value]) => ({ key: key.trim(), value: scalarToString(value) }))
      .filter((entry) => entry.key.length > 0);
  } catch (cause) {
    throw new PremanError(`could not read ${label}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      details: ["expected a map of key: value, or a list of {key, value} entries"],
    });
  }
}

/** Legacy wire-oriented normalisation; live requests use {@link normalizeProperties}. */
export function normalizeKeyValues(source: KeyValueSource | undefined, label: string): KeyValue[] {
  return normalizeProperties(source, label).filter((entry) => entry.disabled !== true);
}

/** Case-insensitive lookup, since HTTP header names are not case sensitive. */
export function findHeader(headers: readonly KeyValue[], name: string): KeyValue | undefined {
  const wanted = name.toLowerCase();
  return headers.find((header) => header.disabled !== true && header.key.toLowerCase() === wanted);
}

export function hasHeader(headers: readonly KeyValue[], name: string): boolean {
  return findHeader(headers, name) !== undefined;
}

/** Append `name: value` unless the caller already set that header. */
export function setHeaderIfAbsent(headers: KeyValue[], name: string, value: string): void {
  if (hasHeader(headers, name)) return;
  headers.push({ key: name, value });
}

/**
 * Overwrite every enabled `name` header with one `name: value`, and answer with
 * the values that were displaced.
 *
 * The first match keeps its position, so a verbose dump still reads in authored
 * order, and any further enabled match is dropped rather than left to reach the
 * wire as a duplicate. Disabled rows are not matched, removed or counted: they
 * never reach the wire, and the author parked them deliberately. Postman's
 * `removeHeader` would take them too, but Postman has no disabled header in the
 * list it signs.
 */
export function replaceHeader(headers: KeyValue[], name: string, value: string): string[] {
  const wanted = name.toLowerCase();
  const hits: number[] = [];
  headers.forEach((header, index) => {
    if (header.disabled !== true && header.key.toLowerCase() === wanted) hits.push(index);
  });
  if (hits.length === 0) return [];

  const displaced = hits.map((index) => headers[index]!.value);
  headers[hits[0]!] = { key: name, value };
  for (let hit = hits.length - 1; hit >= 1; hit -= 1) headers.splice(hits[hit]!, 1);
  return displaced;
}

/**
 * Drop headers with no value.
 *
 * Postman sends them blank. preman reads blank as unfinished, because a header
 * someone started and did not fill in is far more often a mistake than a
 * deliberate empty value, and a server that cares about the difference is rare.
 */
export function dropEmptyValues(headers: readonly KeyValue[]): KeyValue[] {
  return headers.filter((header) => header.disabled === true || header.value.length > 0);
}

/**
 * Collapse to the shape `node:http` wants, keeping repeated keys as arrays.
 *
 * Grouping is case-insensitive: `x-tag` and `X-Tag` are one header, so they must
 * end up as one entry with two values rather than two entries that a server is
 * free to read only half of. The first spelling seen is the one sent.
 */
export function toOutgoingHeaders(headers: readonly KeyValue[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const emittedFor = new Map<string, string>();
  for (const { key, value, disabled } of headers) {
    if (disabled === true) continue;
    const emitted = emittedFor.get(key.toLowerCase());
    if (emitted === undefined) {
      emittedFor.set(key.toLowerCase(), key);
      out[key] = value;
      continue;
    }
    const existing = out[emitted];
    if (Array.isArray(existing)) existing.push(value);
    else out[emitted] = [existing as string, value];
  }
  return out;
}
