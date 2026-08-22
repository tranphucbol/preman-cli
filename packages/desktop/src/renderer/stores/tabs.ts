/**
 * Open tabs and their unsaved work.
 *
 * The rule attached to this store is that a tab's form subscribes only to its own slice. Tabs live
 * in a `Map` so an edit in one tab replaces one value and leaves every other tab's object identity
 * alone; `useTab(nodeId)` therefore re-renders exactly the form being typed into.
 *
 * Saving is explicit (decision 12). What is in `edits` and `text` here is not on disk yet, which is
 * why it is also persisted to app data on a debounce: a crash must cost nothing, and `git status`
 * must stay clean while the app is open.
 */
import { create } from "zustand";

import type { DocumentKind, EngineError, FieldEdit, NodeDocument } from "@preman/desktop/engine/protocol.js";

const NO_ACTIVE = null;

/** Every editor sub-tab id in the app. gRPC and HTTP show different subsets of these. */
export type SubTab = "params" | "auth" | "headers" | "body" | "scripts" | "settings" | "yaml";

export const DEFAULT_SUB_TAB: SubTab = "body";

export interface Tab {
  readonly nodeId: string;
  readonly title: string;
  readonly kind: DocumentKind;
  readonly subTab: SubTab;
  /** The document as the engine last read it, or null while loading. */
  readonly saved: NodeDocument | null;
  /** Field edits not yet written. Upserted by path, so retyping one cell does not grow this. */
  readonly edits: readonly FieldEdit[];
  /** A raw-YAML draft. Non-null only when the YAML tab has been edited. */
  readonly text: string | null;
  readonly loading: boolean;
  /** Set when the file changed on disk under a tab that has unsaved work. */
  readonly conflicted: boolean;
  /** Set when the file was deleted on disk while the tab was open. */
  readonly orphaned: boolean;
  readonly error: EngineError | null;
}

/** `edits` and `text` are the only unsaved state, so this is the whole definition of dirty. */
export function isDirty(tab: Tab): boolean {
  return tab.edits.length > 0 || tab.text !== null;
}

function keyOf(path: readonly (string | number)[]): string {
  return JSON.stringify(path);
}

/** Last write wins per field path, so a cell typed into twenty times contributes one edit. */
function upsert(edits: readonly FieldEdit[], edit: FieldEdit): FieldEdit[] {
  const key = keyOf(edit.path);
  const kept = edits.filter((existing) => keyOf(existing.path) !== key);
  kept.push(edit);
  return kept;
}

export interface TabsState {
  tabs: Map<string, Tab>;
  /** Tab order, left to right. Separate from the map because a Map's order is insertion order. */
  order: string[];
  activeId: string | null;

  // Function properties rather than method signatures: these are read off the state object and
  // handed to event handlers, and none of them uses `this`.
  open: (node: { id: string; name: string; kind: DocumentKind }) => void;
  close: (nodeId: string) => void;
  activate: (nodeId: string) => void;
  setSubTab: (nodeId: string, subTab: SubTab) => void;
  /** Install the document the engine read, clearing loading and any previous error. */
  loaded: (nodeId: string, document: NodeDocument) => void;
  failed: (nodeId: string, error: EngineError) => void;
  setField: (nodeId: string, path: readonly (string | number)[], value: unknown) => void;
  setText: (nodeId: string, text: string | null) => void;
  /** After a successful write: the document is the new baseline and nothing is pending. */
  saved: (nodeId: string, document: NodeDocument) => void;
  markConflicted: (nodeId: string) => void;
  markOrphaned: (nodeId: string) => void;
  /**
   * Resolve a conflict by keeping the unsaved edits. Only the flag clears: the edits stay
   * pending and `saved` stays stale, so the next save deliberately overwrites what landed
   * on disk. That is the user's stated choice, so it must not be softened.
   */
  keepMine: (nodeId: string) => void;
  /**
   * Resolve a conflict by throwing the unsaved edits away. The caller re-reads the file
   * afterwards; this only makes the tab clean so the reload is not treated as a conflict.
   */
  discard: (nodeId: string) => void;
  /** Restore a draft from app data. Does not touch `saved`, which the engine still owns. */
  restoreDraft: (nodeId: string, edits: readonly FieldEdit[], text: string | null) => void;
  clear: () => void;
}

