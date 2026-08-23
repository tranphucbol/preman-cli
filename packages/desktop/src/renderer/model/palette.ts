/**
 * What the command palette is, minus the pixels.
 *
 * Pure, so the ranking can be argued about in a test rather than by squinting at a list. This is
 * also the reason the palette is not `cmdk`: cmdk owns both the scoring and the rendering, and it
 * scores by mounting every item. A workspace with five thousand requests would mount five thousand
 * nodes on the first keystroke, which is the one thing decision 10 says never to do.
 *
 * The matcher is a subsequence matcher, the same shape as every editor's file finder: `pmecho`
 * finds `payment/Echo`. Substring matching would not, and substring is what makes a palette feel
 * like a filter box instead of a jump.
 */

import type { CatalogNode } from "@preman/desktop/engine/protocol.js";

/**
 * Where a row came from.
 *
 * `method` is not one of the palette's own sources; it is the gRPC method picker, which reuses the
 * same dialog. One virtualized fuzzy picker serving both is the point: a second implementation of
 * "long list, type to narrow, Enter to choose" is a second implementation to keep fast.
 */
export type PaletteKind = "request" | "environment" | "command" | "method";

export interface PaletteItem {
  readonly kind: PaletteKind;
  /** A node id, an environment name, or a command's own id. Opaque to this module. */
  readonly id: string;
  /** What gets matched and shown. */
  readonly label: string;
  /** Dimmed trailing context: the folder a request lives in, or what a command does. */
  readonly detail?: string;
}

export interface PaletteRow {
  readonly item: PaletteItem;
  readonly score: number;
  /** Indices in `label` that the query matched, for highlighting. Empty for an empty query. */
  readonly hits: readonly number[];
  /** The same for `detail`, non-empty only when the query had to reach into the folder chain. */
  readonly detailHits: readonly number[];
}

/**
 * How many rows are ranked out. Well past a screenful: the list is virtualized, so the cost of a
 * long list is the sort, and the sort is what this bounds.
 */
export const PALETTE_LIMIT = 200;

const NO_HITS: readonly number[] = [];
const NO_MATCH = null;

const PATH_SEPARATOR = "/";

/**
 * Everything the palette can reach, in the order ties should break: commands, then environments,
 * then requests.
 *
 * Commands first because there are a handful of them and they are the part nobody would otherwise
 * discover; requests last because there are thousands and they win on score whenever the user is
 * actually looking for one. A groups row is deliberately absent: opening a folder is expanding a
 * row in a tree, which the palette cannot do and the tree does better.
 */
export function paletteItems(
  commands: readonly PaletteItem[],
  environments: readonly { readonly name: string }[],
  nodes: readonly CatalogNode[],
): readonly PaletteItem[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const items: PaletteItem[] = [...commands];

  for (const environment of environments) {
    items.push({ kind: "environment", id: environment.name, label: environment.name, detail: "environment" });
  }

  for (const node of nodes) {
    if (node.kind !== "request") continue;
    items.push({ kind: "request", id: node.id, label: node.name, detail: parentPathOf(node, byId) });
  }

  return items;
}

/**
 * The folder chain above a node, by name.
 *
 * Names rather than the node id, which is a file path: two requests called `Echo` are told apart
 * by `payment` and `admin`, not by `postman/collections`, and the repeated prefix would push the
 * distinguishing part off the end of a truncated line.
 */
