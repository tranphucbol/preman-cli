/**
 * Where a new request or folder goes when the click that asked for one named no folder.
 *
 * The sidebar's context menu never needs this: it was opened on a row, and that row is the answer.
 * The `+` in the tab row has no row, so it has to guess — and it is allowed to, because unlike
 * duplicate it puts the guess in a picker on screen where it can be corrected before anything is
 * written.
 *
 * Pure, and separate from `App.tsx`, so the fallback chain is testable without a window.
 */
import type { CatalogNode } from "@preman/desktop/engine/protocol.js";

/** One row of the destination picker: plain data, so `ui/Dialog` learns nothing about a catalog. */
export interface Destination {
  readonly id: string;
  readonly label: string;
}

/**
 * The workspace root, which is a destination with no node behind it.
 *
 * Every other id in this list is a node id, which is a workspace-relative path. The root is the
 * directory those paths are relative *to*, so it has no path of its own and no catalog row — and
 * yet it is where a collection is made, which is the one creation the `+` could not reach until it
 * appeared here.
 *
 * Angle brackets so it can never collide with a real id: `sanitiseSegment` strips them, so no
 * node's path can spell this.
 */
export const ROOT_DESTINATION_ID = "<root>";

/**
 * What the root row says. Not the workspace's own name: the picker answers "inside what", and the
 * workspace is the one answer that is not inside anything.
 */
const ROOT_DESTINATION_LABEL = "Workspace root";

/**
 * The indent that makes a folder distinguishable from the collection above it in a flat list.
 *
 * Non-breaking spaces, not ordinary ones. These labels are rendered as HTML text, where leading
 * whitespace collapses to nothing — so the plain-space version of this constant indented every row
 * by exactly zero pixels and the depth it was carrying never reached the screen.
 */
const DEPTH_INDENT = "\u00a0\u00a0";

function isGroup(node: CatalogNode): boolean {
  return node.kind !== "request";
}

/**
 * The root, then every collection and folder in tree order, with depth rendered into the label.
 *
 * Rendered rather than structured because a `Select` option is one line of text; two folders named
 * `v2` under different collections are otherwise the same row twice.
 *
 * The root is first because it is the shallowest, so the list reads as the tree it is. It is always
 * present, including in an empty workspace — that is what makes the picker's own emptiness
 * impossible, and with it the disabled `+` that used to stand in for it.
 */
export function groupDestinations(nodes: readonly CatalogNode[]): Destination[] {
  return [
    { id: ROOT_DESTINATION_ID, label: ROOT_DESTINATION_LABEL },
    ...nodes.filter(isGroup).map((node) => ({ id: node.id, label: DEPTH_INDENT.repeat(node.depth + 1) + node.name })),
  ];
}

/**
 * The folder a new request should default into: the active tab's, then the selection's, then root.
 *
 * The root is the floor rather than `null`, which this used to return. `parentId` is nullable — a
 * collection sits at the root, which is a directory with no node id — so a tab on a collection, or
 * an empty workspace, has no *node* to name; it does have a place, and now the picker can say so.
 * Reaching for the first collection instead would still be inventing a destination the user never
 * looked at, and that is still not done here.
 */
export function defaultDestination(
  nodes: readonly CatalogNode[],
  activeTabNodeId: string | null,
  selectedId: string | null,
): string {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const tab = activeTabNodeId === null ? undefined : byId.get(activeTabNodeId);
  if (tab !== undefined) {
    const folder = isGroup(tab) ? tab.id : tab.parentId;
    if (folder !== null) return folder;
  }

  const selected = selectedId === null ? undefined : byId.get(selectedId);
  if (selected !== undefined) return (isGroup(selected) ? selected.id : selected.parentId) ?? ROOT_DESTINATION_ID;

  return ROOT_DESTINATION_ID;
}
