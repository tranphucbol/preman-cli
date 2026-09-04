/**
 * What the command pane works out before it draws anything.
 *
 * The pane is a command and three lists, and the decisions between them are all naming: what the
 * header calls the dialect, how a revealed variable says where its value came from, and whether
 * there is anything to put on the clipboard yet. None of that needs a DOM, and the suite cannot
 * render a component, so it lives here where it can be asserted — the same split `model/import.ts`
 * makes.
 *
 * Nothing here builds a command. The renderer holds the plan the engine made and nothing else;
 * the words are the engine's answer, not a string this side assembles.
 */

import type { CommandFormat, CommandPlan, Revealed } from "@preman/desktop/engine/protocol.js";

const GRPC_KIND = "grpc-request";
/** The scope `Revealed` uses for a credential, which is not a variable scope at all. */
const AUTH_SCOPE = "auth";
/** What `ScriptOrigin.label` reads when the auth block is the request's own. */
const REQUEST_ORIGIN = "request";

export const NOT_EXPRESSED_TITLE = "Not in this command";
export const REVEALED_TITLE = "In cleartext";
export const WARNINGS_TITLE = "Warnings";
export const COPY_LABEL = "Copy";
export const COPIED_LABEL = "Copied";
export const CLOSE_LABEL = "Close";
/**
 * The entry point's caption, which has to name the dialect before the pane exists to say it.
 *
 * Each tool spelled the way it spells itself: `cURL` because that is the project's own
 * capitalisation and the File menu already reads it that way, `grpcurl` because that one is
 * lowercase everywhere including its own binary.
 */
export const COPY_AS_LABELS: Record<CommandFormat, string> = {
  curl: "Copy as cURL",
  grpcurl: "Copy as grpcurl",
};
/**
 * What the open aside calls itself, which is the dialect and not the verb.
 *
 * The toolbar glyph has to say what pressing it will do, and `COPY_AS_LABELS` is that sentence.
 * A header labels what is already on screen: repeating "Copy as" above a panel that is merely
 * showing you something would make the panel sound like a button.
 */
export const DIALECT_LABELS: Record<CommandFormat, string> = { curl: "cURL", grpcurl: "grpcurl" };
/** What the header reads before the engine has answered. Never "Loading": the aside is the wait. */
export const PLANNING_TITLE = "Command";
/** The caption on the toolbar glyph while the aside is open, so one control reads both ways. */
export const HIDE_LABEL = "Hide the command";

/**
 * The pane's state.
 *
 * A union for the reason `ImportPane`'s `Preview` is one: a refusal has to keep its details, and
 * a pane that stored a plan and a message side by side could show both. There is no `empty` arm —
 * unlike import, this pane has its input the moment it opens.
 */
export type Preview =
  | { readonly kind: "planning" }
  | { readonly kind: "planned"; readonly plan: CommandPlan }
  | { readonly kind: "rejected"; readonly message: string; readonly details: readonly string[] };

export const PLANNING: Preview = { kind: "planning" };

/** The toolbar glyph's caption: `Copy as cURL` or `Copy as grpcurl`. */
export function commandTitle(format: CommandFormat): string {
  return COPY_AS_LABELS[format];
}

/** The open aside's heading: `cURL` or `grpcurl`. */
export function dialectTitle(format: CommandFormat): string {
  return DIALECT_LABELS[format];
}

/** Which dialect a request of this kind copies to, so a menu item can be named before the trip. */
export function formatForKind(kind: string): CommandFormat {
  return kind === GRPC_KIND ? "grpcurl" : "curl";
}

/**
 * Where a revealed value came from, in words.
 *
 * A variable says its scope, because that is the file the user would go and edit. A credential
 * has no scope — core has no concept of a secret and `revealed` declines to invent one — so it
 * says which auth block it was resolved from instead, which is the thing that would have to
 * change for it to stop appearing here.
 */
export function revealedLabel(entry: Revealed): string {
  if (entry.scope !== AUTH_SCOPE) return entry.scope;
  if (entry.origin === undefined || entry.origin === REQUEST_ORIGIN) return "this request";
  return `inherited from ${entry.origin}`;
}

/**
 * Credentials first, then variables in the order the engine found them.
 *
 * An inherited `Authorization` is the one entry someone reads this list to find, and it is the
 * one they would not have gone looking for: a token they never typed into this request is in the
 * command they are about to paste into a chat window.
 */
export function revealedOrder(revealed: readonly Revealed[]): Revealed[] {
  return [
    ...revealed.filter((entry) => entry.scope === AUTH_SCOPE),
    ...revealed.filter((entry) => entry.scope !== AUTH_SCOPE),
  ];
}

/**
 * Whether Copy can be pressed.
 *
 * A plan, and nothing else. Deliberately not "the pane is open": the clipboard is never written
 * without a press, so there is no state in which the button is a formality (decision 18).
 */
export function canCopy(preview: Preview): boolean {
  return preview.kind === "planned";
}
