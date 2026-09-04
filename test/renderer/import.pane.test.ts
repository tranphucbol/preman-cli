import { describe, expect, it } from "vitest";

import type { CatalogNode, ImportPlan } from "@preman/desktop/engine/protocol.js";
import {
  canImport,
  defaultTarget,
  dismissible,
  importOp,
  importTargets,
  NO_GROUPS_HINT,
  NO_PREVIEW,
  pastedCommand,
  previewLabel,
  previewTarget,
  previewVerb,
  type Preview,
} from "@preman/desktop/renderer/model/import.js";

/**
 * What the import pane decides, asserted where those decisions live rather than through a
 * component nothing here can render - the same split `protos.test.ts` and `migration.test.ts` make.
 *
 * Two of these are the whole feature. Prefilling from the clipboard is the gesture the pane exists
 * to save, and it has to be wrong-clipboard-proof or it costs the user a Select-All before they can
 * use it. And a refused paste has to leave the text alone: the box is the only copy of what they
 * pasted, and a pane that clears it on a rejection sends them back to the terminal.
 */

const CURL = "curl 'https://api.example.test/v1/orders' -H 'accept: application/json'";

function node(id: string, kind: CatalogNode["kind"], name: string, depth: number): CatalogNode {
  return { id, kind, name, file: `/ws/${id}`, parentId: null, depth, order: 1000 };
}

/** A collection, a folder inside it, and a request - the three kinds a real tree mixes. */
const NODES: readonly CatalogNode[] = [
  node("postman/collections/acme", "collection", "acme", 0),
  node("postman/collections/acme/orders", "folder", "orders", 1),
  node("postman/collections/acme/orders/Create.request.yaml", "request", "Create", 2),
];

function plan(over: Partial<ImportPlan> = {}): ImportPlan {
  return {
    format: "curl",
    kind: "http-request",
    name: "orders",
    request: { $kind: "http-request", name: "orders", url: "https://api.example.test/v1/orders", method: "POST" },
    contents: "$kind: http-request\nname: orders\n",
    dropped: [],
    warnings: [],
    specs: null,
    ...over,
  };
}

