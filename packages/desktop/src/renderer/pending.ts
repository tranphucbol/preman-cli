/**
 * The focused editor's uncommitted text, if there is one.
 *
 * `CodeEditor` and `Field` are uncontrolled and commit on blur, so `Cmd+S` fired at the window
 * (`App.tsx`, precisely so CodeMirror cannot swallow it) never reaches the focused editor to make
 * it blur and commit. This is the seam that lets `saveTab`/`sendNode` ask "what is the caret
 * sitting on right now?" before they read the store.
 *
 * Module scope, one slot, no React: two editors cannot hold focus at once, so a stack would be a
 * lie about the DOM, and this is called from `actions.ts`, which is not a component.
 */
let current: (() => void) | null = null;

/** Registered on focus. Replaces whatever was there, which is always nothing else's job to flush. */
export function registerFlush(flush: () => void): void {
  current = flush;
}

/**
 * Clear a registration. Takes the function being cleared, not just "clear whatever is there": a
 * blur that fires after a newer editor already focused (and registered) must not clear that
 * newer editor's flush.
 */
export function clearFlush(flush: () => void): void {
  if (current === flush) current = null;
}

/** Commit whatever the focused editor holds. A no-op when nothing is focused. */
export function flushPending(): void {
  current?.();
}
