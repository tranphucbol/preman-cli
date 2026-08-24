/**
 * Where the `{{token}}`s are in a piece of text, which one a character offset is inside, and what
 * the workspace knows about the name that turns up there.
 *
 * Pure, and deliberately so: the editors hit-test a click by asking CodeMirror for a document
 * position and the plain inputs hit-test one by reading `selectionStart`, so both callers arrive
 * with a number and neither has any geometry left to reason about. That makes the whole of "which
 * token did the user mean" a function of a string and an integer, which is a function a test suite
 * with no DOM can check.
 *
 * The pattern is the wire's name-extracting one, not `ui/template.ts`'s wider mask: a box that
 * opens on a name needs the name, so `{{}}` is not a token here even though it is one to mask.
 */
import { VARIABLE_TOKEN_SOURCE, type Scope, type VariableView } from "@preman/desktop/engine/protocol.js";

export interface TokenSpan {
  /** The name inside the braces, trimmed the way the engine trims it. */
  readonly name: string;
  /** Offset of the opening brace. */
  readonly from: number;
  /** Offset just past the closing brace, so `text.slice(from, to)` is the whole token. */
  readonly to: number;
}

/** `VARIABLE_TOKEN_SOURCE` has exactly one group, and it is the name. */
const NAME_GROUP = 1;

const NO_TOKENS: readonly TokenSpan[] = [];

/** A token is only worth a regex if the text has an opening brace in it at all. */
const OPENING_BRACE = "{";

/** `vars/dynamic` decides what a dynamic name is by this prefix, and so does this. */
const DYNAMIC_PREFIX = "$";

/** The scope this app can write, and the only one `VariableLayer.writable` is ever true for. */
const WRITABLE_SCOPE: Scope = "environment";

/** Only reachable if the engine answered with a binding from a layer it did not also report. */
const UNKNOWN_FILE = "";

/**
 * What a name trims down to when there is no name there. `{{}}` does not match the pattern at all,
 * but `{{ }}` does, with a name of one space — the group needs a character and a space is one. The
 * engine resolves that name as written and reports it missing, which is its business; a box that
 * offered to define a variable called " " would not be.
 */
const NO_NAME = "";

/**
 * Whether `text` is worth looking at properly. Cheap on purpose: this runs per keystroke in a field
 * that would otherwise re-render for a backdrop that has nothing to paint, and text with no `{` in
 * it is nearly every value in the grid.
 */
export function couldHaveTokens(text: string): boolean {
  return text.includes(OPENING_BRACE);
}

/**
 * Every token in `text`, in order.
 *
 * Its own compiled instance per call. A global regex carries `lastIndex`, and this is called from
 * a render path for every visible cell of a virtualized grid, so a shared instance would have two
 * cells reading each other's cursor.
 */
export function findTokens(text: string): readonly TokenSpan[] {
  // The overwhelmingly common case for a grid cell, kept off the regex engine entirely.
  if (!couldHaveTokens(text)) return NO_TOKENS;

  const pattern = new RegExp(VARIABLE_TOKEN_SOURCE, "g");
  const found: TokenSpan[] = [];
  for (const match of text.matchAll(pattern)) {
    const [whole] = match;
    const name = match[NAME_GROUP];
    if (name === undefined || name.trim() === NO_NAME) continue;
    found.push({ name, from: match.index, to: match.index + whole.length });
  }
  return found;
}

/**
 * The token `offset` falls inside, or `null`.
 *
 * Both ends are inclusive of the braces and the closing brace's own offset counts as inside: a
 * caret sitting immediately after `}}` is a caret the user put there by clicking the token's last
 * character, and `selectionStart` reports that as `to`.
 */
export function tokenAt(text: string, offset: number): TokenSpan | null {
  for (const token of findTokens(text)) {
    if (offset >= token.from && offset <= token.to) return token;
  }
  return null;
}

/**
 * What a box opened on a name has to say, as a closed set.
 *
 * Five arms for the four situations the plan names, because "no environment is chosen" and "this is
 * a dynamic variable" are one row of that table only in that both offer no field: what to do about
 * them is different, and a box that says "you cannot edit this" without saying which of the two it
 * is has failed at the one job it has.
 */
export type TokenState =
  /** A `{{$name}}`: generated per occurrence at send time, so there is nothing to store. */
  | { readonly kind: "dynamic" }
  /** No environment is chosen, so there is no writable layer to put a value in. */
  | { readonly kind: "no-environment" }
  /** Defined in the chosen environment: the one editable case. */
  | {
      readonly kind: "writable";
      readonly value: string;
      readonly environment: string;
      readonly shadows: readonly Scope[];
    }
  /** Defined in globals and nowhere else. `readVariables` marks that layer unwritable. */
  | { readonly kind: "read-only"; readonly value: string; readonly file: string }
  /** Defined nowhere. The environment is named because the box offers to append the key to it. */
  | { readonly kind: "absent"; readonly environment: string };

/**
 * Which of {@link TokenState} a name is in, given the view the engine answered with.
 *
 * A pure function of the view and the name, and deliberately not a hook: the branch that decides
 * whether the box shows a field is the part worth testing, and the test suite has no DOM. It reads
 * the binding's own `scope` and `shadowed` rather than searching the layers itself, so which layer
 * wins is still the engine's answer and never re-derived here.
 */
export function tokenState(view: VariableView, name: string): TokenState {
  if (name.startsWith(DYNAMIC_PREFIX)) return { kind: "dynamic" };

  const binding = view.bindings.find((candidate) => candidate.key === name);
  if (binding === undefined) {
    // Nothing carries the name. Whether that is fixable is entirely a question of whether there is
    // a writable layer to fix it in.
    return view.environment === undefined
      ? { kind: "no-environment" }
      : { kind: "absent", environment: view.environment };
  }

  if (binding.scope === WRITABLE_SCOPE && view.environment !== undefined) {
    return {
      kind: "writable",
      value: binding.value,
      environment: view.environment,
      shadows: binding.shadowed,
    };
  }

  const layer = view.layers.find((candidate) => candidate.scope === binding.scope);
  return { kind: "read-only", value: binding.value, file: layer?.file ?? UNKNOWN_FILE };
}
