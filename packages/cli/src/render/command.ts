import pc from "picocolors";
import { AUTH_SCOPE, type CommandPlan, type Revealed } from "@preman/core/command/plan.js";

/**
 * Painting a copied command, beside the import painter.
 *
 * The mirror of `render/import.ts`, and the same rule: the report's job is to name what the
 * command does *not* carry. A curl pasted into a terminal runs no scripts and keeps no cookie
 * jar, and a command handed over without saying so is a command that behaves differently from
 * the request it was copied from.
 *
 * The second section exists because a copied command is a secret leaving the workspace: `{{token}}`
 * on disk is a reference, `Bearer eyJ…` in a chat window is the credential itself.
 */

const JSON_INDENT = 2;
const NOTHING = 0;
/** Two spaces past the widest field, so the reasons line up without a table. */
const REASON_GAP = 2;
const REQUEST_ORIGIN_LABEL = "request";
const OWN_AUTH_SOURCE = "the request's own auth block";

export interface CommandRenderOptions {
  json: boolean;
}

/** Where the value came from: a scope name, or which ancestor's auth block resolved it. */
function sourceOf(entry: Revealed): string {
  if (entry.scope !== AUTH_SCOPE) return entry.scope;
  if (entry.origin === undefined || entry.origin === REQUEST_ORIGIN_LABEL) return OWN_AUTH_SOURCE;
  return `inherited from ${entry.origin}`;
}

/** `field`/`reason` pairs aligned under a heading; the shape both sections share. */
function alignedLines(heading: string, rows: readonly (readonly [string, string])[]): string[] {
  if (rows.length === NOTHING) return [];
  const width = Math.max(...rows.map(([field]) => field.length)) + REASON_GAP;
  return [`  ${heading}`, ...rows.map(([field, reason]) => `    ${pc.cyan(field.padEnd(width))}${pc.dim(reason)}`)];
}

export function renderCommand(plan: CommandPlan, options: CommandRenderOptions): string {
  if (options.json) return JSON.stringify(plan, null, JSON_INDENT);

  const sections = [
    alignedLines(
      pc.yellow("Not in this command"),
      plan.unexpressed.map((entry) => [entry.field, entry.reason] as const),
    ),
    alignedLines(
      pc.yellow("In cleartext"),
      plan.revealed.map((entry) => [entry.name, sourceOf(entry)] as const),
    ),
    plan.warnings.length === NOTHING
      ? []
      : [`  ${pc.yellow("Warnings")}`, ...plan.warnings.map((warning) => `    ${pc.dim(warning)}`)],
  ].filter((section) => section.length > NOTHING);

  // The command first and alone on its line: this output is meant to be selected and pasted.
  const lines = [plan.command];
  for (const section of sections) lines.push("", ...section);
  return lines.join("\n");
}
