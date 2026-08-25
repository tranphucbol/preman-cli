/**
 * Where the `+` in the tab row proposes to put a new request or folder.
 *
 * The fallback chain is the whole feature, so each link gets a case and so does the end of it: the
 * root is the floor, and a version of this that reached for the first collection instead would pass
 * every other test here.
 */
import { describe, expect, it } from "vitest";

import { ORDER_STEP, type CatalogNode } from "@preman/desktop/engine/protocol.js";
import {
  defaultDestination,
  groupDestinations,
  ROOT_DESTINATION_ID,
} from "@preman/desktop/renderer/model/destination.js";

const ROOT_DEPTH = 0;
const CHILD_DEPTH = 1;

function collection(id: string): CatalogNode {
  return { id, kind: "collection", name: id, file: `/ws/${id}`, parentId: null, depth: ROOT_DEPTH, order: ORDER_STEP };
}

function folder(id: string, parentId: string): CatalogNode {
  return { id, kind: "folder", name: id, file: `/ws/${id}`, parentId, depth: CHILD_DEPTH, order: ORDER_STEP };
}

function request(id: string, parentId: string): CatalogNode {
  return {
    id,
    kind: "request",
    name: id,
    file: `/ws/${id}.request.yaml`,
    parentId,
    depth: CHILD_DEPTH,
    order: ORDER_STEP,
  };
}

/** A collection, a folder in it, and a request in each. */
function tree(): CatalogNode[] {
  return [
    collection("alpha"),
    request("alpha/one", "alpha"),
    folder("alpha/inner", "alpha"),
    request("alpha/inner/deep", "alpha/inner"),
  ];
}

describe("defaultDestination", () => {
  it("givenActiveTab_whenDefaultDestination_thenItIsTheTabsFolder", () => {
    expect(defaultDestination(tree(), "alpha/inner/deep", "alpha")).toBe("alpha/inner");
  });

  it("givenNoTabButASelectedFolder_whenDefaultDestination_thenItIsTheSelection", () => {
    expect(defaultDestination(tree(), null, "alpha/inner")).toBe("alpha/inner");
  });

  it("givenNoTabButASelectedRequest_whenDefaultDestination_thenItIsThatRequestsFolder", () => {
    expect(defaultDestination(tree(), null, "alpha/one")).toBe("alpha");
  });

  it("givenNoTabAndNoSelection_whenDefaultDestination_thenTheRoot", () => {
    expect(defaultDestination(tree(), null, null)).toBe(ROOT_DESTINATION_ID);
  });

  it("givenASelectedCollection_whenDefaultDestination_thenItIsThatCollectionAndNotTheRoot", () => {
    // A collection's own `parentId` is null, so the `?? root` fallback must not fire for the branch
    // that already found the group it was looking for.
    expect(defaultDestination(tree(), null, "alpha")).toBe("alpha");
  });

  it("givenATabOnANodeTheCatalogNoLongerHas_whenDefaultDestination_thenTheSelectionAnswers", () => {
    // The watcher can delete a file while its tab is still open, and a stale id must not win.
    expect(defaultDestination(tree(), "alpha/gone.request.yaml", "alpha/inner")).toBe("alpha/inner");
  });
});

describe("groupDestinations", () => {
  it("givenACatalog_whenGroupDestinations_thenTheRootLeadsAndGroupsFollowIndentedByDepth", () => {
    // The indent is non-breaking, and asserted as an escape so the difference is visible in the
    // diff rather than being two characters that look like two other characters: HTML collapses
    // leading ordinary spaces, so a plain-space indent would never reach the screen.
    expect(groupDestinations(tree())).toStrictEqual([
      { id: ROOT_DESTINATION_ID, label: "Workspace root" },
      { id: "alpha", label: "\u00a0\u00a0alpha" },
      { id: "alpha/inner", label: "\u00a0\u00a0\u00a0\u00a0alpha/inner" },
    ]);
  });

  it("givenAWorkspaceWithNoCollections_whenGroupDestinations_thenOnlyTheRoot", () => {
    // Which is what makes the `+` always pressable in an open workspace: there is always somewhere
    // to put the first collection.
    expect(groupDestinations([])).toStrictEqual([{ id: ROOT_DESTINATION_ID, label: "Workspace root" }]);
  });
});
