/**
 * Where a dragged row lands, and what that costs in writes.
 *
 * The sidebar is flat and pre-sorted, so "drop between these two" is not an array splice: it is a
 * number written into a YAML file. This module turns a drop into the smallest set of mutations
 * that produces it, and it is pure so that the answer is testable without a pointer.
 *
 * Two rules shape every branch below.
 *
 * 1. Prefer the gap. `ORDER_STEP` is 1000 precisely so a row can be inserted between two siblings
 *    by writing one number into one file. Renumbering the whole sibling list would rewrite files
 *    the user never touched, so it is the fallback, not the strategy.
 * 2. Refuse rather than guess. A drop that cannot be expressed returns no operations, and the
 *    sidebar draws no indicator for an empty plan. An ambiguous drop that silently does something
 *    adjacent is worse than a drop that visibly does nothing.
 */
import { ORDER_ABSENT, ORDER_STEP, type CatalogNode, type MutateOp } from "@preman/desktop/engine/protocol.js";

/** Which edge of the row under the pointer the drop landed on. */
export type DropSide = "before" | "after" | "inside";

export interface DropTarget {
  readonly overId: string;
  readonly side: DropSide;
}

export interface DropPlan {
  /**
   * The side actually used. `inside` a request resolves to `after`, so the caller draws the
   * indicator it is going to get rather than the one the pointer implied.
   */
  readonly side: DropSide;
  /** In order, and not atomic: see `planBesideAcross`. Empty means the drop is refused. */
  readonly ops: readonly MutateOp[];
}

const NO_OPS: readonly MutateOp[] = [];
/** Slots are 1-based so the first sibling gets `ORDER_STEP` rather than 0. */
const FIRST_SLOT = 1;
/** Two orders one apart have nothing between them, so that is the renumber threshold. */
const MIN_GAP = 1;
const HALF = 2;
const NOT_FOUND = -1;

function refuse(side: DropSide): DropPlan {
  return { side, ops: NO_OPS };
}

function index(nodes: readonly CatalogNode[]): Map<string, CatalogNode> {
  const byId = new Map<string, CatalogNode>();
  for (const node of nodes) byId.set(node.id, node);
  return byId;
}

