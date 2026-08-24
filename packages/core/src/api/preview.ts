import { interpolate } from "@preman/core/vars/interpolate.js";
import { readerScope } from "./variables.js";

export interface TextPreview {
  /** The text with every resolvable `{{token}}` substituted. */
  text: string;
  /** Names that resolved to nothing, first-seen order. Left verbatim in `text`. */
  missing: string[];
  /** Dynamic variables referenced but not implemented, first-seen order. */
  unsupported: string[];
}

/**
 * What `text` would become on the next run, resolved against the layers on disk.
 *
 * Resolution is the runner's own: recursive, cycle-guarded, depth-bounded, and dynamic
 * variables are evaluated per occurrence — so a `{{$guid}}` here is a sample of what a send
 * would generate rather than the value it will send. A second implementation living closer to
 * the caller would eventually show a value a run would not.
 *
 * `missing` and `unsupported` are reported rather than thrown, exactly as {@link interpolate}
 * reports them: a preview of a body with one bad token must still show the other nine
 * substituted. Only a cycle or the depth bound throws, because those are already actionable
 * and there is no partial answer to give.
 *
 * Resolves from globals and the chosen environment only, which is what a workspace persists.
 * A token whose value would come from an iteration data file or a `pm.variables.set` previews
 * as missing and sends fine; a preview against a store this cannot honestly build is how a
 * preview becomes a thing people learn to distrust.
 */
export function previewText(dir: string, environment: string | null | undefined, text: string): TextPreview {
  const { store } = readerScope(dir, environment);
  return interpolate(text, store);
}
