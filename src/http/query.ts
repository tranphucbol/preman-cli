import type { KeyValue } from "./headers.js";

/**
 * Append query params that the URL does not already carry.
 *
 * Real exports often duplicate: `?name=USER` in the url *and* `queryParams: {name: USER}`.
 * The url is authoritative, so a key already present there is skipped rather than
 * appended twice. Returns the keys that were skipped, for reporting.
 */
export function mergeQuery(url: URL, params: readonly KeyValue[]): string[] {
  const skipped: string[] = [];
  for (const { key, value } of params) {
    if (url.searchParams.has(key)) {
      skipped.push(key);
      continue;
    }
    url.searchParams.append(key, value);
  }
  return skipped;
}
