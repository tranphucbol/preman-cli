/**
 * The sidebar's name filter and the guard on the chord that focuses it.
 *
 * `filterTree` is what the tree paints while a fragment is typed, so these pin which rows stay:
 * a matching request keeps its chain to the root, a matching group keeps its whole subtree, and
 * catalog order survives. `findTargetsTree` is the one decision `Cmd+F` makes before stealing
 * focus from wherever the user is.
 */
import { describe, expect, it } from "vitest";

import type { CatalogNode } from "@preman/desktop/engine/protocol.js";
import { filterTree, findTargetsTree, splitName } from "@preman/desktop/renderer/model/treeFilter.js";

function node(
  id: string,
  kind: CatalogNode["kind"],
  name: string,
  parentId: string | null,
  depth: number,
): CatalogNode {
  return { id, kind, name, file: id, parentId, depth, order: 0 };
}

// payment
//   Echo
//   Billing
//     Refund
//     Capture
// orders
//   List orders
const NODES: readonly CatalogNode[] = [
  node("payment", "collection", "payment", null, 0),
  node("payment/Echo", "request", "Echo", "payment", 1),
  node("payment/Billing", "folder", "Billing", "payment", 1),
  node("payment/Billing/Refund", "request", "Refund", "payment/Billing", 2),
  node("payment/Billing/Capture", "request", "Capture", "payment/Billing", 2),
  node("orders", "collection", "orders", null, 0),
  node("orders/List", "request", "List orders", "orders", 1),
];

describe("filtering the tree by name", () => {
  it("givenEmptyOrBlankText_whenFiltered_thenTheTreeIsLeftAlone", () => {
    expect(filterTree(NODES, "")).toBeNull();
    expect(filterTree(NODES, "   ")).toBeNull();
  });

  it("givenMatchingRequest_whenFiltered_thenItsAncestorsStayAndSiblingsGo", () => {
    const result = filterTree(NODES, "refund");

    expect(result?.ids).toEqual(["payment", "payment/Billing", "payment/Billing/Refund"]);
    expect([...(result?.matched ?? [])]).toEqual(["payment/Billing/Refund"]);
  });

  it("givenMatchingFolder_whenFiltered_thenItsWholeSubtreeStays", () => {
    const result = filterTree(NODES, "BILL");

    expect(result?.ids).toEqual(["payment", "payment/Billing", "payment/Billing/Refund", "payment/Billing/Capture"]);
    expect([...(result?.matched ?? [])]).toEqual(["payment/Billing"]);
  });

  it("givenMatchesInSeveralBranches_whenFiltered_thenCatalogOrderIsKept", () => {
    // "Echo" matches under the first collection, "orders" is the second collection itself.
    const result = filterTree(NODES, "o");

    expect(result?.ids).toEqual(["payment", "payment/Echo", "orders", "orders/List"]);
    expect([...(result?.matched ?? [])]).toEqual(["payment/Echo", "orders", "orders/List"]);
  });

  it("givenNoMatch_whenFiltered_thenNoRowsRemain", () => {
    expect(filterTree(NODES, "zzz")?.ids).toEqual([]);
  });
});

describe("cutting a name around the match", () => {
  it("givenMatch_whenSplit_thenTheOriginalCaseIsKept", () => {
    expect(splitName("List orders", " ORD ")).toEqual({ before: "List ", match: "ord", after: "ers" });
  });

  it("givenNoMatchOrNoText_whenSplit_thenNull", () => {
    expect(splitName("Echo", "refund")).toBeNull();
    expect(splitName("Echo", "")).toBeNull();
  });
});

describe("where Cmd+F goes", () => {
  const UNCLAIMED = { inEditor: false, claimed: false };

  it("givenNothingElseClaims_whenFind_thenTheFilterBoxTakesIt", () => {
    expect(findTargetsTree(UNCLAIMED)).toBe(true);
  });

  it("givenEditorOrEarlierClaim_whenFind_thenTheFilterBoxLeavesIt", () => {
    expect(findTargetsTree({ ...UNCLAIMED, inEditor: true })).toBe(false);
    expect(findTargetsTree({ ...UNCLAIMED, claimed: true })).toBe(false);
  });
});
