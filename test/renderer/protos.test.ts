import { describe, expect, it } from "vitest";

import type { DeclaredSpec, PlannedSpec, SharedLink, SpecPlan, SpecsView } from "@preman/desktop/engine/protocol.js";
import {
  DANGLING_HINT,
  freeName,
  linkStates,
  MISSING_LABEL,
  NOT_A_LINK_HINT,
  OWN_CHECKOUT_LABEL,
  planBlocked,
  plannedWrites,
  specFlags,
  takenNames,
  unlinkedCount,
  writes,
} from "@preman/desktop/renderer/model/protos.js";

/**
 * What the protos pane works out before it draws, asserted where it lives rather than through a
 * component nothing here can render - the split `migration.test.ts` and `opening.test.ts` make.
 *
 * The first half is the derivation that earns the pane: the links a workspace needs are nowhere in
 * the engine's answer, and the shared root is machine-wide, so getting this wrong shows a reader
 * either none of their problems or somebody else's repositories.
 */

const SHARED = "/Users/Shared/postman-protos";
const CHECKOUT = "/Users/bob/work/refund-core";

function spec(declared: string, extra: Partial<DeclaredSpec> = {}): DeclaredSpec {
  return { declared, path: declared, exists: true, link: undefined, via: "link", ...extra };
}

function shared(name: string, rest: string): DeclaredSpec {
  return spec(`${SHARED}/${name}/${rest}`, { link: name });
}

/** The same declaration, read out of the workspace's own checkout instead of through the link. */
function fromCheckout(name: string, rest: string): DeclaredSpec {
  return spec(`${SHARED}/${name}/${rest}`, { link: name, path: `${CHECKOUT}/${rest}`, via: "own-checkout" });
}

function link(name: string, target: string | undefined, resolves: boolean): SharedLink {
  return { name, target, resolves };
}

function view(
  specs: readonly DeclaredSpec[],
  links: readonly SharedLink[] = [],
  unresolvedLinks: readonly string[] = [],
  ownCheckout: string | undefined = undefined,
): SpecsView {
  return {
    root: "/ws",
    resourcesPath: "/ws/.postman/resources.yaml",
    sharedRoot: SHARED,
    specs: [...specs],
    links: [...links],
    unresolvedLinks: [...unresolvedLinks],
    ownCheckout,
  };
}

function plan(entries: SpecPlan["entries"], conflicts: readonly string[] = []): SpecPlan {
  return { sharedRoot: SHARED, links: [], entries, conflicts: [...conflicts] };
}

describe("linkStates", () => {
  it("givenManySpecsThroughOneLink_whenDerivingLinks_thenOneRowPerRepository", () => {
    const states = linkStates(
      view([
        shared("refund-core", "api/a.proto"),
        shared("refund-core", "api/b.proto"),
        shared("zas-spec", "api/c.proto"),
      ]),
    );

    expect(states.map((state) => state.name)).toEqual(["refund-core", "zas-spec"]);
  });

  it("givenLinksThisWorkspaceDoesNotName_whenDerivingLinks_thenTheyAreNotShown", () => {
    const states = linkStates(
      view(
        [shared("refund-core", "api/a.proto")],
        [link("refund-core", "/repos/refund-core", true), link("someone-else", "/repos/other", true)],
      ),
    );

    expect(states.map((state) => state.name)).toEqual(["refund-core"]);
  });

  it("givenAnAbsentLink_whenDerivingLinks_thenItIsMissingAndStillCarriesSomethingToLocate", () => {
    const [state] = linkStates(view([shared("zas-spec", "api/c.proto")], [], ["zas-spec"]));

    expect(state?.missing).toBe(true);
    expect(state?.detail).toBe(MISSING_LABEL);
    expect(state?.link).toEqual({ name: "zas-spec", target: undefined, resolves: false });
  });

  it("givenALinkPointingAtNothing_whenDerivingLinks_thenTheTargetIsNamedBesideTheComplaint", () => {
    const [state] = linkStates(
      view([shared("zas-spec", "api/c.proto")], [link("zas-spec", "/gone/zas-spec", false)], ["zas-spec"]),
    );

    expect(state?.detail).toBe(`/gone/zas-spec — ${DANGLING_HINT}`);
  });

  it("givenARealDirectoryWhereALinkShouldBe_whenDerivingLinks_thenItSaysSoRatherThanShowingNoTarget", () => {
    const [state] = linkStates(view([shared("zas-spec", "api/c.proto")], [link("zas-spec", undefined, true)]));

    expect(state?.detail).toBe(NOT_A_LINK_HINT);
  });

  it("givenAHealthyLink_whenDerivingLinks_thenTheDetailIsJustWhereItPoints", () => {
    const [state] = linkStates(
      view([shared("refund-core", "api/a.proto")], [link("refund-core", "/repos/refund-core", true)]),
    );

    expect(state?.missing).toBe(false);
    expect(state?.detail).toBe("/repos/refund-core");
  });

  it("givenEverySpecFromTheOwnCheckout_whenLinkStatesAreDerived_thenTheLinkIsNotMissing", () => {
    const [state] = linkStates(
      view([fromCheckout("refund-core", "api/a.proto"), fromCheckout("refund-core", "api/b.proto")], [], [], CHECKOUT),
    );

    expect(state?.missing).toBe(false);
    // And the name is still a row: a workspace outside this repository needs the link.
    expect(state?.name).toBe("refund-core");
  });

  it("givenEverySpecFromTheOwnCheckout_whenLinkStatesAreDerived_thenTheDetailNamesTheCheckout", () => {
    const [state] = linkStates(view([fromCheckout("refund-core", "api/a.proto")], [], [], CHECKOUT));

    expect(state?.detail).toBe(`${CHECKOUT} — ${OWN_CHECKOUT_LABEL}`);
  });

  it("givenALinkHoldingTheSpecsToo_whenLinkStatesAreDerived_thenTheRowReadsAsItAlwaysDid", () => {
    // `both`: the link resolves and points at this same checkout, so the row has no news.
    const [state] = linkStates(
      view(
        [{ ...fromCheckout("refund-core", "api/a.proto"), via: "both" }],
        [link("refund-core", CHECKOUT, true)],
        [],
        CHECKOUT,
      ),
    );

    expect(state?.detail).toBe(CHECKOUT);
    expect(state?.missing).toBe(false);
  });

  it("givenSomeSpecsFromTheCheckoutAndSomeNot_whenLinkStatesAreDerived_thenTheLinkIsStillMissing", () => {
    // One spec that this branch does not have is still one spec the link has to answer for.
    const [state] = linkStates(
      view(
        [fromCheckout("refund-core", "api/a.proto"), { ...shared("refund-core", "api/gone.proto"), exists: false }],
        [],
        ["refund-core"],
        CHECKOUT,
      ),
    );

    expect(state?.missing).toBe(true);
    expect(state?.detail).toBe(MISSING_LABEL);
  });

  it("givenNoOwnCheckout_whenLinkStatesAreDerived_thenNothingChanges", () => {
    const [state] = linkStates(
      view([shared("zas-spec", "api/c.proto")], [link("zas-spec", "/repos/zas-spec", true)], [], undefined),
    );

    expect(state?.missing).toBe(false);
    expect(state?.detail).toBe("/repos/zas-spec");
  });
});

