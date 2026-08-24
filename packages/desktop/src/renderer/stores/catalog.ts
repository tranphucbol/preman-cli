/**
 * The tree, and the one rule that keeps it cheap.
 *
 * The engine sends a flat, pre-sorted `CatalogNode[]` and never a nested tree, because a nested
 * tree cannot be virtualized without walking it. This store keeps that array as the ordering, plus
 * a `byId` map so a row can subscribe to *its own node* and nothing else. A row that subscribed to
 * `nodes` would re-render on every push; there are 5,000 of them, so that is the whole budget.
 *
 * `refreshCatalog` in core preserves object identity for untouched nodes, which is what makes the
 * per-row subscription actually pay off: editing one request re-renders one row.
 */
import { useMemo } from "react";
import { create } from "zustand";

import {
  markPhase,
  PHASES,
  type Catalog,
  type CatalogNode,
  type GitFileStatus,
  type GitStatus,
  type SnapshotEnvironment,
} from "@preman/desktop/engine/protocol.js";

import { deriveGitDecorations, type GitDecoration } from "@preman/desktop/renderer/model/git.js";

const NO_ROOT = null;
const NO_SELECTION = null;
const FIRST_REVISION = 0;
/** Sentinel for "not inside a collapsed subtree". Depths are >= 0, so -1 cannot collide. */
const NOT_HIDDEN = -1;

/**
 * Which rows the sidebar paints, in order.
 *
 * One pass, no ancestor lookups: the engine emits parents immediately before their children, so a
 * collapsed node hides exactly the run of following nodes that are deeper than it.
 */
function computeVisible(nodes: readonly CatalogNode[], collapsed: ReadonlySet<string>): string[] {
  const visible: string[] = [];
  let hiddenBelow = NOT_HIDDEN;
  for (const node of nodes) {
    if (hiddenBelow !== NOT_HIDDEN && node.depth > hiddenBelow) continue;
    hiddenBelow = NOT_HIDDEN;
    visible.push(node.id);
    if (collapsed.has(node.id)) hiddenBelow = node.depth;
  }
  return visible;
}

function indexById(nodes: readonly CatalogNode[]): Map<string, CatalogNode> {
  const byId = new Map<string, CatalogNode>();
  for (const node of nodes) byId.set(node.id, node);
  return byId;
}

export interface CatalogState {
  root: string | null;
  revision: number;
  nodes: CatalogNode[];
  byId: Map<string, CatalogNode>;
  collapsed: Set<string>;
  visibleIds: string[];
  selectedId: string | null;
  environments: SnapshotEnvironment[];
  specs: string[];

  /**
   * The git overlay. It lives here rather than in a store of its own because a decoration is a
   * function of *both* the status and the nodes, and two stores holding half of one derivation is
   * how a row ends up undecorated until the next unrelated push. `visibleIds` is the same shape of
   * problem, and it is already here.
   */
  branch: string | null;
  gitFiles: Readonly<Record<string, GitFileStatus>>;
  gitDecorations: ReadonlyMap<string, GitDecoration>;

  /** Replace wholesale. The engine owns the truth; this store never patches a node itself. */
  // Actions are function properties, not method signatures. A method read off the state object
  // and passed to a handler is an unbound method; declaring the shape this way says out loud
  // that these never use `this`.
  replace: (catalog: Catalog) => void;
  applyGit: (status: GitStatus) => void;
  /** Restore collapse state for a workspace being reopened, before the first catalog arrives. */
  restoreCollapsed: (ids: readonly string[]) => void;
  toggle: (id: string) => void;
  select: (id: string | null) => void;
  clear: () => void;
}

const NO_FILES: Readonly<Record<string, GitFileStatus>> = {};

const EMPTY = {
  root: NO_ROOT,
  revision: FIRST_REVISION,
  nodes: [],
  byId: new Map<string, CatalogNode>(),
  collapsed: new Set<string>(),
  visibleIds: [],
  selectedId: NO_SELECTION,
  environments: [],
  specs: [],
  branch: null,
  gitFiles: NO_FILES,
  gitDecorations: new Map<string, GitDecoration>(),
} satisfies Omit<CatalogState, "replace" | "applyGit" | "restoreCollapsed" | "toggle" | "select" | "clear">;

