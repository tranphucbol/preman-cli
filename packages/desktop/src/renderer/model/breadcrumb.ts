import type { CatalogNode } from "@preman/desktop/engine/protocol.js";

/**
 * The one sentence the breadcrumb row is: where the open document lives, written out.
 *
 * Its own module rather than a line inside `DocumentChrome.tsx` because it is what the clipboard
 * gets, and what the clipboard gets is the part worth asserting — a component under
 * `environment: "node"` cannot be rendered, and the separator is the whole of the format.
 */

/**
 * ` > ` and not `/`.
 *
 * A path with slashes reads as a path on disk, and this is not one: a collection's directory is
 * named after the collection but a request's file is not named after the request, so anybody who
 * pasted it into a terminal would get a `no such file`. The arrow is what the row itself draws,
 * and pasting what you can see is the only rule this needs to follow.
 */
export const BREADCRUMB_SEPARATOR = " > ";

/**
 * The crumbs and the name they lead to, as one line.
 *
 * The final name is included, which is the difference between this and a folder path. The reason
 * somebody copies this row is to say *which* request they mean — in a ticket, a message, a review —
 * and the four requests called `Create` in four collections are the reason the row exists at all.
 */
export function breadcrumbPath(ancestors: readonly CatalogNode[], name: string): string {
  return [...ancestors.map((crumb) => crumb.name), name].join(BREADCRUMB_SEPARATOR);
}
