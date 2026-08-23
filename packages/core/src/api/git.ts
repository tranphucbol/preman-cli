/**
 * What git thinks of the workspace, for decorating a tree.
 *
 * `git status --porcelain=v1 -z` and nothing else. No libgit2, no git library: the
 * porcelain format is stable by contract, the parse is thirty lines, and a native
 * dependency would be the largest thing in this repo for one column of dots.
 *
 * This is the only place in core that shells out. It is also the only place that can
 * usefully answer "is this request modified", which is the question a reviewer asks
 * before sending something.
 */
import { execFile } from "node:child_process";

const GIT = "git";
/**
 * `-b` for the branch header, `-uall` so untracked files are listed individually rather
 * than collapsed into their directory: a directory row cannot tell you which request is
 * new. `-z` because a Postman workspace has spaces in almost every filename.
 */
const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "-b", "-uall"];
/** Enough for a large repository's status, and a bound on what a hung git can hand back. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 5_000;
const NUL = "\0";
/** Porcelain v1 is two status codes, a space, then the path. */
const PATH_START = 3;
const BRANCH_PREFIX = "## ";
/** `## main...origin/main [ahead 1]` — everything from the first of these is not the name. */
const BRANCH_DECORATION = /(\.\.\.| \[).*$/;
/** What porcelain v1 writes in place of a branch name when HEAD is detached. */
const DETACHED_HEAD = "HEAD (no branch)";
const RENAME_CODES = new Set(["R", "C"]);
const UNTRACKED_CODE = "?";
const IGNORED_CODE = "!";
const UNMERGED_CODE = "U";
const ADDED_CODE = "A";
const DELETED_CODE = "D";

/**
 * What happened to one path, collapsed to what a row can show.
 *
 * Both porcelain columns are folded into one word on purpose. A tree decoration has room
 * for one mark, and "staged modification with an unstaged modification on top" is a
 * distinction the app cannot draw and the user reads in `git diff` anyway.
 */
export type GitFileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface GitStatus {
  /** False when the workspace is not in a work tree, or git is not installed. */
  repository: boolean;
  /** The current branch, `HEAD (no branch)` when detached, `null` when there is no repo. */
  branch: string | null;
  /** Workspace-relative posix paths to status. Paths outside the workspace are dropped. */
  files: Record<string, GitFileStatus>;
  /** Why the status is empty, when it is empty for a reason worth saying. */
  warning?: string;
}

const NO_REPOSITORY: GitStatus = { repository: false, branch: null, files: {} };

/**
 * Fold the two porcelain columns into one word.
 *
 * Order matters and is by severity, not by column: a conflict outranks everything, and a
 * working-tree deletion outranks the staged add that preceded it. The worktree column is
 * read before the index column because it describes the bytes on disk, which is what the
 * user is looking at.
 */
function statusOf(index: string, worktree: string): GitFileStatus {
  if (index === UNMERGED_CODE || worktree === UNMERGED_CODE || (index === ADDED_CODE && worktree === ADDED_CODE)) {
    return "conflicted";
  }
  if (index === UNTRACKED_CODE || worktree === UNTRACKED_CODE) return "untracked";
  if (worktree === DELETED_CODE || index === DELETED_CODE) return "deleted";
  if (RENAME_CODES.has(index)) return "renamed";
  if (index === ADDED_CODE) return "added";
  return "modified";
}

/**
 * Split the `-z` stream.
 *
 * A rename entry spends two NUL-terminated records — new path then old path — so the
 * reader has to consume the second or it reads the old path as its own entry with the
 * next entry's status codes. This is the one part of the format that punishes a naive
 * split, hence the index-based loop.
 */
function parse(prefix: string, output: string): GitStatus {
  const records = output.split(NUL);
  let branch: string | null = null;
  const files: Record<string, GitFileStatus> = {};

  for (let at = 0; at < records.length; at += 1) {
    const record = records[at]!;
    if (record.length === 0) continue;

    if (record.startsWith(BRANCH_PREFIX)) {
      const named = record.slice(BRANCH_PREFIX.length);
      branch = named.startsWith(DETACHED_HEAD) ? DETACHED_HEAD : named.replace(BRANCH_DECORATION, "");
      continue;
    }
    if (record.length < PATH_START) continue;

    const index = record[0]!;
    const worktree = record[1]!;
    if (index === IGNORED_CODE) continue;

    const path = record.slice(PATH_START);
    // The old path of a rename or copy, which describes the same row.
    if (RENAME_CODES.has(index) || RENAME_CODES.has(worktree)) at += 1;

    // Paths outside the workspace are dropped rather than carried with a `..` no node id
    // could ever match: a monorepo's status covers every service, and this tree is one.
    if (path.startsWith(prefix)) files[path.slice(prefix.length)] = statusOf(index, worktree);
  }

  return { repository: true, branch, files };
}

/** Run one git command from `root`, answering `undefined` when git or the repository is missing. */
function run(root: string, args: string[]): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(
      GIT,
      ["-C", root, ...args],
      { maxBuffer: MAX_OUTPUT_BYTES, timeout: TIMEOUT_MS, encoding: "utf8" },
      (error, stdout) => {
        done(error === null ? stdout : undefined);
      },
    );
  });
}

/**
 * The git status of a workspace, keyed by workspace-relative posix path.
 *
 * Two commands, because porcelain paths are relative to the *repository* root and node
 * ids are relative to the workspace. `rev-parse --show-prefix` is git's own answer for
 * the distance between the two — a workspace that is one service in a monorepo gets
 * `services/refund/`, one at the top of its repository gets the empty string — so the
 * rebase is a prefix strip rather than path arithmetic that has to guess the separator.
 *
 * Not being in a repository is not a failure. Most workspaces are in one, but a tool
 * that refused to open a directory that is not would be absurd, so the answer is
 * `repository: false` and every row simply goes undecorated.
 */
export async function readGitStatus(root: string): Promise<GitStatus> {
  const prefix = await run(root, ["rev-parse", "--show-prefix"]);
  if (prefix === undefined) return { ...NO_REPOSITORY, warning: "not a git repository" };

  const output = await run(root, STATUS_ARGS);
  if (output === undefined) return { ...NO_REPOSITORY, warning: "git status failed" };
  return parse(prefix.trim(), output);
}