export const useCatalogStore = create<CatalogState>((set) => ({
  ...EMPTY,

  replace(catalog) {
    // `set` is synchronous, so this pair brackets `indexById` + `computeVisible` +
    // `deriveGitDecorations` over every node: the one part of a workspace open that blocks this
    // thread, and so the only phase decision 017's instrument would also see.
    markPhase(PHASES.rendererReplaceEnter);
    set((state) => ({
      root: catalog.root,
      revision: catalog.revision,
      nodes: catalog.nodes,
      byId: indexById(catalog.nodes),
      visibleIds: computeVisible(catalog.nodes, state.collapsed),
      environments: catalog.environments,
      specs: catalog.specs,
      // Recomputed here as well as in `applyGit`, because a node the status already mentioned may
      // only now have appeared: git sees a new file the instant it is written, the catalog after
      // the watcher fires, and the two arrive in whichever order they arrive.
      gitDecorations: deriveGitDecorations(catalog.nodes, state.gitFiles),
      // A node that was deleted externally must not stay selected: the editor would be pointing
      // at a file that is gone, and "orphaned tab" is a tab concern, not a selection one.
      selectedId:
        state.selectedId !== NO_SELECTION && catalog.nodes.some((node) => node.id === state.selectedId)
          ? state.selectedId
          : NO_SELECTION,
    }));
    markPhase(PHASES.rendererReplaceExit);
  },

  applyGit(status) {
    set((state) => ({
      branch: status.branch,
      gitFiles: status.files,
      gitDecorations: deriveGitDecorations(state.nodes, status.files),
    }));
  },

  restoreCollapsed(ids) {
    set((state) => {
      const collapsed = new Set(ids);
      return { collapsed, visibleIds: computeVisible(state.nodes, collapsed) };
    });
  },

  toggle(id) {
    set((state) => {
      const collapsed = new Set(state.collapsed);
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      return { collapsed, visibleIds: computeVisible(state.nodes, collapsed) };
    });
  },

  select(id) {
    set({ selectedId: id });
  },

  clear() {
    // Collapse state goes too. Node ids are workspace-relative paths, so carrying a set of them
    // into another workspace would fold whichever collections happen to share a name.
    // `restoreCollapse` puts the incoming workspace's own set back before its catalog arrives.
    set(EMPTY);
  },
}));

/**
 * The subscription a tree row is allowed to make. Selecting the node object rather than the array
 * is what stops one edited request from re-rendering the other 4,999 rows.
 */
export function useNode(id: string): CatalogNode | undefined {
  return useCatalogStore((state) => state.byId.get(id));
}

export function useIsCollapsed(id: string): boolean {
  return useCatalogStore((state) => state.collapsed.has(id));
}

export function useIsSelected(id: string): boolean {
  return useCatalogStore((state) => state.selectedId === id);
}

/** One more per-row subscription, and the same reason: a rebase must not repaint the tree twice. */
export function useGitDecoration(id: string): GitDecoration | undefined {
  return useCatalogStore((state) => state.gitDecorations.get(id));
}

/**
 * The chain from the collection down to `id`'s parent, outermost first.
 *
 * Walked from `parentId` rather than read off a path stored on the node: the walk is one map
 * lookup per level against a tree that is three deep, while a materialised path would have to be
 * rewritten on every descendant of a renamed folder. A node whose chain is broken - which only
 * happens mid-refresh, between a `replace` and the render that follows it - yields the part of the
 * chain that does resolve rather than throwing.
 */
function ancestorsOf(byId: ReadonlyMap<string, CatalogNode>, id: string): CatalogNode[] {
  const chain: CatalogNode[] = [];
  let parentId = byId.get(id)?.parentId ?? null;
  while (parentId !== null) {
    const parent = byId.get(parentId);
    if (parent === undefined) break;
    chain.unshift(parent);
    parentId = parent.parentId;
  }
  return chain;
}

/**
 * Subscribes to `byId` and not to a node, unlike the hooks above, because the chain is a function
 * of the whole index. That is affordable here and nowhere else: this is read once per open editor,
 * not once per row.
 */
export function useAncestors(id: string): readonly CatalogNode[] {
  const byId = useCatalogStore((state) => state.byId);
  return useMemo(() => ancestorsOf(byId, id), [byId, id]);
}
