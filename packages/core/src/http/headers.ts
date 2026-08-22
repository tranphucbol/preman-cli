import { CliError } from "@preman/core/errors.js";
import type { Property } from "@preman/core/scripts/property-list.js";
import type { KeyValueSource } from "@preman/core/workspace/schemas.js";

export type KeyValue = Property;

function scalarToString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new CliError(`unsupported value type ${typeof value}`);
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
      throw new CliError(`expected a map or a list, got ${typeof source}`);
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
    throw new CliError(`could not read ${label}: ${cause instanceof Error ? cause.message : String(cause)}`, {
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
 * Drop headers with no value.
 *
 * Postman would send them blank, but a blank `authorization` in a request that
 * also carries an `auth` block (which exists in the wild) would silently defeat
 * the token and return 401. Treating blank as unset is the useful reading.
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
