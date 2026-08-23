/**
 * The palette's ranking, argued about in text rather than by squinting at a list.
 *
 * Two claims are worth defending. The matcher is a subsequence matcher, so `pmecho` has to find
 * `payment/Echo` - a substring filter is what makes a palette feel like a filter box instead of a
 * jump. And ties keep the caller's order, which is the only reason a command outranks a request
 * of equal score; a weight per kind would be the same decision made somewhere invisible.
 */
import { describe, expect, it } from "vitest";

import type { CatalogNode } from "@preman/desktop/engine/protocol.js";
import { PALETTE_LIMIT, paletteItems, rankPalette, type PaletteItem } from "@preman/desktop/renderer/model/palette.js";

const ROOT_DEPTH = 0;
const CHILD_DEPTH = 1;
const GRANDCHILD_DEPTH = 2;
const ORDER = 1000;

const COMMANDS: readonly PaletteItem[] = [
  { kind: "command", id: "search", label: "Search the workspace", detail: "command" },
  { kind: "command", id: "send", label: "Send", detail: "command" },
];

function collection(id: string, name: string): CatalogNode {
  return { id, kind: "collection", name, file: `/ws/${id}`, parentId: null, depth: ROOT_DEPTH, order: ORDER };
}

function folder(id: string, name: string, parentId: string): CatalogNode {
  return { id, kind: "folder", name, file: `/ws/${id}`, parentId, depth: CHILD_DEPTH, order: ORDER };
}

function request(id: string, name: string, parentId: string, depth = CHILD_DEPTH): CatalogNode {
  return { id, kind: "request", name, file: `/ws/${id}`, parentId, depth, order: ORDER };
}

function labels(rows: readonly { readonly item: PaletteItem }[]): string[] {
  return rows.map((row) => row.item.label);
}

function items(...entries: readonly PaletteItem[]): readonly PaletteItem[] {
  return entries;
}

describe("assembling the palette's rows", () => {
  const nodes = [
    collection("postman/collections/payment", "payment"),
    folder("postman/collections/payment/nested", "nested", "postman/collections/payment"),
    request("postman/collections/payment/Echo.request.yaml", "Echo", "postman/collections/payment"),
    request(
      "postman/collections/payment/nested/Deep Echo.request.yaml",
      "Deep Echo",
      "postman/collections/payment/nested",
      GRANDCHILD_DEPTH,
    ),
  ];

  it("givenCommandsEnvironmentsAndNodes_whenAssembled_thenTheOrderIsCommandsEnvironmentsRequests", () => {
    const assembled = paletteItems(COMMANDS, [{ name: "LOCAL" }], nodes);

    expect(assembled.map((item) => item.kind)).toStrictEqual([
      "command",
      "command",
      "environment",
      "request",
      "request",
    ]);
  });

  it("givenNestedRequest_whenAssembled_thenItsDetailIsTheFolderChainByName", () => {
    const assembled = paletteItems([], [], nodes);
    const deep = assembled.find((item) => item.label === "Deep Echo");

    // Names, not the node id: the repeated `postman/collections` prefix would push the part that
    // actually distinguishes two `Echo` rows off the end of a truncated line.
    expect(deep?.detail).toBe("payment/nested");
  });

  it("givenGroups_whenAssembled_thenNoRowOffersToOpenAFolder", () => {
    const assembled = paletteItems([], [], nodes);

    expect(assembled.every((item) => item.kind === "request")).toBe(true);
  });
});

