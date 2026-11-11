/**
 * Escape closes the pane that is up, and nothing else.
 *
 * `defaultPrevented` is how a closer layer claims the key first: Radix calls `preventDefault` when
 * Escape closes one of its own layers - the palette, a menu, a token box - and the sidebar's search
 * does the same when Escape closes it, so one press never closes two things.
 */
import { useEffect } from "react";

const ESCAPE = "Escape";

/** True for an Escape no closer layer has already answered. */
export function isUnclaimedEscape(pressed: Pick<KeyboardEvent, "key" | "defaultPrevented">): boolean {
  return pressed.key === ESCAPE && !pressed.defaultPrevented;
}

/**
 * Bound at the window while the pane is mounted, so Escape works wherever focus happens to be.
 *
 * The focused field is blurred before the pane goes. Every field in a pane that uses this commits on
 * blur, so Escape keeps an edit in progress exactly as clicking the close button would; dismissing
 * first would unmount the field without the blur that saves it.
 */
export function useEscapeToDismiss(onDismiss: () => void): void {
  useEffect(() => {
    function onKeyDown(pressed: KeyboardEvent): void {
      if (!isUnclaimedEscape(pressed)) return;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      onDismiss();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onDismiss]);
}
