import pc from "picocolors";
import type { SpecsView } from "@preman/core/api/specs.js";
import type { SharedLink } from "@preman/core/workspace/links.js";

const JSON_INDENT = 2;
const NOTHING = 0;

export interface ProtosRenderOptions {
  json: boolean;
}

/**
 * The declared protos, grouped by the shared link each one is reached through.
 *
 * Grouping rather than listing is the whole point of the view: a machine that has never linked
 * anything has one broken line per proto, which reads as thirty problems when it is three. The
 * name is what `preman protos link` takes, so it is printed even when the link is healthy.
 */
export function renderSpecs(view: SpecsView, options: ProtosRenderOptions): string {
  if (options.json) return JSON.stringify(view, null, JSON_INDENT);

  const lines = [pc.dim(view.resourcesPath), ""];
  if (view.specs.length === NOTHING) {
    lines.push(pc.yellow("(no protos declared)"));
    return lines.join("\n");
  }

  const links = new Map(view.links.map((link) => [link.name, link]));
  const grouped = new Map<string, string[]>();
  const unlinked: string[] = [];
  for (const spec of view.specs) {
    if (spec.link === undefined) unlinked.push(spec.declared);
    else grouped.set(spec.link, [...(grouped.get(spec.link) ?? []), spec.declared]);
  }

  for (const [name, declared] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${pc.cyan(name)} ${renderLink(links.get(name))}`);
    for (const one of declared) lines.push(`  ${pc.dim(one)}`);
    lines.push("");
  }

  if (unlinked.length > NOTHING) {
    lines.push(pc.yellow("not on a shared link"), ...unlinked.map((one) => `  ${pc.dim(one)}`), "");
  }

  const missing = view.unresolvedLinks;
  if (missing.length > NOTHING) {
    lines.push(pc.red(`${missing.length} link(s) to fix:`));
    for (const name of missing) lines.push(`  preman protos link ${name} <path-to-checkout>`);
  }
  return lines.join("\n").trimEnd();
}

function renderLink(link: SharedLink | undefined): string {
  if (link === undefined) return pc.red("(missing)");
  if (link.target === undefined) return pc.red("(not a symlink)");
  return link.resolves ? pc.dim(`-> ${link.target}`) : pc.red(`-> ${link.target} (dangling)`);
}

export function renderLinkWrite(link: SharedLink, options: ProtosRenderOptions): string {
  if (options.json) return JSON.stringify(link, null, JSON_INDENT);
  return `linked ${pc.cyan(link.name)} ${pc.dim(`-> ${link.target ?? ""}`)}`;
}
