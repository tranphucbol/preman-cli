/**
 * What the protos pane works out before it draws anything.
 *
 * The pane's real content is not the list of specs the engine hands back - it is the list of
 * shared links those specs need, which is nowhere in the answer and has to be derived from the
 * spec rows. That derivation, the wording that goes beside each link, and the "that name is taken,
 * here is a free one" arithmetic are the parts worth asserting, so they live here rather than
 * inside a component the suite cannot render.
 */

import type { DeclaredSpec, PlannedSpec, SharedLink, SpecPlan, SpecsView } from "@preman/desktop/engine/protocol.js";

const FIRST_SUFFIX = 2;
const NEXT_SUFFIX = 1;
const NOTHING = 0;

export const MISSING_LABEL = "missing";
export const UNLINKED_LABEL = "not linked";
export const DANGLING_HINT = "points at a directory that is not there";
export const NOT_A_LINK_HINT = "a real directory, not a link";

/**
 * One link this workspace needs, and what this machine currently has for it.
 *
 * `link` is synthesised when the entry is absent so the row and its button always have something
 * to hand back: "locate the one that isn't there" is the whole point of the row, and making the
 * caller re-invent the empty case is how that button ends up disabled by accident.
 */
export interface LinkState {
  readonly name: string;
  readonly link: SharedLink;
  readonly detail: string;
  readonly missing: boolean;
}

/**
 * The links the declared specs reach through, name-sorted and deduped.
 *
 * Derived from the specs rather than from `view.links`, because the shared root is machine-wide:
 * it holds links for every workspace this machine has ever set up, and listing those here would
 * show a reader other people's repositories as if this workspace wanted them.
 */
export function linkStates(view: SpecsView): LinkState[] {
  const unresolved = new Set(view.unresolvedLinks);
  const needed = new Set<string>();
  for (const spec of view.specs) if (spec.link !== undefined) needed.add(spec.link);

  return [...needed].sort().map((name) => {
    const link = view.links.find((candidate) => candidate.name === name);
    return {
      name,
      link: link ?? { name, target: undefined, resolves: false },
      detail: linkDetail(link),
      missing: unresolved.has(name),
    };
  });
}

/**
 * A link that is absent and a link that dangles read as one sentence, because the repair is the
 * same in both cases and splitting them would make a reader learn a distinction the button below
 * does not care about.
 */
function linkDetail(link: SharedLink | undefined): string {
  if (link === undefined) return MISSING_LABEL;
  if (link.target === undefined) return NOT_A_LINK_HINT;
  return link.resolves ? link.target : `${link.target} — ${DANGLING_HINT}`;
}

/** How many declared specs are still written as a path to this machine rather than through a link. */
export function unlinkedCount(view: SpecsView): number {
  return view.specs.filter((spec) => spec.link === undefined).length;
}

/** What a spec row flags. Both can be true: a converted spec whose link nobody has created yet. */
export function specFlags(spec: DeclaredSpec): { readonly missing: boolean; readonly unlinked: boolean } {
  return { missing: !spec.exists, unlinked: spec.link === undefined };
}

/**
 * How many specs an apply would actually write.
 *
 * A duplicate is still shown - dropping it from the list would leave a reader wondering which of
 * the files they picked went missing - but it is not a write, and the Apply label has to say the
 * number that will change.
 */
export function plannedWrites(plan: SpecPlan): number {
  return plan.entries.filter((entry) => writes(entry)).length;
}

/**
 * Whether applying the plan would change this entry's line in `resources.yaml`.
 *
 * Two kinds of row are shown and not written: one already declared exactly this way, and one
 * whose file is not on this machine and therefore has no link to be declared through. Both
 * belong on screen — the second is the whole answer for a workspace someone else authored —
 * and neither belongs in the count on the Apply button.
 */
export function writes(entry: PlannedSpec): boolean {
  return !entry.duplicate && entry.link !== undefined;
}

/** Whether the plan can be applied at all. A conflict is a decision owed, not a failure. */
export function planBlocked(plan: SpecPlan): boolean {
  return plan.conflicts.length > NOTHING;
}

/** The names the shared root already holds, which is what a new link has to avoid. */
export function takenNames(links: readonly SharedLink[]): Set<string> {
  return new Set(links.map((link) => link.name));
}

/**
 * The first `name-N` nobody holds.
 *
 * Offered to the reader as a button label, so it has to be the name the click actually uses -
 * which is why it is a function of the taken set and not a counter that moves between the two.
 */
export function freeName(base: string, taken: ReadonlySet<string>): string {
  let suffix = FIRST_SUFFIX;
  while (taken.has(`${base}-${String(suffix)}`)) suffix += NEXT_SUFFIX;
  return `${base}-${String(suffix)}`;
}
