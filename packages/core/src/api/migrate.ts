import { EXIT, PremanError } from "@preman/core/errors.js";
import { planWorkspace } from "@preman/core/postman/convert.js";
import { fetchCloudWorkspace, fetchWorkspaceList } from "@preman/core/postman/fetch.js";
import { migrationProgress } from "@preman/core/postman/progress.js";
import { postmanProxy } from "@preman/core/postman/proxy.js";
import { harvestToken } from "@preman/core/postman/session.js";
import { applyPlan } from "@preman/core/postman/write.js";
import type { CloudWorkspace } from "@preman/core/postman/model.js";
import type { SkippedItem } from "@preman/core/postman/plan.js";
import type { MigrationReporter, ProgressTracker } from "@preman/core/postman/progress.js";
import type { ProxyClient } from "@preman/core/postman/proxy.js";

/**
 * The interface-agnostic seam for acquiring a workspace, beside the seams for running and
 * inspecting one.
 *
 * Both front ends need the same three steps in the same order — harvest a token, fetch, write —
 * so the order lives here rather than twice (ADR 033). A terminal or a window contributes the
 * destination and the reporting, nothing else.
 */

/** Postman workspace ids are UUIDs; anything else the user typed is a name. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MigrationOutcome {
  /** Where the workspace was written, or would have been under `dryRun`. */
  readonly root: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly dryRun: boolean;
  /** Keyed by kind: `collection`, `folder`, `environment`, `grpc-request`, `http-request`. */
  readonly counts: Readonly<Record<string, number>>;
  /** What Postman had and preman cannot represent, named so the report can list it. */
  readonly skipped: readonly SkippedItem[];
  /** Every path the plan holds, relative and posix, so `--dry-run` has something to print. */
  readonly files: readonly string[];
}

export interface MigrateArgs {
  /**
   * Postman Desktop's application-data directory, holding `DevToolsActivePort`. A parameter
   * rather than a `homedir()` call inside, so a test never reaches the real one.
   */
  readonly postmanAppData: string;
  /** A cloud workspace UUID, or its name. A name matching two workspaces is an error. */
  readonly workspace: string;
  readonly target: string;
  readonly dryRun: boolean;
  /**
   * Called as the migration moves, for a caller that has somewhere to draw it. Omitted by a
   * caller that only wants the outcome; `postman/progress.ts` says what can honestly be reported
   * and why the collection is the unit.
   */
  readonly onProgress?: MigrationReporter;
}

async function connect(postmanAppData: string): Promise<ProxyClient> {
  return postmanProxy(await harvestToken(postmanAppData));
}

/**
 * Turn what the user typed into an id.
 *
 * A UUID is taken at its word and costs no call: a wrong one fails at the workspace fetch with
 * Postman's own `instanceNotFoundError`, which says more than a local "not found" would.
 */
async function resolveWorkspaceId(proxy: ProxyClient, wanted: string): Promise<string> {
  if (UUID.test(wanted)) return wanted;

  const all = await fetchWorkspaceList(proxy);
  const target = wanted.toLowerCase();
  const matches = all.filter((workspace) => workspace.name.toLowerCase() === target);
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) {
    throw new PremanError(`no cloud workspace named "${wanted}"`, {
      exitCode: EXIT.CLI,
      details:
        all.length === 0
          ? ["this account has no cloud workspaces"]
          : ["available:", ...all.map((workspace) => `  ${workspace.name}`)],
    });
  }
  // Ambiguity is an error that lists the candidates; never guess what the user meant.
  throw new PremanError(`"${wanted}" matches ${matches.length} cloud workspaces`, {
    exitCode: EXIT.CLI,
    details: ["pass one of these ids instead:", ...matches.map((workspace) => `  ${workspace.id}`)],
  });
}

/** Every cloud workspace the signed-in Postman Desktop can see. */
export async function listCloudWorkspaces(args: { readonly postmanAppData: string }): Promise<CloudWorkspace[]> {
  return fetchWorkspaceList(await connect(args.postmanAppData));
}

/**
 * Migrate through a proxy that is already bound to a session.
 *
 * Split out because token acquisition is the one step no test can perform — it needs a running,
 * signed-in Postman Desktop — and everything after it can be exercised against an in-process
 * proxy. Not in the barrel: a front end has no way to build a `ProxyClient` and should not.
 */
export async function migrateThroughProxy(
  proxy: ProxyClient,
  args: Omit<MigrateArgs, "postmanAppData">,
): Promise<MigrationOutcome> {
  return migrateWith(proxy, args, migrationProgress(args.onProgress));
}

/**
 * The three steps, against a tracker the caller already owns.
 *
 * Private so that both entry points share one tracker each: `migrateCloudWorkspace` has a phase to
 * report before a proxy exists, and a second tracker built later would restart the read count it
 * had already begun.
 */
async function migrateWith(
  proxy: ProxyClient,
  args: Omit<MigrateArgs, "postmanAppData">,
  progress: ProgressTracker,
): Promise<MigrationOutcome> {
  // Named before the id is resolved, because resolving a *name* costs a listing call and a silent
  // gap there reads as a migration that never started.
  progress.at("reading-workspace");
  const source = await fetchCloudWorkspace(proxy, await resolveWorkspaceId(proxy, args.workspace), progress);
  // Converting is synchronous and blocks, so it cannot report from inside; it is announced instead,
  // which is the difference between a still bar and an apparently dead one.
  progress.at("converting");
  const plan = planWorkspace(source);
  if (!args.dryRun) await applyPlan(args.target, plan, progress);

  return {
    root: args.target,
    workspaceId: source.workspaceId,
    workspaceName: source.name,
    dryRun: args.dryRun,
    counts: plan.counts,
    skipped: plan.skipped,
    files: plan.files.map((file) => file.relativePath),
  };
}

/**
 * Migrate one Postman cloud workspace into a new directory.
 *
 * `dryRun` stops after conversion. That is not a second code path: the plan is a value, so the
 * only difference is whether `applyPlan` is called with it.
 */
export async function migrateCloudWorkspace(args: MigrateArgs): Promise<MigrationOutcome> {
  const progress = migrationProgress(args.onProgress);
  // The token harvest is a CDP connection with a ten-second ceiling of its own, so it is a phase
  // rather than dead air before the first one.
  progress.at("connecting");
  return migrateWith(await connect(args.postmanAppData), args, progress);
}