function patch(state: TabsState, nodeId: string, change: Partial<Tab>): Partial<TabsState> {
  const existing = state.tabs.get(nodeId);
  if (existing === undefined) return {};
  const tabs = new Map(state.tabs);
  tabs.set(nodeId, { ...existing, ...change });
  return { tabs };
}

export const useTabsStore = create<TabsState>((set) => ({
  tabs: new Map(),
  order: [],
  activeId: NO_ACTIVE,

  open(node) {
    set((state) => {
      if (state.tabs.has(node.id)) return { activeId: node.id };
      const tabs = new Map(state.tabs);
      tabs.set(node.id, {
        nodeId: node.id,
        title: node.name,
        kind: node.kind,
        subTab: DEFAULT_SUB_TAB,
        saved: null,
        edits: [],
        text: null,
        loading: true,
        conflicted: false,
        orphaned: false,
        error: null,
      });
      return { tabs, order: [...state.order, node.id], activeId: node.id };
    });
  },

  close(nodeId) {
    set((state) => {
      const tabs = new Map(state.tabs);
      tabs.delete(nodeId);
      const order = state.order.filter((id) => id !== nodeId);
      if (state.activeId !== nodeId) return { tabs, order };
      // Activate the tab that visually takes the closed one's place: the next one, or the last.
      const wasAt = state.order.indexOf(nodeId);
      const next = order[wasAt] ?? order[order.length - 1] ?? NO_ACTIVE;
      return { tabs, order, activeId: next };
    });
  },

  activate(nodeId) {
    set({ activeId: nodeId });
  },

  setSubTab(nodeId, subTab) {
    set((state) => patch(state, nodeId, { subTab }));
  },

  loaded(nodeId, document) {
    set((state) => patch(state, nodeId, { saved: document, loading: false, error: null, orphaned: false }));
  },

  failed(nodeId, error) {
    set((state) => patch(state, nodeId, { loading: false, error }));
  },

  setField(nodeId, path, value) {
    set((state) => {
      const existing = state.tabs.get(nodeId);
      if (existing === undefined) return {};
      return patch(state, nodeId, { edits: upsert(existing.edits, { path: [...path], value }) });
    });
  },

  setText(nodeId, text) {
    set((state) => patch(state, nodeId, { text }));
  },

  saved(nodeId, document) {
    set((state) =>
      patch(state, nodeId, { saved: document, edits: [], text: null, conflicted: false, orphaned: false }),
    );
  },

  markConflicted(nodeId) {
    set((state) => patch(state, nodeId, { conflicted: true }));
  },

  markOrphaned(nodeId) {
    set((state) => patch(state, nodeId, { orphaned: true }));
  },

  keepMine(nodeId) {
    set((state) => patch(state, nodeId, { conflicted: false }));
  },

  discard(nodeId) {
    set((state) => patch(state, nodeId, { edits: [], text: null, conflicted: false }));
  },

  restoreDraft(nodeId, edits, text) {
    set((state) => patch(state, nodeId, { edits: [...edits], text }));
  },

  clear() {
    set({ tabs: new Map(), order: [], activeId: NO_ACTIVE });
  },
}));

/** The subscription a form is allowed to make: its own tab and nothing else. */
export function useTab(nodeId: string): Tab | undefined {
  return useTabsStore((state) => state.tabs.get(nodeId));
}

export function useActiveTab(): Tab | undefined {
  return useTabsStore((state) => (state.activeId === null ? undefined : state.tabs.get(state.activeId)));
}