/** Is `nodeId` somewhere below `ancestorId`? Walking up is cheaper than walking a subtree down. */
function contains(byId: ReadonlyMap<string, CatalogNode>, ancestorId: string, nodeId: string): boolean {
  let cursor = byId.get(nodeId)?.parentId ?? null;
  while (cursor !== null) {
    if (cursor === ancestorId) return true;
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return false;
}

/** The order that puts a node at slot `position` of a freshly numbered sibling list. */
function slotAt(position: number): number {
  return (position + FIRST_SLOT) * ORDER_STEP;
}

function numbered(nodes: readonly CatalogNode[]): Record<string, number> {
  const orderById: Record<string, number> = {};
  nodes.forEach((node, position) => {
    orderById[node.id] = slotAt(position);
  });
  return orderById;
}

/**
 * A value strictly between two sibling orders, or null when there is no room and the list has to
 * be renumbered.
 *
 * `ORDER_ABSENT` is the interesting case in both directions. A sibling that declares no `order`
 * sorts after every sibling that does, so a number can always be placed *before* one and never
 * *after* one. That asymmetry is why this is a function rather than a subtraction at the call site.
 */
export function orderBetween(prev: number | undefined, next: number | undefined): number | null {
  // An absent order following the insertion point constrains nothing: any number sorts before it.
  const below = next === undefined || next === ORDER_ABSENT ? undefined : next;

  if (prev === undefined) {
    if (below === undefined) return ORDER_STEP;
    if (below > ORDER_STEP) return below - ORDER_STEP;
    if (below > MIN_GAP) return Math.floor(below / HALF);
    return null;
  }
  if (prev === ORDER_ABSENT) return null;
  if (below === undefined) {
    const after = prev + ORDER_STEP;
    return after < ORDER_ABSENT ? after : null;
  }
  const gap = below - prev;
  return gap > MIN_GAP ? prev + Math.floor(gap / HALF) : null;
}

export interface DuplicatePlan {
  /** Written into the copy. `undefined` means "last", which core resolves with `nextOrder`. */
  readonly order: number | undefined;
  /** Run before the duplicate, and only when the gap below the original was exhausted. */
  readonly reorderOps: readonly MutateOp[];
}

/**
 * Where a copy of `targetId` lands: directly below the original.
 *
 * Unlike {@link resolveDrop} this never refuses, which is worth saying given rule 2 above. A drop
 * can name a position that cannot be expressed; a duplicate cannot, because the worst case is
 * still a legitimate answer — no `order` at all, which core reads as last.
 *
 * The order is computed here rather than in the engine because it needs the sorted sibling list
 * the catalog already holds, and the engine would have to re-derive it. Same division `resolveDrop`
 * uses.
 */
export function planDuplicate(nodes: readonly CatalogNode[], targetId: string): DuplicatePlan {
  const target = index(nodes).get(targetId);
  if (target === undefined) return { order: undefined, reorderOps: NO_OPS };

  const siblings = nodes.filter((node) => node.parentId === target.parentId);
  const targetAt = siblings.findIndex((node) => node.id === targetId);
  if (targetAt === NOT_FOUND) return { order: undefined, reorderOps: NO_OPS };

  const slot = orderBetween(target.order, siblings[targetAt + 1]?.order);
  if (slot !== null) return { order: slot, reorderOps: NO_OPS };

  // No room below the original, so renumber the siblings to open a hole and put the copy in it.
  const orderById: Record<string, number> = {};
  siblings.forEach((node, position) => {
    orderById[node.id] = slotAt(position <= targetAt ? position : position + 1);
  });
  return { order: slotAt(targetAt + 1), reorderOps: [{ op: "reorder", orderById }] };
}

/**
 * The mutations a drop produces, or none when it cannot be expressed.
 *
 * `nodes` must be the catalog's own array: it is already sorted in Postman order, and every
 * sibling list below is derived by filtering it rather than sorting again.
 */
export function resolveDrop(nodes: readonly CatalogNode[], draggedId: string, target: DropTarget): DropPlan {
  const byId = index(nodes);
  const dragged = byId.get(draggedId);
  const over = byId.get(target.overId);
  if (dragged === undefined || over === undefined || draggedId === target.overId) return refuse(target.side);

  // A request holds nothing, so the middle band of a request row means "after it", not "into it".
  const side: DropSide = target.side === "inside" && over.kind === "request" ? "after" : target.side;

  return side === "inside" ? planInside(byId, dragged, over) : planBeside(nodes, byId, dragged, over, side);
}

function planInside(byId: ReadonlyMap<string, CatalogNode>, dragged: CatalogNode, over: CatalogNode): DropPlan {
  const side: DropSide = "inside";
  // Already this group's child: the drop is a no-op, and "move it to the end" is not what dropping
  // onto a parent means anywhere else.
  if (dragged.parentId === over.id) return refuse(side);
  if (contains(byId, dragged.id, over.id)) return refuse(side);
  // No `order`: `nextOrder` in core puts it after every sibling that declares one, which is the
  // only honest meaning of "into here" when the pointer named no position.
  return { side, ops: [{ op: "move", targetId: dragged.id, parentId: over.id }] };
}

function planBeside(
  nodes: readonly CatalogNode[],
  byId: ReadonlyMap<string, CatalogNode>,
  dragged: CatalogNode,
  over: CatalogNode,
  side: DropSide,
): DropPlan {
  const parentId = over.parentId;
  if (parentId !== null && (parentId === dragged.id || contains(byId, dragged.id, parentId))) return refuse(side);

  const siblings = nodes.filter((node) => node.parentId === parentId);
  const sequence = siblings.filter((node) => node.id !== dragged.id);
  const overAt = sequence.findIndex((node) => node.id === over.id);
  if (overAt === NOT_FOUND) return refuse(side);

  const insertAt = side === "before" ? overAt : overAt + 1;
  const slot = orderBetween(sequence[insertAt - 1]?.order, sequence[insertAt]?.order);

  if (dragged.parentId === parentId) return planBesideWithin(dragged, siblings, sequence, insertAt, slot, side);
  // Collections live at the root, and the root is a directory with no node id, so there is nothing
  // to name as a `parentId`. Reordering root collections works; moving a folder up to become one
  // does not, and the sidebar draws no indicator for it.
  if (parentId === null) return refuse(side);
  return planBesideAcross(dragged, parentId, sequence, insertAt, slot, side);
}

function planBesideWithin(
  dragged: CatalogNode,
  siblings: readonly CatalogNode[],
  sequence: readonly CatalogNode[],
  insertAt: number,
  slot: number | null,
  side: DropSide,
): DropPlan {
  // Removing the dragged node and putting it back at its own index changes nothing.
  if (insertAt === siblings.findIndex((node) => node.id === dragged.id)) return refuse(side);
  if (slot !== null) return { side, ops: [{ op: "reorder", orderById: { [dragged.id]: slot } }] };

  const final = [...sequence.slice(0, insertAt), dragged, ...sequence.slice(insertAt)];
  return { side, ops: [{ op: "reorder", orderById: numbered(final) }] };
}

/**
 * A move into a different parent.
 *
 * With a gap available this is one operation. Without one, the destination is renumbered to open a
 * hole and then the node is moved into it, in that order: the move changes the node's id, so a
 * reorder issued afterwards would be keyed on an id that no longer exists.
 *
 * The two operations are not atomic and core has no transaction. A failure after the reorder
 * leaves the destination renumbered and the tree otherwise untouched, which is visible in the
 * sidebar and recoverable with git. Naming it here beats discovering it in a diff.
 */
function planBesideAcross(
  dragged: CatalogNode,
  parentId: string,
  sequence: readonly CatalogNode[],
  insertAt: number,
  slot: number | null,
  side: DropSide,
): DropPlan {
  if (slot !== null) return { side, ops: [{ op: "move", targetId: dragged.id, parentId, order: slot }] };

  const orderById: Record<string, number> = {};
  sequence.forEach((node, position) => {
    orderById[node.id] = slotAt(position < insertAt ? position : position + 1);
  });
  return {
    side,
    ops: [
      { op: "reorder", orderById },
      { op: "move", targetId: dragged.id, parentId, order: slotAt(insertAt) },
    ],
  };
}
