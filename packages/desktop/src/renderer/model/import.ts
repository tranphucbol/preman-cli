/**
 * What the import pane works out before it draws anything.
 *
 * The pane is a text box and a preview, and almost everything interesting about it is a decision
 * taken between the two: whether the clipboard is worth prefilling with, what the summary line
 * says for a request that has no verb, which destinations a request file may actually land in,
 * and whether Escape is allowed to dismiss. None of that needs a DOM, and the suite cannot render
 * a component, so it lives here where it can be asserted.
 *
 * The paste itself is never parsed on this side of the port. The renderer holds the text and the
 * plan the engine made of it, and nothing in between.
 */

import type { CatalogNode, ImportPlan, MutateOp } from "@preman/desktop/engine/protocol.js";
// The label, not a component: the preview's chip has to read what the sidebar row will read.
import { GRPC_LABEL } from "@preman/desktop/renderer/ui/method.js";

const FIRST = 0;
const GRPC_KIND = "grpc-request";
const DEFAULT_METHOD = "GET";
/** Non-breaking, because HTML collapses leading ordinary spaces. Matches `model/destination.ts`. */
const DEPTH_INDENT = "\u00a0\u00a0";

/** The same words the File menu, the palette and the sidebar's button use. Four ways in, one name. */
export const PANE_TITLE = "Import from cURL or grpcurl";
/**
 * `PASTE_LABEL` is a tooltip on a glyph, which is why it carries more than a caption would: `Paste`
 * beside a clipboard icon says nothing the icon did not, so it says where from. `IMPORT_LABEL` is a
 * caption on the dialog's commit, where one word in the accent colour is the whole affordance.
 */
export const PASTE_LABEL = "Paste from clipboard";
export const IMPORT_LABEL = "Import";
export const NAME_LABEL = "Name";
export const DESTINATION_LABEL = "In";
export const DROPPED_TITLE = "Not imported";
export const WARNINGS_TITLE = "Warnings";
export const CLOSE_LABEL = "Close import";
/** Shown in the empty box. A command, so the shape of what belongs there needs no prose. */
export const PASTE_PLACEHOLDER = "curl 'https://api.example.com/orders' -H 'accept: application/json'";
/**
 * Said instead of a destination picker when the workspace has no group. A request file cannot
 * sit at the workspace root, so there is nothing to offer and nothing to disable — only
 * somewhere else to go first.
 */
export const NO_GROUPS_HINT = "Make a collection first: an imported request needs one to live in.";

/** The command words a paste has to start with to be worth prefilling the box with. */
const COMMANDS = new Set(["curl", "curl.exe", "grpcurl", "grpcurl.exe"]);

/**
 * The pane's preview, which is not the same thing as its text.
 *
 * Kept apart from the paste so a refusal cannot cost the user their clipboard: the box still
 * holds what they pasted, the message sits under it, and fixing one word is a keystroke rather
 * than another trip to the terminal.
 */
export type Preview =
  | { readonly kind: "empty" }
  | { readonly kind: "planning" }
  | { readonly kind: "planned"; readonly plan: ImportPlan }
  | { readonly kind: "rejected"; readonly message: string; readonly details: readonly string[] };

export const NO_PREVIEW: Preview = { kind: "empty" };

/** One group an imported request may land in. */
export interface ImportTarget {
  readonly id: string;
  readonly label: string;
}

/**
 * Whether the clipboard is worth putting in the box.
 *
 * Opening the pane with the clipboard already in it saves the one gesture the whole feature is
 * about, but only when the clipboard is a command. Anything else - the prose someone was reading
 * beside the command, a password, half a URL - would be text the user has to clear before they
 * can do the thing they opened the pane for, so an unrecognised clipboard leaves it empty.
 */
export function pastedCommand(clipboard: string): string {
  const first = clipboard.trim().split(/\s+/)[FIRST];
  if (first === undefined) return "";
  return COMMANDS.has(first) ? clipboard.trim() : "";
}

/**
 * The groups a request may be imported into, in tree order and indented by depth.
 *
 * Unlike `groupDestinations`, there is no workspace-root row: a `.request.yaml` at the root is
 * not part of any collection, so offering it would produce a file the catalog does not show.
 */
export function importTargets(nodes: readonly CatalogNode[]): ImportTarget[] {
  return nodes
    .filter((node) => node.kind !== "request")
    .map((node) => ({ id: node.id, label: DEPTH_INDENT.repeat(node.depth) + node.name }));
}

/**
 * Where the pane should point when it opens: the group the user asked from, else the one holding
 * the selection, else the first group there is. Never a group that has since gone.
 */
export function defaultTarget(
  targets: readonly ImportTarget[],
  asked: string | undefined,
  selectedId: string | null,
): string {
  const has = (id: string | null | undefined): boolean => targets.some((target) => target.id === id);
  if (has(asked) && asked !== undefined) return asked;
  if (has(selectedId) && selectedId !== null) return selectedId;
  return targets[FIRST]?.id ?? "";
}

/**
 * One field of the planned request, as a string.
 *
 * Read this way rather than off the type because both request schemas pass unknown keys through,
 * which widens every field to something that is not necessarily a string. A preview that
 * stringified an object would print `[object Object]` into the pane's headline.
 */
function field(plan: ImportPlan, key: string): string {
  const value = (plan.request as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/**
 * The chip beside the summary.
 *
 * `GRPC_LABEL` rather than the method's tail, because that is what the sidebar and the tab strip
 * put in the same slot: the row the import is about to create will read `gRPC` there, and a
 * preview that reads something else would be previewing a different row.
 */
export function previewLabel(plan: ImportPlan): string {
  if (plan.kind === GRPC_KIND) return GRPC_LABEL;
  const method = field(plan, "method");
  return (method === "" ? DEFAULT_METHOD : method).toUpperCase();
}

/** The verb this plan colours by, or absent for gRPC, which has no verb to colour. */
export function previewVerb(plan: ImportPlan): string | undefined {
  return plan.kind === GRPC_KIND ? undefined : previewLabel(plan);
}

/** The line beside the chip: where the request goes. A gRPC target is its method path, not its URL. */
export function previewTarget(plan: ImportPlan): string {
  return field(plan, plan.kind === GRPC_KIND ? "methodPath" : "url");
}

/**
 * Whether Import can be pressed.
 *
 * A plan and a destination, and nothing in flight. Deliberately not "the text is non-empty":
 * text the engine has not seen is text nobody has checked, and importing it would write a file
 * the user was never shown.
 */
export function canImport(preview: Preview, target: string, importing: boolean): boolean {
  return preview.kind === "planned" && target !== "" && !importing;
}

/**
 * Whether Escape and the backdrop may dismiss the pane.
 *
 * An import in flight is writing files - a request, and possibly a link and a `resources.yaml`
 * entry with it. Letting the pane go while that happens would leave the user with no way to
 * learn whether it finished, so the one moment the pane is least dismissible is the one moment
 * a stray keystroke is most likely.
 */
export function dismissible(importing: boolean): boolean {
  return !importing;
}

/**
 * The mutation Import sends.
 *
 * The name only travels when the user changed it. The plan already carries the one the engine
 * chose against that directory's existing files, and sending it back unchanged would ask the
 * engine to re-resolve a collision it already resolved.
 */
export function importOp(plan: ImportPlan, parentId: string, name: string): MutateOp {
  const trimmed = name.trim();
  return {
    op: "import-request",
    parentId,
    plan,
    ...(trimmed === "" || trimmed === plan.name ? {} : { name: trimmed }),
  };
}
