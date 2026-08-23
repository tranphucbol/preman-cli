import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCatalog } from "@preman/core/api/catalog.js";
import { readGitStatus } from "@preman/core/api/git.js";
import { grepWorkspace } from "@preman/core/api/grep.js";
import { cloneFixtureWorkspace, FIXTURE_WS, requestPath, type ClonedWorkspace } from "./helpers.js";

const ECHO_NODE = "postman/collections/payment/Echo.request.yaml";

let clone: ClonedWorkspace | undefined;

afterEach(() => {
  clone?.cleanup();
  clone = undefined;
});

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

/** A repository around a clone, so a status has something to report. */
function repository(): ClonedWorkspace {
  const made = cloneFixtureWorkspace();
  git(made.root, "init", "-q");
  git(made.root, "config", "user.email", "test@preman.invalid");
  git(made.root, "config", "user.name", "preman test");
  git(made.root, "add", "-A");
  git(made.root, "commit", "-qm", "fixture");
  return made;
}

describe("grep", () => {
  it("givenQuery_whenGrep_thenResultsCarryFieldPath", async () => {
    const catalog = await buildCatalog(FIXTURE_WS);

    const found = grepWorkspace(catalog, "methodPath");

    const echo = found.matches.find((match) => match.nodeId === ECHO_NODE);
    expect(echo).toBeDefined();
    // A key hit means "this field exists here", which is what makes a result clickable:
    // the path is what the editor opens on, not the line number.
    expect(echo?.fieldPath).toEqual(["methodPath"]);
    expect(echo?.where).toBe("key");
    expect(echo?.preview).toContain("methodPath");
  });

  it("givenMatchInsideBlockScalar_whenGrep_thenTheLineIsTheOneInsideTheBlock", async () => {
    const catalog = await buildCatalog(FIXTURE_WS);

    const found = grepWorkspace(catalog, "pm.environment.set");

    const match = found.matches.find((candidate) => candidate.nodeId === ECHO_NODE);
    expect(match?.fieldPath).toEqual(["scripts", 0, "code"]);
    // The sequence index is carried, because a field path without one cannot address the
    // first of two scripts.
    const text = readFileSync(requestPath("Echo.request.yaml"), "utf8").split("\n");
    expect(text[(match?.line ?? 1) - 1]).toContain("pm.environment.set");
  });

  it("givenQueryMatchingNothing_whenGrep_thenNoMatchesAndNoWarnings", async () => {
    const catalog = await buildCatalog(FIXTURE_WS);
    const found = grepWorkspace(catalog, "there-is-no-such-string-here");
    expect(found).toEqual({ matches: [], truncated: false, warnings: [] });
  });

  it("givenLimit_whenMoreMatchesExist_thenResultIsTruncated", async () => {
    const catalog = await buildCatalog(FIXTURE_WS);

    const found = grepWorkspace(catalog, "name", { limit: 2 });

    expect(found.matches).toHaveLength(2);
    expect(found.truncated).toBe(true);
  });

  it("givenBase64Descriptor_whenGrep_thenItIsNotSearched", async () => {
    const catalog = await buildCatalog(FIXTURE_WS);
    const descriptor = readFileSync(requestPath("Descriptor Only.request.yaml"), "utf8");
    // A slice of the blob that is genuinely in the file, so the only reason not to find
    // it is the exclusion.
    const inside = /methodDescriptor:\s*(\S{40})/.exec(descriptor)?.[1];
    expect(inside).toBeDefined();

    const found = grepWorkspace(catalog, inside!);

    expect(found.matches).toEqual([]);
  });
});

describe("git status", () => {
  it("givenModifiedRequestFile_whenGitStatus_thenRowIsDecorated", async () => {
    clone = repository();
    const file = join(clone.root, ECHO_NODE);
    writeFileSync(file, `${readFileSync(file, "utf8")}\n# touched\n`);

    const status = await readGitStatus(clone.root);

    expect(status.repository).toBe(true);
    expect(status.branch).not.toBeNull();
    // Keyed by node id, which is the whole point: the sidebar decorates by row without
    // knowing where the repository root is.
    expect(status.files[ECHO_NODE]).toBe("modified");
  });

  it("givenUntrackedAndDeletedFiles_whenGitStatus_thenBothAreReported", async () => {
    clone = repository();
    const added = "postman/collections/payment/Fresh.request.yaml";
    writeFileSync(join(clone.root, added), "$kind: http-request\nname: Fresh\nurl: http://x\n");
    rmSync(join(clone.root, "postman/collections/payment/Ping.request.yaml"));

    const status = await readGitStatus(clone.root);

    expect(status.files[added]).toBe("untracked");
    expect(status.files["postman/collections/payment/Ping.request.yaml"]).toBe("deleted");
  });

  it("givenCleanRepository_whenGitStatus_thenNothingIsDecorated", async () => {
    clone = repository();
    const status = await readGitStatus(clone.root);
    expect(status.repository).toBe(true);
    expect(status.files).toEqual({});
  });

  it("givenDirectoryOutsideAnyRepository_whenGitStatus_thenNoRepositoryIsReported", async () => {
    clone = cloneFixtureWorkspace();

    const status = await readGitStatus(clone.root);

    // Refusing to open a workspace that is not in a repository would be absurd, so the
    // answer is "no repository" and every row goes undecorated.
    expect(status).toMatchObject({ repository: false, branch: null, files: {} });
  });
});
