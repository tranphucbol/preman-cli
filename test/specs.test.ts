import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySpecPlan,
  collectProtoFiles,
  describeSpecs,
  planSpecConversion,
  planSpecs,
  removeSpec,
} from "@preman/core/api/specs.js";
import { ProtoCache } from "@preman/core/api/protos.js";
import { DEFAULT_SHARED_PROTO_ROOT, SHARED_PROTO_ROOT_ENV } from "@preman/core/workspace/links.js";
import { cloneFixtureWorkspace, type ClonedWorkspace } from "./helpers.js";

/**
 * A checkout whose protos import each other package-qualified — the shape that fails
 * to load when a spec is declared as a bare absolute path, because the walk that
 * produces include dirs has nowhere to stop.
 */
function makeRepo(name: string): string {
  const root = join(mkdtempSync(join(tmpdir(), "preman-repo-")), name);
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "api/zas/admin"), { recursive: true });

  writeFileSync(
    join(root, "api/zas/common.proto"),
    'syntax = "proto3";\npackage zas;\nmessage Common { string id = 1; }\n',
  );
  writeFileSync(
    join(root, "api/zas/admin/admin.proto"),
    [
      'syntax = "proto3";',
      "package zas.admin;",
      'import "zas/common.proto";',
      "message GetRequest { string id = 1; }",
      "service AdminService { rpc Get(GetRequest) returns (zas.Common); }",
      "",
    ].join("\n"),
  );
  return root;
}

const ADMIN_REL = "api/zas/admin/admin.proto";

/**
 * A checkout whose service imports a bare `common.proto` sitting beside it, and whose
 * `common.proto` names one type nobody else has. Two of these declared together are the
 * shape that caught a pooled include-dir list answering one repository's import with
 * another's file.
 */
function makeSiblingImportRepo(name: string, type: string): string {
  const root = join(mkdtempSync(join(tmpdir(), "preman-repo-")), name);
  mkdirSync(join(root, "protos"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });

  writeFileSync(
    join(root, "protos/common.proto"),
    `syntax = "proto3";\npackage shared;\nmessage ${type} { string id = 1; }\n`,
  );
  writeFileSync(
    join(root, `protos/${name}.proto`),
    [
      'syntax = "proto3";',
      `package ${name};`,
      'import "common.proto";',
      `service ${type}Service { rpc Call(shared.${type}) returns (shared.${type}); }`,
      "",
    ].join("\n"),
  );
  return root;
}

const SIBLING_REL = (name: string): string => `protos/${name}.proto`;

