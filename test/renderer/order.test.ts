/**
 * Drop planning: what a drag turns into before anything touches a file.
 *
 * `resolveDrop` is the only thing in the app that decides whether a drag is legal, so the refusals
 * matter as much as the moves. An empty `ops` array is the refusal, and every test that expects one
 * says so by name.
 */
import { describe, expect, it } from "vitest";

import { ORDER_ABSENT, ORDER_STEP, type CatalogNode, type MutateOp } from "@preman/desktop/engine/protocol.js";
import { orderBetween, planDuplicate, resolveDrop } from "@preman/desktop/renderer/model/order.js";

const ROOT_DEPTH = 0;
const CHILD_DEPTH = 1;
const GRANDCHILD_DEPTH = 2;

function collection(id: string, order: number): CatalogNode {
  return { id, kind: "collection", name: id, file: `/ws/${id}`, parentId: null, depth: ROOT_DEPTH, order };
}

function folder(id: string, parentId: string, order: number, depth = CHILD_DEPTH): CatalogNode {
  return { id, kind: "folder", name: id, file: `/ws/${id}`, parentId, depth, order };
}

function request(id: string, parentId: string, order: number, depth = CHILD_DEPTH): CatalogNode {
  return { id, kind: "request", name: id, file: `/ws/${id}.request.yaml`, parentId, depth, order };
}

/** One collection holding three requests a full `ORDER_STEP` apart, which is the normal case. */
function threeInARow(): CatalogNode[] {
  return [
    collection("alpha", ORDER_STEP),
    request("alpha/one", "alpha", ORDER_STEP),
    request("alpha/two", "alpha", ORDER_STEP * 2),
    request("alpha/three", "alpha", ORDER_STEP * 3),
  ];
}

function reorderOf(op: MutateOp | undefined): Record<string, number> {
  if (op === undefined || op.op !== "reorder") throw new Error(`expected a reorder, got ${String(op?.op)}`);
  return op.orderById;
}

function moveOf(op: MutateOp | undefined): { targetId: string; parentId: string; order?: number } {
  if (op === undefined || op.op !== "move") throw new Error(`expected a move, got ${String(op?.op)}`);
  return op;
}

describe("orderBetween", () => {
  it("givenTwoNumbersAFullStepApart_whenAskedForTheGap_thenTheMidpointIsReturned", () => {
    expect(orderBetween(ORDER_STEP, ORDER_STEP * 2)).toBe(ORDER_STEP + ORDER_STEP / 2);
  });

  it("givenAdjacentNumbers_whenAskedForTheGap_thenNullDemandsARenumber", () => {
    // 7 and 8 have nothing between them, and inventing 7.5 would put a fraction in a YAML file
    // that every other tool reads as an integer.
    expect(orderBetween(7, 8)).toBeNull();
  });

  it("givenNoNumberBelow_whenAskedForTheGap_thenTheResultIsBelowTheOneAbove", () => {
    const placed = orderBetween(undefined, ORDER_STEP * 4);
    expect(placed).not.toBeNull();
    expect(placed).toBeLessThan(ORDER_STEP * 4);
    expect(placed).toBeGreaterThan(0);
  });

  it("givenNoNumberAbove_whenAskedForTheGap_thenAStepIsAdded", () => {
    expect(orderBetween(ORDER_STEP * 2, undefined)).toBe(ORDER_STEP * 3);
  });

  it("givenAnEmptyRange_whenAskedForTheGap_thenTheFirstStepIsReturned", () => {
    expect(orderBetween(undefined, undefined)).toBe(ORDER_STEP);
  });

  it("givenAnUndeclaredOrderBelow_whenAskedForTheGap_thenNullDemandsARenumber", () => {
    // A file with no `order` sorts after every file that has one, so there is no number that lands
    // after it. Placing something *before* it is still fine, which is the asymmetry.
    expect(orderBetween(ORDER_ABSENT, undefined)).toBeNull();
    expect(orderBetween(undefined, ORDER_ABSENT)).not.toBeNull();
  });
});

