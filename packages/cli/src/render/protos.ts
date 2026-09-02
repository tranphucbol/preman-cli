import pc from "picocolors";
import type { DeclaredSpec, SpecsView } from "@preman/core/api/specs.js";
import type { SharedLink } from "@preman/core/workspace/links.js";

const JSON_INDENT = 2;
const NOTHING = 0;

/** What a link row says when its specs came out of the workspace's own checkout instead. */
const OWN_CHECKOUT_NOTE = "read from this workspace's own checkout";
/** The same fact against one spec, for a link that answered some of its specs and not others. */
const OWN_CHECKOUT_LABEL = "(own checkout)";
/**
 * Said once under the repair footer, because a pre-filled path is a suggestion and not an answer:
 * the checkout is only the right target for a link that names this repository (ADR 042).
 */
const OWN_CHECKOUT_HINT = "the path above is this workspace's own checkout — check it is the one you meant";

export interface ProtosRenderOptions {
  json: boolean;
}

/**
 * The declared protos, grouped by the shared link each one is reached through.
 *
 * Grouping rather than listing is the whole point of the view: a machine that has never linked
 * anything has one broken line per proto, which reads as thirty problems when it is three. The
 * name is what `preman protos link` takes, so it is printed even when the link is healthy — and
 * especially when the specs under it resolved without it, which is a link a workspace outside
 * this repository still needs.
 */
export function renderSpecs(view: SpecsView, options: ProtosRenderOptions): string {
  if (options.json) return JSON.stringify(view, null, JSON_INDENT);

  const lines = [pc.dim(view.resourcesPath), ""];
  if (view.specs.length === NOTHING) {
    lines.push(pc.yellow("(no protos declared)"));
    return lines.join("\n");
  }

  const links = new Map(view.links.map((link) => [link.name, link]));
  const grouped = new Map<string, DeclaredSpec[]>();
  const unlinked: string[] = [];
  for (const spec of view.specs) {
    if (spec.link === undefined) unlinked.push(spec.declared);
    else grouped.set(spec.link, [...(grouped.get(spec.link) ?? []), spec]);
  }

  for (const [name, specs] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    const link = links.get(name);
    // Every spec through the checkout and no link to speak of is the fresh-clone shape: not
    // healthy, because the link is still worth creating, and not broken either.
    const wholeGroup = link === undefined && specs.every(fromOwnCheckout);
    lines.push(`${pc.cyan(name)} ${wholeGroup ? pc.yellow(`(${OWN_CHECKOUT_NOTE})`) : renderLink(link)}`);
    for (const spec of specs) {
      const label = !wholeGroup && fromOwnCheckout(spec) ? ` ${pc.yellow(OWN_CHECKOUT_LABEL)}` : "";
      lines.push(`  ${pc.dim(spec.declared)}${label}`);
    }
    lines.push("");
  }

  if (unlinked.length > NOTHING) {
    lines.push(pc.yellow("not on a shared link"), ...unlinked.map((one) => `  ${pc.dim(one)}`), "");
  }

  const missing = view.unresolvedLinks;
  if (missing.length > NOTHING) {
    lines.push(pc.red(`${missing.length} link(s) to fix:`));
    // The checkout the engine is already standing in beats `<path-to-checkout>`: a clone whose
    // directory was renamed resolves nothing automatically, and this is what makes repairing it
    // one visible command rather than a directory hunt.
    const target = view.ownCheckout ?? "<path-to-checkout>";
    for (const name of missing) lines.push(`  preman protos link ${name} ${target}`);
    if (view.ownCheckout !== undefined) lines.push(pc.dim(`  ${OWN_CHECKOUT_HINT}`));
  }
  return lines.join("\n").trimEnd();
}

function fromOwnCheckout(spec: DeclaredSpec): boolean {
  return spec.via === "own-checkout";
}

function renderLink(link: SharedLink | undefined): string {
  if (link === undefined) return pc.red("(missing)");
  if (link.target === undefined) return pc.red("(not a symlink)");
  return link.resolves ? pc.dim(`-> ${link.target}`) : pc.red(`-> ${link.target} (dangling)`);
}

/**
 * A written link, and how much of the workspace it repaired.
 *
 * The count is the point. `linked refund-core -> …` prints identically whether the directory
 * picked was the checkout the declarations name or its parent, so a link pointing one level off
 * used to read as success and be discovered later as a picker with no methods in it. `view` is
 * absent when there is no workspace to count against — `protos link` deliberately runs without
 * one, because the machine that needs it is usually one where nothing loads yet.
 */
export function renderLinkWrite(link: SharedLink, view: SpecsView | undefined, options: ProtosRenderOptions): string {
  const counted = view === undefined ? undefined : countSpecs(view, link.name);
  if (options.json) {
    return JSON.stringify(counted === undefined ? link : { ...link, specs: counted }, null, JSON_INDENT);
  }

  const written = `linked ${pc.cyan(link.name)} ${pc.dim(`-> ${link.target ?? ""}`)}`;
  if (counted === undefined) return written;
  const summary = `${String(counted.resolved)} of ${String(counted.declared)} specs now resolve`;
  return `${written}\n${counted.resolved === counted.declared ? pc.dim(summary) : pc.yellow(summary)}`;
}

function countSpecs(view: SpecsView, name: string): { resolved: number; declared: number } {
  const specs = view.specs.filter((spec) => spec.link === name);
  return { resolved: specs.filter((spec) => spec.exists).length, declared: specs.length };
}
