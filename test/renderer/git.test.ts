/**
 * The git overlay's arithmetic: which rows carry a mark, and which mark.
 *
 * `deriveGitDecorations` is the whole overlay. The pixels are one span per row, so the only thing
 * worth defending is the mapping - and the case that matters most has no row at all: a deleted
 * request is gone from disk, so the catalog never saw it, and the folder above it is the only
 * honest place left to say something happened.
 */
import { describe, expect, it } from "vitest";

import { GROUP_DEFINITION_SUFFIX, type CatalogNode, type GitFileStatus } from "@preman/desktop/engine/protocol.js";
import { DESCENDANT, deriveGitDecorations } from "@preman/desktop/renderer/model/git.js";

const ROOT_DEPTH = 0;
const CHILD_DEPTH = 1;
const ORDER = 1000;

const PAYMENT = "postman/collections/payment";
const NESTED = `${PAYMENT}/nested`;
const ECHO = `${PAYMENT}/Echo.request.yaml`;
const PING = `${PAYMENT}/Ping.request.yaml`;
const DEEP = `${NESTED}/Deep Echo.request.yaml`;

function collection(id: string): CatalogNode {
  return { id, kind: "collection", name: id, file: `/ws/${id}`, parentId: null, depth: ROOT_DEPTH, order: ORDER };
}

function folder(id: string, parentId: string): CatalogNode {
  return { id, kind: "folder", name: id, file: `/ws/${id}`, parentId, depth: CHILD_DEPTH, order: ORDER };
}

function request(id: string, parentId: string): CatalogNode {
  return { id, kind: "request", name: id, file: `/ws/${id}`, parentId, depth: CHILD_DEPTH, order: ORDER };
}

/** The fixture's shape: one collection, one folder inside it, requests in both. */
function tree(): CatalogNode[] {
  return [
    collection(PAYMENT),
    folder(NESTED, PAYMENT),
    request(ECHO, PAYMENT),
    request(PING, PAYMENT),
    request(DEEP, NESTED),
  ];
}

function files(entries: Record<string, GitFileStatus>): Readonly<Record<string, GitFileStatus>> {
  return entries;
}

describe("deriving git decorations", () => {
  it("givenNoChanges_whenDerived_thenNoRowIsDecorated", () => {
    expect(deriveGitDecorations(tree(), files({})).size).toBe(0);
  });

  it("givenChangedRequest_whenDerived_thenItsRowCarriesGitsOwnWord", () => {
    const decorations = deriveGitDecorations(tree(), files({ [ECHO]: "modified" }));

    expect(decorations.get(ECHO)).toBe("modified");
    expect(decorations.get(PING)).toBeUndefined();
  });

  it("givenChangedRequest_whenDerived_thenEveryFolderAboveItIsMarkedAsDescendant", () => {
    const decorations = deriveGitDecorations(tree(), files({ [DEEP]: "added" }));

    expect(decorations.get(DEEP)).toBe("added");
    expect(decorations.get(NESTED)).toBe(DESCENDANT);
    expect(decorations.get(PAYMENT)).toBe(DESCENDANT);
  });

  it("givenChangedDefinitionFile_whenDerived_thenTheFolderItselfIsDecorated", () => {
    // The definition file has no row of its own; it *is* the folder as far as the tree is concerned.
    const decorations = deriveGitDecorations(tree(), files({ [`${NESTED}${GROUP_DEFINITION_SUFFIX}`]: "modified" }));

    expect(decorations.get(NESTED)).toBe("modified");
    expect(decorations.get(PAYMENT)).toBe(DESCENDANT);
  });

  it("givenAFolderChangedBothInItselfAndBelow_whenDerived_thenItsOwnStatusWins", () => {
    const decorations = deriveGitDecorations(
      tree(),
      files({ [`${NESTED}${GROUP_DEFINITION_SUFFIX}`]: "modified", [DEEP]: "untracked" }),
    );

    expect(decorations.get(NESTED)).toBe("modified");
  });

  it("givenDeletedRequestWithNoRowLeft_whenDerived_thenItsFolderStillSaysSomethingHappened", () => {
    const nodes = tree().filter((node) => node.id !== DEEP);

    const decorations = deriveGitDecorations(nodes, files({ [DEEP]: "deleted" }));

    expect(decorations.has(DEEP)).toBe(false);
    expect(decorations.get(NESTED)).toBe(DESCENDANT);
    expect(decorations.get(PAYMENT)).toBe(DESCENDANT);
  });

  it("givenChangedFileOutsideTheTree_whenDerived_thenNothingIsInvented", () => {
    const decorations = deriveGitDecorations(
      tree(),
      files({ "README.md": "modified", ".postman/resources.yaml": "added" }),
    );

    expect(decorations.size).toBe(0);
  });
});
