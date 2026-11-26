/**
 * The sidebar's name filter: which rows a typed fragment leaves in the tree.
 *
 * Names only, per keystroke, in the renderer. The catalog already holds every name, so this costs
 * no round trip, and it is what makes typing in the box feel like narrowing the tree rather than
 * like submitting a form. Everything else in a request file - urls, bodies, scripts - is the
 * engine's content search, which the same box runs on Enter.
 *
 * Collapse state is ignored rather than consulted, and never written: a request that matches has
 * to be visible even when the user had its folder shut, and clearing the box has to put the tree
 * back exactly as it was. Overriding at read time does both without remembering anything.
 */
import type { CatalogNode } from "@preman/desktop/engine/protocol.js";

/** What the tree shows while a filter is typed. */
export interface TreeFilterResult {
  /** The rows to paint, in catalog order. */
  readonly ids: readonly string[];
  /** The rows whose own name matched, as opposed to rows kept for their ancestors or descendants. */
  readonly matched: ReadonlySet<string>;
}

interface Open {
  readonly index: number;
  readonly depth: number;
  /** This node or one of its ancestors matched, so everything under it stays. */
  readonly covered: boolean;
}

/** The fragment as compared: trimmed and case-folded, or empty when there is nothing to filter by. */
export function normalizeFilter(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * The filtered tree, or `null` when the fragment is empty and the tree should be its usual self.
 *
 * A node stays when its own name matches, when an ancestor's does (a matched folder brings its
 * whole subtree, the way Postman's does), or when a descendant's does (its chain down to the
 * match). One pass: the engine emits parents immediately before their children, so a stack of the
 * open ancestors is the chain, and marking it upward can stop at the first one already kept,
 * because a kept node's ancestors were kept in the same step.
 */
export function filterTree(nodes: readonly CatalogNode[], text: string): TreeFilterResult | null {
  const needle = normalizeFilter(text);
  if (needle.length === 0) return null;

  const keep = new Array<boolean>(nodes.length).fill(false);
  const matched = new Set<string>();
  const chain: Open[] = [];

  nodes.forEach((node, index) => {
    while (chain.length > 0 && chain[chain.length - 1]!.depth >= node.depth) chain.pop();
    const self = node.name.toLowerCase().includes(needle);
    const covered = self || (chain[chain.length - 1]?.covered ?? false);
    if (self) matched.add(node.id);
    if (covered) {
      keep[index] = true;
      for (let at = chain.length - 1; at >= 0 && !keep[chain[at]!.index]; at -= 1) keep[chain[at]!.index] = true;
    }
    chain.push({ index, depth: node.depth, covered });
  });

  const ids: string[] = [];
  nodes.forEach((node, index) => {
    if (keep[index]) ids.push(node.id);
  });
  return { ids, matched };
}

/** A name cut around its first match, so the row can set the matched run apart. */
export interface NameParts {
  readonly before: string;
  readonly match: string;
  readonly after: string;
}

/** `null` when the name does not contain the fragment, which leaves the row's plain rendering. */
export function splitName(name: string, text: string): NameParts | null {
  const needle = normalizeFilter(text);
  if (needle.length === 0) return null;
  const at = name.toLowerCase().indexOf(needle);
  if (at < 0) return null;
  return {
    before: name.slice(0, at),
    match: name.slice(at, at + needle.length),
    after: name.slice(at + needle.length),
  };
}

/** What the window knows when `Cmd+F` arrives, gathered by the key handler. */
export interface FindContext {
  /** Focus is inside a CodeMirror editor, which has its own find bar on the same chord. */
  readonly inEditor: boolean;
  /** Something nearer the focus already answered the press. */
  readonly claimed: boolean;
}

/**
 * Whether `Cmd+F` goes to the tree's filter box.
 *
 * From anywhere nothing else wants the chord: a hidden sidebar is opened and search results are
 * swapped back for the tree. An editor's find bar is the nearer meaning of `Cmd+F` while the caret
 * is in a body or a script, and taking it from there would turn the most familiar shortcut in the
 * app into a jump to a different pane.
 */
export function findTargetsTree(context: FindContext): boolean {
  return !context.inEditor && !context.claimed;
}
