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
import { create } from "zustand";

import type { Catalog, CatalogNode, SnapshotEnvironment } from "@preman/desktop/engine/protocol.js";

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

  /** Replace wholesale. The engine owns the truth; this store never patches a node itself. */
  // Actions are function properties, not method signatures. A method read off the state object
  // and passed to a handler is an unbound method; declaring the shape this way says out loud
  // that these never use `this`.
  replace: (catalog: Catalog) => void;
  /** Restore collapse state for a workspace being reopened, before the first catalog arrives. */
  restoreCollapsed: (ids: readonly string[]) => void;
  toggle: (id: string) => void;
  select: (id: string | null) => void;
  clear: () => void;
}

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
} satisfies Omit<CatalogState, "replace" | "restoreCollapsed" | "toggle" | "select" | "clear">;

export const useCatalogStore = create<CatalogState>((set) => ({
  ...EMPTY,

  replace(catalog) {
    set((state) => ({
      root: catalog.root,
      revision: catalog.revision,
      nodes: catalog.nodes,
      byId: indexById(catalog.nodes),
      visibleIds: computeVisible(catalog.nodes, state.collapsed),
      environments: catalog.environments,
      specs: catalog.specs,
      // A node that was deleted externally must not stay selected: the editor would be pointing
      // at a file that is gone, and "orphaned tab" is a tab concern, not a selection one.
      selectedId:
        state.selectedId !== NO_SELECTION && catalog.nodes.some((node) => node.id === state.selectedId)
          ? state.selectedId
          : NO_SELECTION,
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
    // Collapse state survives a workspace switch by id, so it is not reset here.
    set((state) => ({ ...EMPTY, collapsed: state.collapsed }));
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
