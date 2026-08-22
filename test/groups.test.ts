import { describe, expect, it } from "vitest";
import { aggregateTests, type GroupRunItem, type RunOutcome } from "@preman/core/runner.js";
import {
  listGroups,
  listRequests,
  resolveSelector,
  targetLabel,
  targetPath,
  type RequestEntry,
  type RunTarget,
} from "@preman/core/workspace/collections.js";
import { fixtureWorkspace } from "./helpers.js";

const requests = listRequests(fixtureWorkspace());

function entryOf(path: string): RequestEntry {
  const found = requests.find((r) => r.path === path);
  if (!found) throw new Error(`fixture has no request at ${path}`);
  return found;
}

describe("listGroups", () => {
  it("givenNestedFolders_whenListing_thenEveryAncestorBecomesAGroup", () => {
    const groups = listGroups(requests);
    expect(groups.map((g) => g.path)).toEqual(["payment", "payment/nested"]);
  });

  it("givenCollection_whenListing_thenItHoldsNestedRequestsToo", () => {
    const [collection, folder] = listGroups(requests);

    expect(collection?.kind).toBe("collection");
    expect(collection?.name).toBe("payment");
    // The collection includes the request that lives in the nested folder.
    // Root requests first in Postman `order`, then each folder's contents.
    expect(collection?.requests.map((r) => r.path)).toEqual([
      "payment/Ping",
      "payment/Echo",
      "payment/Legacy Http",
      "payment/Descriptor Only",
      "payment/nested/Deep Echo",
    ]);

    expect(folder?.kind).toBe("folder");
    expect(folder?.name).toBe("nested");
    expect(folder?.requests.map((r) => r.path)).toEqual(["payment/nested/Deep Echo"]);
  });

  it("givenNoRequests_whenListing_thenNoGroups", () => {
    expect(listGroups([])).toEqual([]);
  });
});

describe("resolveSelector", () => {
  function target(selector: string): RunTarget {
    const { target: resolved, candidates } = resolveSelector(requests, selector);
    if (!resolved) throw new Error(`"${selector}" did not resolve (${candidates.length} candidates)`);
    return resolved;
  }

  it("givenExactRequestPath_whenResolving_thenPicksThatRequest", () => {
    const resolved = target("payment/nested/Deep Echo");
    expect(resolved.kind).toBe("request");
    expect(targetPath(resolved)).toBe("payment/nested/Deep Echo");
  });

  it("givenCollectionName_whenResolving_thenPicksTheWholeCollection", () => {
    const resolved = target("payment");
    expect(resolved.kind).toBe("group");
    expect(targetPath(resolved)).toBe("payment");
    if (resolved.kind !== "group") throw new Error("unreachable");
    expect(resolved.group.requests).toHaveLength(5);
  });

  it("givenFolderName_whenResolving_thenPicksThatFolderOnly", () => {
    const byName = target("nested");
    const byPath = target("payment/nested");
    expect(byName).toEqual(byPath);
    if (byPath.kind !== "group") throw new Error("unreachable");
    expect(byPath.group.requests.map((r) => r.path)).toEqual(["payment/nested/Deep Echo"]);
  });

  it("givenSelectorMatchingBoth_whenResolving_thenTheRequestNameWins", () => {
    // A request named exactly like the selector is a stronger signal than a
    // folder whose path merely ends with it.
    const resolved = target("Echo");
    expect(resolved.kind).toBe("request");
    expect(targetPath(resolved)).toBe("payment/Echo");
  });

  it("givenSubstringSelector_whenResolving_thenGroupsAreNotConsidered", () => {
    // "pay" would substring-match the `payment` collection, but the substring
    // tier is request-only so this stays ambiguous between requests.
    const { target: resolved, candidates } = resolveSelector(requests, "pay");
    expect(resolved).toBeUndefined();
    expect(candidates).toHaveLength(5);
    expect(candidates.every((c) => c.kind === "request")).toBe(true);
  });

  it("givenAmbiguousSubstring_whenResolving_thenReportsRequestCandidates", () => {
    const { target: resolved, candidates } = resolveSelector(requests, "Ech");
    expect(resolved).toBeUndefined();
    expect(candidates.map(targetPath)).toEqual(["payment/Echo", "payment/nested/Deep Echo"]);
  });

  it("givenUnknownSelector_whenResolving_thenNothingMatches", () => {
    expect(resolveSelector(requests, "nope")).toEqual({ target: undefined, candidates: [] });
  });

  it("givenBlankSelector_whenResolving_thenNothingMatches", () => {
    expect(resolveSelector(requests, "   ")).toEqual({ target: undefined, candidates: [] });
  });
});

describe("targetLabel", () => {
  it("givenGrpcRequest_whenLabelling_thenJustThePath", () => {
    expect(targetLabel({ kind: "request", entry: entryOf("payment/Echo") })).toBe("payment/Echo");
  });

  it("givenNonGrpcRequest_whenLabelling_thenKindIsCalledOut", () => {
    expect(targetLabel({ kind: "request", entry: entryOf("payment/Legacy Http") })).toBe(
      "payment/Legacy Http (websocket-request)",
    );
  });

  it("givenGroups_whenLabelling_thenCountIsPluralised", () => {
    const [collection, folder] = listGroups(requests);
    expect(targetLabel({ kind: "group", group: collection! })).toBe("payment (collection, 5 requests)");
    expect(targetLabel({ kind: "group", group: folder! })).toBe("payment/nested (folder, 1 request)");
  });
});

describe("aggregateTests", () => {
  it("givenGroupWithAssertions_whenAggregateTests_thenTotalsSummed", () => {
    const entry = entryOf("payment/Echo");
    const outcome = {
      tests: [{ status: "passed" }, { status: "failed" }, { status: "skipped" }],
    } as unknown as RunOutcome;
    const items: GroupRunItem[] = [
      { entry, iteration: 0, status: "test", outcome, error: undefined },
      { entry, iteration: 0, status: "error", outcome: undefined, error: { message: "failed", details: [] } },
    ];

    expect(aggregateTests(items)).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1 });
  });
});