describe("the import pane", () => {
  it("givenAClipboardHoldingACurl_whenThePaneOpens_thenTheBoxIsPrefilled", () => {
    expect(pastedCommand(CURL)).toBe(CURL);
    // Whitespace a terminal copy drags along must not decide it: the command is still the command.
    expect(pastedCommand(`\n  ${CURL}\n`)).toBe(CURL);
    expect(pastedCommand("grpcurl -plaintext localhost:9090 pkg.Svc/M")).toContain("grpcurl");
  });

  it("givenAClipboardHoldingProse_whenThePaneOpens_thenTheBoxIsEmpty", () => {
    // Not a command, so not worth making the user clear before they can paste the real thing.
    expect(pastedCommand("To place an order, call the endpoint below with your token.")).toBe("");
    expect(pastedCommand("")).toBe("");
    expect(pastedCommand("   ")).toBe("");
    // A URL on its own is the near miss worth pinning: it looks importable and is not a command.
    expect(pastedCommand("https://api.example.test/v1/orders")).toBe("");
    // And a command named inside a sentence is prose, not the command.
    expect(pastedCommand("run curl against staging first")).toBe("");
  });

  it("givenAnUnparseablePaste_whenPlanned_thenTheRefusalIsUnderTheBoxAndTheTextRemains", () => {
    // The refusal is a preview state, and the preview is not the text. That separation is the
    // assertion: nothing in the union carries the paste, so nothing in it can replace the paste.
    const rejected: Preview = { kind: "rejected", message: "a command substitution", details: ["remove the $(…)"] };
    expect(rejected.kind).toBe("rejected");
    expect(canImport(rejected, "postman/collections/acme", false)).toBe(false);
    // And an empty preview is not importable either, so a cleared box cannot write a file.
    expect(canImport(NO_PREVIEW, "postman/collections/acme", false)).toBe(false);
    expect(canImport({ kind: "planning" }, "postman/collections/acme", false)).toBe(false);
  });

  it("givenAWorkspaceWithNoGroups_whenThePaneOpens_thenItSaysToMakeACollection", () => {
    const requestsOnly = [node("postman/collections/x/A.request.yaml", "request", "A", 0)];
    expect(importTargets(requestsOnly)).toEqual([]);
    expect(importTargets([])).toEqual([]);
    // Nothing to point at, so nothing is importable however good the plan is.
    expect(canImport({ kind: "planned", plan: plan() }, defaultTarget([], undefined, null), false)).toBe(false);
    expect(NO_GROUPS_HINT).toMatch(/collection/);
  });

  it("givenAPlannedImport_whenImportIsPressed_thenTheTabOpensAndThePaneDismisses", () => {
    const planned: Preview = { kind: "planned", plan: plan() };
    const target = "postman/collections/acme/orders";
    expect(canImport(planned, target, false)).toBe(true);

    // The name only travels when the user changed it: sending back the one the engine chose would
    // ask it to re-resolve a collision it already resolved.
    expect(importOp(plan(), target, "orders")).toEqual({ op: "import-request", parentId: target, plan: plan() });
    expect(importOp(plan(), target, "  Orders v2 ")).toEqual({
      op: "import-request",
      parentId: target,
      plan: plan(),
      name: "Orders v2",
    });
    // A field the user emptied is not a rename to nothing; it falls back to the plan's own name.
    expect(importOp(plan(), target, "   ")).toEqual({ op: "import-request", parentId: target, plan: plan() });
  });

  it("givenAnImportInFlight_whenEscapeIsPressed_thenThePaneStaysOpen", () => {
    // Files are being written - a request, and possibly a link and a resources.yaml entry with it.
    expect(dismissible(true)).toBe(false);
    expect(dismissible(false)).toBe(true);
    // The button goes with it, so a second Enter cannot import the same plan twice.
    expect(canImport({ kind: "planned", plan: plan() }, "postman/collections/acme", true)).toBe(false);
  });

  it("givenGroups_whenTheTargetsAreListed_thenRequestsAndTheRootAreAbsent", () => {
    // No workspace-root row, unlike `groupDestinations`: a `.request.yaml` at the root belongs to
    // no collection, so offering it would write a file the catalog does not show.
    expect(importTargets(NODES)).toEqual([
      { id: "postman/collections/acme", label: "acme" },
      { id: "postman/collections/acme/orders", label: "\u00a0\u00a0orders" },
    ]);
  });

  it("givenAskedAndSelectedGroups_whenTheDefaultIsChosen_thenTheAskedOneWins", () => {
    const targets = importTargets(NODES);
    const asked = "postman/collections/acme/orders";
    expect(defaultTarget(targets, asked, "postman/collections/acme")).toBe(asked);
    // No right-click, so the selection decides.
    expect(defaultTarget(targets, undefined, "postman/collections/acme")).toBe("postman/collections/acme");
    // A selected request is not a destination, so it falls through to the first group.
    expect(defaultTarget(targets, undefined, "postman/collections/acme/orders/Create.request.yaml")).toBe(
      "postman/collections/acme",
    );
    // A group that has since been deleted must not be offered back.
    expect(defaultTarget(targets, "postman/collections/gone", null)).toBe("postman/collections/acme");
  });

  it("givenAGrpcPlan_whenSummarised_thenTheChipReadsGrpcAndTheTargetIsTheMethodPath", () => {
    const grpc = plan({
      kind: "grpc-request",
      request: { $kind: "grpc-request", name: "Echo", url: "localhost:9090", methodPath: "test.echo.EchoService.Echo" },
    });
    // What the sidebar row will read in the same slot; the method tail is a click away.
    expect(previewLabel(grpc)).toBe("gRPC");
    expect(previewTarget(grpc)).toBe("test.echo.EchoService.Echo");
    // No verb, so nothing for `methodClass` to colour.
    expect(previewVerb(grpc)).toBeUndefined();
  });

  it("givenAnHttpPlan_whenSummarised_thenTheChipIsTheVerbAndTheTargetIsTheUrl", () => {
    expect(previewLabel(plan())).toBe("POST");
    expect(previewVerb(plan())).toBe("POST");
    expect(previewTarget(plan())).toBe("https://api.example.test/v1/orders");
    // The verb is always present - `httpRequestSchema` defaults it to GET - so the chip has
    // something to colour for every HTTP plan there can be.
    expect(previewLabel(plan({ request: { $kind: "http-request", url: "https://x.test", method: "get" } }))).toBe(
      "GET",
    );
  });
});