describe("specs", () => {
  let ws: ClonedWorkspace;
  let shared: string;
  let repo: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    ws = cloneFixtureWorkspace();
    shared = mkdtempSync(join(tmpdir(), "preman-shared-"));
    repo = makeRepo("zas-spec");
    previousRoot = process.env[SHARED_PROTO_ROOT_ENV];
    process.env[SHARED_PROTO_ROOT_ENV] = shared;
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env[SHARED_PROTO_ROOT_ENV];
    else process.env[SHARED_PROTO_ROOT_ENV] = previousRoot;
    ws.cleanup();
    rmSync(shared, { recursive: true, force: true });
    rmSync(dirname(repo), { recursive: true, force: true });
  });

  it("givenAProtoInAnotherCheckout_whenPlanning_thenItIsDeclaredThroughACanonicalSharedPath", () => {
    const plan = planSpecs(ws.root, [join(repo, ADMIN_REL)]);

    expect(plan.links).toEqual([{ name: "zas-spec", target: repo, action: "create" }]);
    expect(plan.conflicts).toEqual([]);
    // Written with the default root even though this machine has overridden it: the
    // declaration has to mean the same thing on the next machine.
    expect(plan.entries[0]?.declared).toBe(`${DEFAULT_SHARED_PROTO_ROOT}/zas-spec/${ADMIN_REL}`);
    expect(plan.entries[0]?.loadError).toBeUndefined();
  });

  it("givenAPlan_whenApplied_thenTheLinkIsCreatedAndTheMethodIsIndexed", () => {
    applySpecPlan(ws.root, planSpecs(ws.root, [join(repo, ADMIN_REL)]));

    const link = join(shared, "zas-spec");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(repo);

    // The payoff: a package-qualified import resolves, so the method reaches the picker.
    const index = new ProtoCache(ws.root).index();
    expect(index.warnings).toEqual([]);
    expect(index.methods.map((m) => m.methodPath)).toContain("zas.admin.AdminService.Get");
  });

  it("givenTwoCheckoutsWithTheirOwnCommonProto_whenIndexed_thenNeitherAnswersTheOthersImport", () => {
    // Both live under `protos/`, so the pooled list sorts them together and whichever
    // sorts first would answer both bare imports. A proto has to see its own tree first.
    const alpha = makeSiblingImportRepo("alpha", "Ping");
    const beta = makeSiblingImportRepo("beta", "Blip");
    try {
      applySpecPlan(ws.root, planSpecs(ws.root, [join(alpha, SIBLING_REL("alpha")), join(beta, SIBLING_REL("beta"))]));

      const index = new ProtoCache(ws.root).index();
      expect(index.warnings).toEqual([]);
      expect(index.methods.map((m) => m.methodPath)).toEqual(
        expect.arrayContaining(["alpha.PingService.Call", "beta.BlipService.Call"]),
      );
    } finally {
      rmSync(dirname(alpha), { recursive: true, force: true });
      rmSync(dirname(beta), { recursive: true, force: true });
    }
  });

  it("givenACommentAndAnUnreadKey_whenApplying_thenBothSurvive", () => {
    const resources = join(ws.root, ".postman/resources.yaml");
    writeFileSync(
      resources,
      [
        "# hand-written, and expected to stay that way",
        "workspace:",
        "  id: 11111111-2222-3333-4444-555555555555",
        "resourceNameMappings:",
        "  specs:",
        "    ../src/main/proto/echo/echo.proto: Echo",
        "localResources:",
        "  specs:",
        "    - ../src/main/proto/echo/echo.proto",
        "",
      ].join("\n"),
    );

    applySpecPlan(ws.root, planSpecs(ws.root, [join(repo, ADMIN_REL)]));

    const written = readFileSync(resources, "utf8");
    expect(written).toContain("# hand-written, and expected to stay that way");
    expect(written).toContain("resourceNameMappings:");
    expect(written).toContain("../src/main/proto/echo/echo.proto");
    expect(written).toContain(`${DEFAULT_SHARED_PROTO_ROOT}/zas-spec/${ADMIN_REL}`);
  });

  it("givenTheNameIsTakenByAnotherCheckout_whenPlanning_thenItIsAConflictAndApplyRefuses", () => {
    const other = makeRepo("zas-spec");
    applySpecPlan(ws.root, planSpecs(ws.root, [join(other, ADMIN_REL)]));

    const plan = planSpecs(ws.root, [join(repo, ADMIN_REL)]);
    expect(plan.conflicts).toEqual(["zas-spec"]);
    expect(() => applySpecPlan(ws.root, plan)).toThrow(/conflict/);

    rmSync(dirname(other), { recursive: true, force: true });
  });

  it("givenAConflictAndAnAlternativeName_whenPlanning_thenBothCheckoutsAreLinked", () => {
    const other = makeRepo("zas-spec");
    applySpecPlan(ws.root, planSpecs(ws.root, [join(other, ADMIN_REL)]));

    const plan = planSpecs(ws.root, [join(repo, ADMIN_REL)], {
      overrides: { "zas-spec": { name: "zas-spec-2" } },
    });
    expect(plan.conflicts).toEqual([]);
    applySpecPlan(ws.root, plan);

    expect(readlinkSync(join(shared, "zas-spec"))).toBe(other);
    expect(readlinkSync(join(shared, "zas-spec-2"))).toBe(repo);

    rmSync(dirname(other), { recursive: true, force: true });
  });

  it("givenSpecsDeclaredRelatively_whenPlanningConversion_thenEachMovesOntoALink", () => {
    const plan = planSpecConversion(ws.root);

    // The fixture declares two protos inside its own tree; both are unportable today.
    expect(plan.entries).toHaveLength(2);
    for (const entry of plan.entries) {
      expect(entry.replaces).toMatch(/^\.\.\/src\/main\/proto\/echo\//);
      expect(entry.declared.startsWith(DEFAULT_SHARED_PROTO_ROOT)).toBe(true);
    }

    applySpecPlan(ws.root, plan);
    const view = describeSpecs(ws.root);
    expect(view.specs.every((spec) => spec.link !== undefined)).toBe(true);
    expect(view.specs).toHaveLength(2);
  });

  it("givenASpecOnAnotherPersonsMachine_whenPlanningConversion_thenNoLinkIsInventedForIt", () => {
    // The workspace that drove this feature declares thirteen specs under a colleague's home
    // directory. Nothing there resolves, so `repoRootFor` finds no `.git` and would otherwise
    // fall back to the file's own directory — naming a link `user` after `.../proto/user/`.
    const absent = "/Users/nobody/repos/asset-exchange-v2/src/main/proto/user/user-profile.proto";
    writeFileSync(
      join(ws.root, ".postman", "resources.yaml"),
      `workspace:\n  id: x\nlocalResources:\n  specs:\n    - ${absent}\n`,
    );

    const plan = planSpecConversion(ws.root);

    expect(plan.links).toHaveLength(0);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.link).toBeUndefined();
    expect(plan.entries[0]?.loadError).toContain("does not exist");
  });

  it("givenAPlanWithAnAbsentSpec_whenApplied_thenItsDeclarationIsLeftExactlyAsWritten", () => {
    const absent = "/Users/nobody/repos/zas-spec/api/zas/admin/hotspot.proto";
    writeFileSync(
      join(ws.root, ".postman", "resources.yaml"),
      `workspace:\n  id: x\nlocalResources:\n  specs:\n    - ${absent}\n`,
    );

    applySpecPlan(ws.root, planSpecConversion(ws.root));

    // Untouched rather than dropped: preman cannot tell a stale path from one whose checkout is
    // simply not cloned yet, and deleting someone's declaration is not a guess worth making.
    expect(describeSpecs(ws.root).specs.map((spec) => spec.declared)).toEqual([absent]);
    expect(readdirSync(shared)).toHaveLength(0);
  });

  it("givenALinkThisMachineLacks_whenDescribing_thenItIsReportedOnceForEverySpecUnderIt", () => {
    applySpecPlan(ws.root, planSpecs(ws.root, [join(repo, ADMIN_REL), join(repo, "api/zas/common.proto")]));
    rmSync(join(shared, "zas-spec"));

    const view = describeSpecs(ws.root);
    expect(view.unresolvedLinks).toEqual(["zas-spec"]);
    expect(view.specs.filter((spec) => !spec.exists)).toHaveLength(2);
  });

  it("givenASpecIsRemoved_whenDescribing_thenTheLinkIsLeftAlone", () => {
    const view = applySpecPlan(ws.root, planSpecs(ws.root, [join(repo, ADMIN_REL)]));
    const added = view.specs.find((spec) => spec.link === "zas-spec");

    const after = removeSpec(ws.root, added?.declared ?? "");
    expect(after.specs.some((spec) => spec.link === "zas-spec")).toBe(false);
    // Another workspace may still declare through it, so undeclaring never unlinks.
    expect(existsSync(join(shared, "zas-spec"))).toBe(true);
  });

  /**
   * The fresh-clone machine, reproduced without touching `/Users/Shared`: a workspace that is
   * itself a checkout, declaring its own protos the canonical way, on a machine whose shared root
   * is an empty directory. That is every teammate who clones the repository ADR 042 was written
   * for, and before it every one of its declarations was a path to nothing.
   */
  describe("the workspace's own checkout", () => {
    const ECHO_REL = "src/main/proto/echo/echo.proto";
    const COMMON_REL = "src/main/proto/echo/common.proto";

    /** Declares the clone's own protos through `name`, and marks the clone as a checkout. */
    function declareThroughLink(name: string): void {
      mkdirSync(join(ws.root, ".git"), { recursive: true });
      writeFileSync(
        join(ws.root, ".postman/resources.yaml"),
        [
          "workspace:",
          "  id: 11111111-2222-3333-4444-555555555555",
          "localResources:",
          "  specs:",
          `    - ${DEFAULT_SHARED_PROTO_ROOT}/${name}/${ECHO_REL}`,
          `    - ${DEFAULT_SHARED_PROTO_ROOT}/${name}/${COMMON_REL}`,
          "",
        ].join("\n"),
      );
    }

    /** The name a link to this clone would take, which is the name its declarations use. */
    function ownName(): string {
      return basename(ws.root);
    }

    it("givenAClonedWorkspaceWithNoLinks_whenDescribed_thenItsOwnSpecsResolve", () => {
      declareThroughLink(ownName());

      const view = describeSpecs(ws.root);

      expect(readdirSync(shared)).toHaveLength(0);
      expect(view.ownCheckout).toBe(ws.root);
      expect(view.specs.map((spec) => spec.path)).toEqual([join(ws.root, ECHO_REL), join(ws.root, COMMON_REL)]);
      expect(view.specs.every((spec) => spec.exists)).toBe(true);
      // The payoff, and the thing 24 red rows in the pane were standing in the way of.
      expect(new ProtoCache(ws.root).index().methods.map((m) => m.methodPath)).toContain("test.echo.EchoService.Echo");
    });

    it("givenAClonedWorkspaceWithNoLinks_whenDescribed_thenTheLinkIsNotUnresolved", () => {
      declareThroughLink(ownName());

      const view = describeSpecs(ws.root);

      expect(view.unresolvedLinks).toEqual([]);
      // Still named, though: a workspace outside this repository needs the link this one does not.
      expect(view.specs.every((spec) => spec.link === ownName())).toBe(true);
    });

    it("givenAClonedWorkspaceWithNoLinks_whenDescribed_thenTheSpecsSayTheyCameFromTheCheckout", () => {
      declareThroughLink(ownName());

      expect(describeSpecs(ws.root).specs.map((spec) => spec.via)).toEqual(["own-checkout", "own-checkout"]);
    });

    it("givenALinkPointingAtThisVeryCheckout_whenDescribed_thenTheRowsSayNothingNew", () => {
      // The machine the link was made on, which is every machine that already worked. Which root
      // answered is a distinction with no difference there, and 24 rows saying so is noise.
      declareThroughLink(ownName());
      symlinkSync(ws.root, join(shared, ownName()), "dir");

      const view = describeSpecs(ws.root);

      expect(view.specs.map((spec) => spec.via)).toEqual(["both", "both"]);
      expect(view.unresolvedLinks).toEqual([]);
    });

    it("givenARenamedClone_whenDescribed_thenTheLinkIsStillUnresolved", () => {
      // Decision 4 is exact. A clone whose directory was renamed gets nothing automatic, because
      // `LinkOverride.name` makes name-equals-basename a default rather than an invariant.
      declareThroughLink(`${ownName()}-fix`);

      const view = describeSpecs(ws.root);

      expect(view.unresolvedLinks).toEqual([`${ownName()}-fix`]);
      expect(view.specs.map((spec) => spec.via)).toEqual(["link", "link"]);
      expect(view.specs.some((spec) => spec.exists)).toBe(false);
    });

    it("givenALinkAndACheckoutBothHoldingTheFile_whenDescribed_thenTheCheckoutIsUsed", () => {
      // A repoint is overridden on purpose: were the link to win, this clone's protos would
      // depend on machine-wide state it cannot see, and an edit on this branch would go unread.
      const other = cloneFixtureWorkspace();
      try {
        declareThroughLink(ownName());
        symlinkSync(other.root, join(shared, ownName()), "dir");

        const view = describeSpecs(ws.root);

        expect(view.specs.map((spec) => spec.path)).toEqual([join(ws.root, ECHO_REL), join(ws.root, COMMON_REL)]);
        // Both roots hold it, so the row says nothing: `both` is read by the front ends as
        // "no news", and the news here would be about a repoint no one is being asked to repair.
        expect(view.specs.map((spec) => spec.via)).toEqual(["both", "both"]);
      } finally {
        other.cleanup();
      }
    });

    it("givenAFileOnlyUnderTheLink_whenDescribed_thenTheLinkIsUsed", () => {
      // The escape hatch that makes trying the checkout first safe: a spec deleted on this
      // branch, or one that never was here, resolves exactly the way it does today.
      const other = cloneFixtureWorkspace();
      try {
        declareThroughLink(ownName());
        rmSync(join(ws.root, ECHO_REL));
        symlinkSync(other.root, join(shared, ownName()), "dir");

        const view = describeSpecs(ws.root);

        expect(view.specs[0]?.path).toBe(join(shared, ownName(), ECHO_REL));
        expect(view.specs[0]?.via).toBe("link");
        expect(view.specs[0]?.exists).toBe(true);
        // The second one is still there, so it still comes from the checkout - and the link has
        // it too, which is what keeps it out of the front ends' "read from your own checkout".
        expect(view.specs[1]?.via).toBe("both");
      } finally {
        other.cleanup();
      }
    });

    it("givenASpecFromAnotherRepository_whenDescribed_thenNothingChanges", () => {
      mkdirSync(join(ws.root, ".git"), { recursive: true });
      applySpecPlan(ws.root, planSpecs(ws.root, [join(repo, ADMIN_REL)]));

      const view = describeSpecs(ws.root);
      const added = view.specs.find((spec) => spec.link === "zas-spec");

      expect(added?.via).toBe("link");
      expect(added?.path).toBe(join(shared, "zas-spec", ADMIN_REL));
      expect(view.unresolvedLinks).toEqual([]);
    });
  });

  it("givenAFolder_whenCollecting_thenEveryProtoUnderItIsFoundAndGitIsSkipped", () => {
    writeFileSync(join(repo, ".git/ignored.proto"), 'syntax = "proto3";\n');

    expect(collectProtoFiles(repo)).toEqual([join(repo, ADMIN_REL), join(repo, "api/zas/common.proto")]);
  });
});
