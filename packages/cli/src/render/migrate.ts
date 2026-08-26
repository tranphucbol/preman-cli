import pc from "picocolors";
import type { CloudWorkspace, MigrationPhase, MigrationProgress, MigrationOutcome } from "@preman/core";

/**
 * Painting a migration, beside the outcome, list and env painters.
 *
 * The report's job is to name what it did *not* bring: a count of requests written is easy to
 * trust, and a silently absent websocket request is the failure mode ADR 033 names. Every skipped
 * item is printed by its full path, because the count tells you nothing you can act on.
 */

const JSON_INDENT = 2;
const COLLECTION_KIND = "collection";
const FOLDER_KIND = "folder";
const ENVIRONMENT_KIND = "environment";
const GRPC_KIND = "grpc-request";
const HTTP_KIND = "http-request";

/** How each counted kind reads in a sentence, singular and plural. */
const KIND_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  [COLLECTION_KIND]: ["collection", "collections"],
  [FOLDER_KIND]: ["folder", "folders"],
  [ENVIRONMENT_KIND]: ["environment", "environments"],
  [GRPC_KIND]: ["gRPC request", "gRPC requests"],
  [HTTP_KIND]: ["HTTP request", "HTTP requests"],
};
/** The order the report reads in: what holds things, then what was in them. */
const HEADLINE_KINDS = [COLLECTION_KIND, FOLDER_KIND, ENVIRONMENT_KIND];
const REQUEST_KINDS = [GRPC_KIND, HTTP_KIND];

export interface MigrateRenderOptions {
  json: boolean;
}

/** How each phase reads. Padded to a common width so the bar beside it does not jitter. */
const PHASE_LABELS: Readonly<Record<MigrationPhase, string>> = {
  connecting: "connecting",
  "reading-workspace": "reading workspace",
  "reading-collections": "reading collections",
  "reading-environments": "reading environments",
  converting: "converting",
  writing: "writing files",
};
const PHASE_WIDTH = Math.max(...Object.values(PHASE_LABELS).map((label) => label.length));

const BAR_WIDTH = 20;
const BAR_FILLED = "█";
const BAR_EMPTY = "░";
const PERCENT = 100;
/** Below this there is no room for a bar, so the line is counts alone. */
const MIN_COLUMNS = 60;
const READS_LABEL: readonly [string, string] = ["read", "reads"];
const NOTHING = 0;

/**
 * A proportion drawn, for the phases that have one.
 *
 * `total` of `undefined` gets no bar at all rather than an empty one: an empty bar is a claim that
 * nothing has happened yet, and what is actually true is that nobody knows how much there is.
 * `postman/progress.ts` says why that is not a gap to be filled in.
 */
function bar(done: number, total: number): string {
  // A zero-length phase is finished the moment it starts; drawing it empty would leave a workspace
  // with no environments looking stuck.
  //
  // Floor, not round: rounding fills the last cell at 97.5%, so a bar that is visibly complete
  // sits beside a percentage that is not. Under-claiming by half a cell is the harmless direction.
  const filled = total === NOTHING ? BAR_WIDTH : Math.floor((done / total) * BAR_WIDTH);
  return `${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(BAR_WIDTH - filled)}`;
}

function percent(done: number, total: number): string {
  const value = total === NOTHING ? PERCENT : Math.floor((done / total) * PERCENT);
  return `${String(value)}%`.padStart(4);
}

/**
 * One line of progress, for a terminal `columns` wide.
 *
 * Pure, so the shape is assertable without a TTY; `progress.ts` owns the carriage returns and the
 * decision to write at all.
 */
export function renderProgress(progress: MigrationProgress, columns: number): string {
  const label = PHASE_LABELS[progress.phase].padEnd(PHASE_WIDTH);
  const reads = pc.dim(plural(progress.calls, READS_LABEL));
  if (progress.total === undefined) return `  ${label}  ${reads}`;

  const counts = `${String(progress.done)}/${String(progress.total)}`;
  if (columns < MIN_COLUMNS) return `  ${label}  ${counts}  ${reads}`;
  return `  ${label}  ${pc.cyan(bar(progress.done, progress.total))} ${percent(progress.done, progress.total)}  ${counts}  ${reads}`;
}

const SINGULAR = 1;

function plural(count: number, forms: readonly [string, string]): string {
  return `${count} ${count === SINGULAR ? forms[0] : forms[1]}`;
}

function labelled(kind: string, count: number): string {
  return plural(count, KIND_LABELS[kind] ?? [kind, kind]);
}

export function renderWorkspaceList(workspaces: readonly CloudWorkspace[], options: MigrateRenderOptions): string {
  if (options.json) return JSON.stringify(workspaces, null, JSON_INDENT);
  if (workspaces.length === 0) return pc.yellow("no cloud workspaces are visible to this Postman account");
  return workspaces.map((workspace) => `  ${pc.cyan(workspace.name)} ${pc.dim(workspace.id)}`).join("\n");
}

/** The skipped list, indented under its own count. Every entry names a kind preman cannot write. */
function skippedLines(outcome: MigrationOutcome): string[] {
  if (outcome.skipped.length === 0) return [];
  const kinds = [...new Set(outcome.skipped.map((item) => item.kind))].sort();
  return [
    `  ${pc.yellow(`${outcome.skipped.length} skipped`)} ${pc.dim(`(${kinds.join(", ")})`)}`,
    ...outcome.skipped.map((item) => `      ${pc.dim(item.path)}`),
  ];
}

export function renderMigration(outcome: MigrationOutcome, options: MigrateRenderOptions): string {
  if (options.json) return JSON.stringify(outcome, null, JSON_INDENT);

  const headline = HEADLINE_KINDS.filter((kind) => (outcome.counts[kind] ?? 0) > 0).map((kind) =>
    labelled(kind, outcome.counts[kind] ?? 0),
  );
  const verb = outcome.dryRun ? "Would migrate" : "Migrated";
  const lines = [
    `${verb} ${headline.length === 0 ? "nothing" : headline.join(", ")} into ${outcome.root}`,
    ...REQUEST_KINDS.filter((kind) => (outcome.counts[kind] ?? 0) > 0).map(
      (kind) => `  ${labelled(kind, outcome.counts[kind] ?? 0)}`,
    ),
    ...skippedLines(outcome),
  ];
  // A dry run's whole value is the paths it would have written, so it prints them.
  if (outcome.dryRun) lines.push("", ...outcome.files.map((file) => `  ${pc.dim(file)}`));
  return lines.join("\n");
}