describe("resolveDrop within one parent", () => {
  it("givenARequestDroppedIntoAGap_whenPlanned_thenOneOrderIsRewritten", () => {
    const plan = resolveDrop(threeInARow(), "alpha/three", { overId: "alpha/one", side: "after" });

    expect(plan.side).toBe("after");
    expect(plan.ops).toHaveLength(1);
    // The whole point of ORDER_STEP: two files keep the numbers they already had.
    expect(reorderOf(plan.ops[0])).toStrictEqual({ "alpha/three": ORDER_STEP + ORDER_STEP / 2 });
  });

  it("givenNoRoomBetweenSiblings_whenPlanned_thenEverySiblingIsRenumbered", () => {
    const nodes = [
      collection("alpha", ORDER_STEP),
      request("alpha/one", "alpha", 1),
      request("alpha/two", "alpha", 2),
      request("alpha/three", "alpha", 3),
    ];

    const plan = resolveDrop(nodes, "alpha/three", { overId: "alpha/one", side: "after" });

    expect(plan.ops).toHaveLength(1);
    expect(reorderOf(plan.ops[0])).toStrictEqual({
      "alpha/one": ORDER_STEP,
      "alpha/three": ORDER_STEP * 2,
      "alpha/two": ORDER_STEP * 3,
    });
  });

  it("givenARequestDroppedWhereItAlreadyIs_whenPlanned_thenTheDropIsRefused", () => {
    const plan = resolveDrop(threeInARow(), "alpha/two", { overId: "alpha/one", side: "after" });

    expect(plan.ops).toStrictEqual([]);
  });

  it("givenARequestDroppedOnItself_whenPlanned_thenTheDropIsRefused", () => {
    const plan = resolveDrop(threeInARow(), "alpha/two", { overId: "alpha/two", side: "before" });

    expect(plan.ops).toStrictEqual([]);
  });

  it("givenAnUnknownNode_whenPlanned_thenTheDropIsRefused", () => {
    expect(resolveDrop(threeInARow(), "alpha/ghost", { overId: "alpha/one", side: "after" }).ops).toStrictEqual([]);
    expect(resolveDrop(threeInARow(), "alpha/one", { overId: "alpha/ghost", side: "after" }).ops).toStrictEqual([]);
  });

  it("givenTwoRootCollections_whenOneIsDroppedBesideTheOther_thenTheyAreReordered", () => {
    const nodes = [collection("alpha", ORDER_STEP), collection("beta", ORDER_STEP * 2)];

    const plan = resolveDrop(nodes, "beta", { overId: "alpha", side: "before" });

    expect(plan.ops).toHaveLength(1);
    expect(reorderOf(plan.ops[0])["beta"]).toBeLessThan(ORDER_STEP);
  });
});

describe("resolveDrop into a group", () => {
  it("givenARequestDroppedOnAFolder_whenPlanned_thenItMovesWithNoOrder", () => {
    const nodes = [
      collection("alpha", ORDER_STEP),
      folder("alpha/inner", "alpha", ORDER_STEP),
      request("alpha/one", "alpha", ORDER_STEP * 2),
    ];

    const plan = resolveDrop(nodes, "alpha/one", { overId: "alpha/inner", side: "inside" });

    expect(plan.side).toBe("inside");
    expect(plan.ops).toHaveLength(1);
    // No order at all: core's `nextOrder` appends, which is what "dropped onto a folder" means.
    expect(moveOf(plan.ops[0])).toStrictEqual({ op: "move", targetId: "alpha/one", parentId: "alpha/inner" });
  });

  it("givenARequestDroppedOnItsOwnParent_whenPlanned_thenTheDropIsRefused", () => {
    const plan = resolveDrop(threeInARow(), "alpha/one", { overId: "alpha", side: "inside" });

    expect(plan.ops).toStrictEqual([]);
  });

  it("givenAFolderDroppedIntoItsOwnChild_whenPlanned_thenTheDropIsRefused", () => {
    const nodes = [
      collection("alpha", ORDER_STEP),
      folder("alpha/outer", "alpha", ORDER_STEP),
      folder("alpha/outer/inner", "alpha/outer", ORDER_STEP, GRANDCHILD_DEPTH),
    ];

    const plan = resolveDrop(nodes, "alpha/outer", { overId: "alpha/outer/inner", side: "inside" });

    expect(plan.ops).toStrictEqual([]);
  });

  it("givenARequestDroppedInsideAnotherRequest_whenPlanned_thenTheSideResolvesToAfter", () => {
    // A request holds nothing, so the middle band cannot mean "inside". The plan says what it
    // actually did rather than echoing the pointer back at the sidebar.
    const plan = resolveDrop(threeInARow(), "alpha/three", { overId: "alpha/one", side: "inside" });

    expect(plan.side).toBe("after");
    expect(plan.ops).toHaveLength(1);
  });
});