describe("spec flags", () => {
  it("givenSpecsOnAndOffLinks_whenCounting_thenOnlyTheUnlinkedOnesAreOffered", () => {
    expect(
      unlinkedCount(view([shared("refund-core", "api/a.proto"), spec("../api/b.proto"), spec("/repos/c.proto")])),
    ).toBe(2);
  });

  it("givenAConvertedSpecWhoseLinkNobodyMade_whenFlagging_thenItIsBothMissingAndLinked", () => {
    expect(specFlags(shared("zas-spec", "api/c.proto"))).toEqual({ missing: false, unlinked: false });
    expect(specFlags({ ...shared("zas-spec", "api/c.proto"), exists: false })).toEqual({
      missing: true,
      unlinked: false,
    });
    expect(specFlags(spec("../api/b.proto", { exists: false }))).toEqual({ missing: true, unlinked: true });
  });
});

describe("plan review", () => {
  it("givenAPlanHoldingDuplicates_whenCountingWrites_thenOnlyTheOnesThatChangeTheFile", () => {
    const staged = plan([
      { source: "/repos/a.proto", declared: `${SHARED}/r/a.proto`, link: "r", duplicate: false },
      { source: "/repos/b.proto", declared: `${SHARED}/r/b.proto`, link: "r", duplicate: true },
    ]);

    expect(plannedWrites(staged)).toBe(1);
    expect(staged.entries).toHaveLength(2);
  });

  it("givenASpecNotOnThisMachine_whenCountingWrites_thenItIsShownButNotCounted", () => {
    // No file means no repository to name a link after, so core plans it with no link at all.
    // The row still has to appear: on a workspace someone else authored, those rows are the
    // answer to why half the methods are missing.
    const staged = plan([
      { source: "/repos/a.proto", declared: `${SHARED}/r/a.proto`, link: "r", duplicate: false },
      {
        source: "/Users/nobody/b.proto",
        declared: "/Users/nobody/b.proto",
        link: undefined,
        duplicate: false,
        loadError: "/Users/nobody/b.proto does not exist",
      },
    ]);

    expect(plannedWrites(staged)).toBe(1);
    expect(staged.entries).toHaveLength(2);
    expect(writes(staged.entries[1] as PlannedSpec)).toBe(false);
  });

  it("givenAConflict_whenReviewing_thenApplyIsBlockedUntilItIsDecided", () => {
    expect(planBlocked(plan([], ["acquiring-core"]))).toBe(true);
    expect(planBlocked(plan([]))).toBe(false);
  });
});

describe("freeName", () => {
  it("givenATakenName_whenOfferingAnother_thenItStartsAtTwo", () => {
    expect(freeName("acquiring-core", takenNames([link("acquiring-core", "/repos/one", true)]))).toBe(
      "acquiring-core-2",
    );
  });

  it("givenTheOfferAlsoTaken_whenOfferingAnother_thenItWalksPastEveryHeldName", () => {
    const held = takenNames([
      link("acquiring-core", "/a", true),
      link("acquiring-core-2", "/b", true),
      link("acquiring-core-3", "/c", true),
    ]);

    expect(freeName("acquiring-core", held)).toBe("acquiring-core-4");
  });

  it("givenNothingTaken_whenOfferingAnother_thenItStillSuffixes", () => {
    expect(freeName("acquiring-core", new Set())).toBe("acquiring-core-2");
  });
});
