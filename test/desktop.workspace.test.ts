/**
 * Creating a workspace: where it lands, what is in it, and what it refuses.
 *
 * Every case runs against a temporary home, because the location under test is a home-relative
 * path and a suite that got that wrong would litter the machine it ran on.
 *
 * The interesting properties are the two that are easy to lose later. The result contains
 * directories and nothing else — a sample collection added out of helpfulness has to fail a test,
 * not pass one — and an existing target is reported rather than adopted, suffixed or repaired,
 * which is why the root is made with an exclusive `mkdir` and not a check followed by one.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findWorkspace } from "@preman/core/workspace/discover.js";
import { createWorkspace } from "@preman/desktop/main/workspaces.js";

/** The exact location decision 1 fixes. Spelled out here rather than imported, so the test would
 * fail if the helper's own constants moved. */
const PARENT_RELATIVE = join(".local", "share", "preman", "workspace");
const NAME = "payments";
const ENCODING = "utf8";
const ONE_ENTRY = 1;
const CONCURRENT_ATTEMPTS = 4;
const ONE_SUCCESS = 1;

const homes: string[] = [];

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "preman-home-"));
  homes.push(dir);
  return dir;
}

function parentOf(homeDir: string): string {
  return join(homeDir, PARENT_RELATIVE);
}

function entries(dir: string): string[] {
  return readdirSync(dir).sort();
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("desktop workspace creation", () => {
  it("givenAValidName_whenWorkspaceIsCreated_thenItUsesTheExactDefaultParent", async () => {
    const homeDir = home();

    const result = await createWorkspace(homeDir, NAME);

    const root = join(parentOf(homeDir), NAME);
    expect(result).toEqual({ ok: true, root });
    // Openable by core's own rules, not merely present on disk.
    expect(findWorkspace(root)?.root).toBe(root);
  });

  it("givenAValidName_whenWorkspaceIsCreated_thenOnlyTheCollectionsHierarchyExists", async () => {
    const homeDir = home();

    const result = await createWorkspace(homeDir, NAME);
    expect(result.ok).toBe(true);

    const root = join(parentOf(homeDir), NAME);
    // Directory entries, not `findWorkspace`: a sample request or a `.postman` written out of
    // helpfulness would still be a discoverable workspace, and it is not what was asked for.
    expect(entries(root)).toEqual(["postman"]);
    expect(entries(join(root, "postman"))).toEqual(["collections"]);
    expect(entries(join(root, "postman", "collections"))).toEqual([]);
  });

  it("givenWhitespaceAroundAName_whenWorkspaceIsCreated_thenItUsesTheTrimmedName", async () => {
    const homeDir = home();

    const result = await createWorkspace(homeDir, `  ${NAME}\t\n`);

    expect(result).toEqual({ ok: true, root: join(parentOf(homeDir), NAME) });
    expect(entries(parentOf(homeDir))).toEqual([NAME]);
  });

  it("givenAnEmptyOrUnsafeName_whenWorkspaceIsCreated_thenItIsRejectedWithoutCreatingTheParent", async () => {
    const homeDir = home();
    const unusable = ["", "   ", ".", "..", "a/b", "a\\b", "with\u0000nul", "bell\u0007"];

    for (const name of unusable) {
      const result = await createWorkspace(homeDir, name);
      expect(result.ok, name).toBe(false);
    }

    // Not even the default parent: a refused name has no file system side effect at all.
    expect(entries(homeDir)).toEqual([]);
  });

  it("givenAnExistingTarget_whenWorkspaceIsCreated_thenItsContentsAreUntouched", async () => {
    const homeDir = home();
    const root = join(parentOf(homeDir), NAME);
    mkdirSync(root, { recursive: true });
    const kept = join(root, "notes.txt");
    writeFileSync(kept, "mine", ENCODING);

    const result = await createWorkspace(homeDir, NAME);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(root);
    // Left exactly as it was: no `postman/`, no suffixed sibling, nothing removed.
    expect(entries(root)).toEqual(["notes.txt"]);
    expect(entries(parentOf(homeDir))).toEqual([NAME]);
  });

  it("givenConcurrentAttemptsForOneName_whenWorkspaceIsCreated_thenExactlyOneSucceeds", async () => {
    const homeDir = home();

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_ATTEMPTS }, () => createWorkspace(homeDir, NAME)),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(ONE_SUCCESS);
    expect(entries(parentOf(homeDir))).toHaveLength(ONE_ENTRY);
  });
});
