import pc from "picocolors";
import type { ImportPlan } from "@preman/core/import/plan.js";
import type { HttpRequest } from "@preman/core/workspace/schemas.js";

/**
 * Painting an import, beside the migration painter.
 *
 * Same rule as `render/migrate.ts`: the report's job is to name what it did *not* bring. A curl
 * from a browser carries half a dozen flags preman has nowhere to put, and a request imported
 * without saying so is a request that behaves differently from the one that was pasted.
 */

const JSON_INDENT = 2;
const NOTHING = 0;
const GRPC_KIND = "grpc-request";
const GRPC_LABEL = "gRPC";
const DEFAULT_METHOD = "GET";
/** Two spaces past the widest flag, so the reasons line up without a table. */
const REASON_GAP = 2;

export interface ImportRenderOptions {
  json: boolean;
}

export interface ImportReport {
  readonly plan: ImportPlan;
  /** The name the file carries, which `--name` may have overridden. */
  readonly name: string;
  /** The destination group's display path. */
  readonly destination: string;
  /** The written file, workspace-relative; `null` on a dry run. */
  readonly file: string | null;
}

/**
 * The badge the app's sidebar would show: the HTTP verb, or `gRPC`.
 *
 * Not the method's trailing segment, which is also where the proposed name comes from — the
 * headline would then read `Imported Echo Echo (2)`, and for a one-letter method `M M`.
 */
function label(plan: ImportPlan): string {
  if (plan.kind === GRPC_KIND) return GRPC_LABEL;
  return ((plan.request as HttpRequest).method ?? DEFAULT_METHOD).toUpperCase();
}

/** The dropped flags, aligned, each with the reason it had nowhere to land. */
function droppedLines(plan: ImportPlan): string[] {
  if (plan.dropped.length === NOTHING) return [];
  const width = Math.max(...plan.dropped.map((drop) => drop.flag.length)) + REASON_GAP;
  return [
    `  ${pc.yellow("Not imported")}`,
    ...plan.dropped.map((drop) => `    ${pc.cyan(drop.flag.padEnd(width))}${pc.dim(drop.reason)}`),
  ];
}

function warningLines(plan: ImportPlan): string[] {
  if (plan.warnings.length === NOTHING) return [];
  return [`  ${pc.yellow("Warnings")}`, ...plan.warnings.map((warning) => `    ${pc.dim(warning)}`)];
}

/** The protos the apply declared, so a gRPC import says which `.proto` it is now bound to. */
function specLines(plan: ImportPlan): string[] {
  const specs = plan.specs;
  if (specs === null || specs.entries.length === NOTHING) return [];
  return [`  ${pc.bold("Protos")}`, ...specs.entries.map((entry) => `    ${pc.dim(entry.declared)}`)];
}

export function renderImport(report: ImportReport, options: ImportRenderOptions): string {
  if (options.json) return JSON.stringify(report, null, JSON_INDENT);

  const headline =
    report.file === null
      ? `Would import ${pc.cyan(label(report.plan))} ${pc.bold(report.name)} into ${report.destination}`
      : `Imported ${pc.cyan(label(report.plan))} ${pc.bold(report.name)} -> ${report.file}`;

  const sections = [droppedLines(report.plan), warningLines(report.plan), specLines(report.plan)].filter(
    (section) => section.length > NOTHING,
  );
  const lines = [headline];
  for (const section of sections) lines.push("", ...section);
  // A dry run's whole value is the document it would have written, so it prints it.
  if (report.file === null) lines.push("", report.plan.contents.trimEnd());
  return lines.join("\n");
}