describe("resolveDrop across parents", () => {
  it("givenARequestDroppedBesideOneInAnotherFolder_whenPlanned_thenOneMoveCarriesTheOrder", () => {
    const nodes = [
      collection("alpha", ORDER_STEP),
      folder("alpha/inner", "alpha", ORDER_STEP),
      request("alpha/inner/kept", "alpha/inner", ORDER_STEP, GRANDCHILD_DEPTH),
      request("alpha/loose", "alpha", ORDER_STEP * 2),
    ];

    const plan = resolveDrop(nodes, "alpha/loose", { overId: "alpha/inner/kept", side: "after" });

    expect(plan.ops).toHaveLength(1);
    const move = moveOf(plan.ops[0]);
    expect(move.targetId).toBe("alpha/loose");
    expect(move.parentId).toBe("alpha/inner");
    expect(move.order).toBe(ORDER_STEP * 2);
  });

  it("givenNoRoomInTheDestination_whenPlanned_thenTheRenumberIsOrderedBeforeTheMove", () => {
    const nodes = [
      collection("alpha", ORDER_STEP),
      folder("alpha/inner", "alpha", ORDER_STEP),
      request("alpha/inner/first", "alpha/inner", 1, GRANDCHILD_DEPTH),
      request("alpha/inner/second", "alpha/inner", 2, GRANDCHILD_DEPTH),
      request("alpha/loose", "alpha", ORDER_STEP * 2),
    ];

    const plan = resolveDrop(nodes, "alpha/loose", { overId: "alpha/inner/first", side: "after" });

    // Order is load-bearing, not cosmetic: the move rewrites the dragged node's id, so a reorder
    // keyed on the old id has to land first.
    expect(plan.ops).toHaveLength(2);
    expect(plan.ops[0]?.op).toBe("reorder");
    expect(plan.ops[1]?.op).toBe("move");
    const holes = reorderOf(plan.ops[0]);
    expect(holes["alpha/inner/first"]).toBeLessThan(moveOf(plan.ops[1]).order ?? 0);
    expect(holes["alpha/inner/second"]).toBeGreaterThan(moveOf(plan.ops[1]).order ?? 0);
  });

  it("givenARequestDroppedBesideARootCollection_whenPlanned_thenTheDropIsRefused", () => {
    // The collections directory is not a node, so there is no `parentId` to name in a move.
    const nodes = [
      collection("alpha", ORDER_STEP),
      request("alpha/one", "alpha", ORDER_STEP),
      collection("beta", ORDER_STEP * 2),
    ];

    const plan = resolveDrop(nodes, "alpha/one", { overId: "beta", side: "after" });

    expect(plan.ops).toStrictEqual([]);
  });

  it("givenAFolderDroppedBesideItsOwnDescendant_whenPlanned_thenTheDropIsRefused", () => {
    const nodes = [
      collection("alpha", ORDER_STEP),
      folder("alpha/outer", "alpha", ORDER_STEP),
      folder("alpha/outer/inner", "alpha/outer", ORDER_STEP, GRANDCHILD_DEPTH),
      request("alpha/outer/inner/leaf", "alpha/outer/inner", ORDER_STEP, GRANDCHILD_DEPTH + 1),
    ];

    const plan = resolveDrop(nodes, "alpha/outer", { overId: "alpha/outer/inner/leaf", side: "before" });

    expect(plan.ops).toStrictEqual([]);
  });
});

/**
 * Duplicate placement. Unlike a drop this never refuses, so every case here asserts an answer:
 * the interesting axis is how many files the answer rewrites.
 */
describe("planDuplicate", () => {
  it("givenGapBelowTheOriginal_whenPlanDuplicate_thenOneOrderAndNoReorder", () => {
    const plan = planDuplicate(threeInARow(), "alpha/one");

    expect(plan.order).toBe(ORDER_STEP + ORDER_STEP / 2);
    expect(plan.reorderOps).toStrictEqual([]);
  });

  it("givenAdjacentOrders_whenPlanDuplicate_thenTheSiblingsAreRenumberedFirst", () => {
    const nodes = [collection("alpha", ORDER_STEP), request("alpha/one", "alpha", 7), request("alpha/two", "alpha", 8)];

    const plan = planDuplicate(nodes, "alpha/one");

    // The hole is slot 2, so the original keeps slot 1 and the sibling below it steps down to 3.
    expect(reorderOf(plan.reorderOps[0])).toStrictEqual({ "alpha/one": ORDER_STEP, "alpha/two": ORDER_STEP * 3 });
    expect(plan.order).toBe(ORDER_STEP * 2);
  });

  it("givenLastSibling_whenPlanDuplicate_thenTheCopyGoesAfterIt", () => {
    const plan = planDuplicate(threeInARow(), "alpha/three");

    expect(plan.order).toBe(ORDER_STEP * 4);
    expect(plan.reorderOps).toStrictEqual([]);
  });

  it("givenSiblingWithNoDeclaredOrder_whenPlanDuplicate_thenTheCopyStillLandsBelowTheOriginal", () => {
    // `ORDER_ABSENT` below the insertion point constrains nothing, so the gap is still one write.
    const nodes = [
      collection("alpha", ORDER_STEP),
      request("alpha/one", "alpha", ORDER_STEP),
      request("alpha/two", "alpha", ORDER_ABSENT),
    ];

    const plan = planDuplicate(nodes, "alpha/one");

    expect(plan.order).toBe(ORDER_STEP * 2);
    expect(plan.reorderOps).toStrictEqual([]);
  });

  it("givenTheOriginalItselfDeclaresNoOrder_whenPlanDuplicate_thenTheSiblingsAreRenumbered", () => {
    // Nothing sorts after an absent order, so the only way below it is to give it a number.
    const nodes = [collection("alpha", ORDER_STEP), request("alpha/one", "alpha", ORDER_ABSENT)];

    const plan = planDuplicate(nodes, "alpha/one");

    expect(reorderOf(plan.reorderOps[0])).toStrictEqual({ "alpha/one": ORDER_STEP });
    expect(plan.order).toBe(ORDER_STEP * 2);
  });

  it("givenAnUnknownTarget_whenPlanDuplicate_thenNoOrderLeavesItToCore", () => {
    const plan = planDuplicate(threeInARow(), "alpha/nope");

    expect(plan.order).toBeUndefined();
    expect(plan.reorderOps).toStrictEqual([]);
  });
});