describe("ranking the palette against a query", () => {
  it("givenEmptyQuery_whenRanked_thenTheInputOrderSurvivesUntouched", () => {
    const rows = rankPalette(items(...COMMANDS), "   ");

    expect(labels(rows)).toStrictEqual(["Search the workspace", "Send"]);
    expect(rows.every((row) => row.hits.length === 0)).toBe(true);
  });

  it("givenScatteredInitials_whenRanked_thenTheSubsequenceStillMatches", () => {
    const rows = rankPalette(items({ kind: "request", id: "a", label: "Deep Echo" }), "dpech");

    expect(labels(rows)).toStrictEqual(["Deep Echo"]);
  });

  it("givenQueryReachingIntoTheFolderChain_whenRanked_thenTheRequestIsStillFound", () => {
    const rows = rankPalette(items({ kind: "request", id: "a", label: "Echo", detail: "payment" }), "pmecho");

    // The label alone cannot match this; the folder the request lives in is half the query.
    expect(labels(rows)).toStrictEqual(["Echo"]);
  });

  it("givenLocationMatch_whenRanked_thenTheHitsAreSplitBetweenTheTwoThingsDrawn", () => {
    const [row] = rankPalette(items({ kind: "request", id: "a", label: "Echo", detail: "admin" }), "adecho");

    expect(row?.detailHits.map((hit) => "admin"[hit])).toStrictEqual(["a", "d"]);
    expect(row?.hits.map((hit) => "Echo"[hit])).toStrictEqual(["E", "c", "h", "o"]);
  });

  it("givenNameMatchAndLocationMatch_whenRanked_thenNamesComeFirstWhateverTheScores", () => {
    const rows = rankPalette(
      items(
        { kind: "request", id: "located", label: "Profile", detail: "echo/service/nested" },
        { kind: "request", id: "named", label: "an echo of something", detail: "admin" },
      ),
      "echo",
    );

    // The located row scores higher - `echo` starts its detail - and still ranks second, because
    // what a thing is called is a better answer than where it lives.
    expect(labels(rows)).toStrictEqual(["an echo of something", "Profile"]);
  });

  it("givenQueryMatchingNoLabel_whenRanked_thenNoRowComesBack", () => {
    expect(rankPalette(items(...COMMANDS), "zzz")).toHaveLength(0);
  });

  it("givenMatchAtTheStart_whenRanked_thenItOutranksTheSameMatchMidWord", () => {
    const rows = rankPalette(
      items({ kind: "request", id: "buried", label: "reEcho" }, { kind: "request", id: "start", label: "Echo again" }),
      "echo",
    );

    expect(labels(rows)).toStrictEqual(["Echo again", "reEcho"]);
  });

  it("givenMatchAfterASeparator_whenRanked_thenItOutranksTheSameMatchMidWord", () => {
    const rows = rankPalette(
      items({ kind: "request", id: "buried", label: "xecho" }, { kind: "request", id: "boundary", label: "pay/echo" }),
      "echo",
    );

    expect(labels(rows)).toStrictEqual(["pay/echo", "xecho"]);
  });

  it("givenTwoRowsScoringTheSame_whenRanked_thenTheCallersOrderBreaksTheTie", () => {
    const command: PaletteItem = { kind: "command", id: "send", label: "Send" };
    const named: PaletteItem = { kind: "request", id: "r", label: "Send" };

    expect(rankPalette(items(command, named), "send").map((row) => row.item.kind)).toStrictEqual([
      "command",
      "request",
    ]);
    expect(rankPalette(items(named, command), "send").map((row) => row.item.kind)).toStrictEqual([
      "request",
      "command",
    ]);
  });

  it("givenAMatch_whenRanked_thenHitsPointAtTheCharactersToEmphasise", () => {
    const [row] = rankPalette(items({ kind: "request", id: "a", label: "Deep Echo" }), "dec");

    expect(row?.hits.map((hit) => "Deep Echo"[hit])).toStrictEqual(["D", "e", "c"]);
  });

  it("givenMoreMatchesThanTheLimit_whenRanked_thenOnlyTheLimitIsReturned", () => {
    const many = Array.from({ length: PALETTE_LIMIT + 10 }, (_unused, at) => ({
      kind: "request" as const,
      id: String(at),
      label: `Echo ${at}`,
    }));

    expect(rankPalette(many, "echo")).toHaveLength(PALETTE_LIMIT);
    expect(rankPalette(many, "")).toHaveLength(PALETTE_LIMIT);
  });
});