function parentPathOf(node: CatalogNode, byId: ReadonlyMap<string, CatalogNode>): string {
  const names: string[] = [];
  let parentId = node.parentId;
  while (parentId !== null) {
    const parent = byId.get(parentId);
    if (parent === undefined) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names.join(PATH_SEPARATOR);
}

/** A match at the start of the label, or just after one of these, is what the user aimed at. */
const BOUNDARIES = new Set([" ", "/", "-", "_", ".", ":"]);

const START_BONUS = 12;
const BOUNDARY_BONUS = 8;
const ADJACENT_BONUS = 6;
const CHARACTER_SCORE = 1;
/** Charged per skipped character, so a tight match beats a scattered one over the same label. */
const GAP_PENALTY = 1;

/**
 * Rank items against a query, best first.
 *
 * Ties keep the caller's order, which is how the palette decides that a command outranks a request
 * of equal score: the caller passes commands first. A weight per kind in here would be the same
 * decision made somewhere it cannot be seen.
 *
 * Names are ranked ahead of locations as a group rather than by score. Matching `detail/label` in
 * one pass would have been fewer lines and worse: the folder chain comes first in that string, so
 * every row would lose its start bonus and `echo` would rank by how a path happens to be spelled.
 * Two passes say the thing a person means - what it is called, then where it lives.
 */
export function rankPalette(
  items: readonly PaletteItem[],
  query: string,
  limit: number = PALETTE_LIMIT,
): readonly PaletteRow[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return items.slice(0, limit).map((item) => ({ item, score: 0, hits: NO_HITS, detailHits: NO_HITS }));
  }

  const needle = trimmed.toLowerCase();
  const named: Ranked[] = [];
  const located: Ranked[] = [];
  for (const [at, item] of items.entries()) {
    const onLabel = matchSubsequence(item.label, needle);
    if (onLabel !== NO_MATCH) {
      named.push({ row: { item, score: onLabel.score, hits: onLabel.hits, detailHits: NO_HITS }, at });
      continue;
    }
    const row = matchLocation(item, needle, at);
    if (row !== NO_MATCH) located.push(row);
  }

  return [...byScore(named), ...byScore(located)].slice(0, limit).map((entry) => entry.row);
}

interface Ranked {
  readonly row: PaletteRow;
  readonly at: number;
}

/**
 * Stable by construction: equal scores fall back to the input position rather than to whatever
 * order the sort happened to leave them in.
 */
function byScore(rows: Ranked[]): Ranked[] {
  return rows.sort((left, right) => right.row.score - left.row.score || left.at - right.at);
}

/**
 * The same match against `detail/label`, so `pmecho` finds the `Echo` in `payment` - which is what
 * a file finder does and the reason the detail is on the row at all. The hits come back split at
 * the separator, because the two halves are drawn in two different places.
 */
function matchLocation(item: PaletteItem, needle: string, at: number): Ranked | null {
  const { detail } = item;
  if (detail === undefined || detail.length === 0) return NO_MATCH;

  const match = matchSubsequence(`${detail}${PATH_SEPARATOR}${item.label}`, needle);
  if (match === NO_MATCH) return NO_MATCH;

  const labelFrom = detail.length + PATH_SEPARATOR.length;
  const detailHits = match.hits.filter((hit) => hit < detail.length);
  const hits = match.hits.filter((hit) => hit >= labelFrom).map((hit) => hit - labelFrom);
  return { row: { item, score: match.score, hits, detailHits }, at };
}

/**
 * Greedy left-to-right, deliberately not optimal.
 *
 * A full alignment would score `ee` against `Deep Echo` a point higher by taking the second `e`
 * from `Echo`, and would cost a matrix per item per keystroke. Greedy plus the boundary bonus
 * agrees with the optimal answer on the cases people actually type, which is initials and prefixes.
 */
function matchSubsequence(label: string, needle: string): { score: number; hits: number[] } | null {
  const haystack = label.toLowerCase();
  const hits: number[] = [];
  let score = 0;
  let cursor = 0;
  let previous = -1;

  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found < 0) return NO_MATCH;

    score += CHARACTER_SCORE;
    if (found === 0) score += START_BONUS;
    else if (BOUNDARIES.has(haystack[found - 1] ?? "")) score += BOUNDARY_BONUS;
    if (found === previous + 1) score += ADJACENT_BONUS;
    else score -= (found - cursor) * GAP_PENALTY;

    hits.push(found);
    previous = found;
    cursor = found + 1;
  }

  return { score, hits };
}
