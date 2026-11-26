/**
 * A glyph that puts text on the clipboard and says so.
 *
 * `read` is asked on the press and not before, because the text is not always to hand: a large
 * response body is fetched from the engine only when someone wants it, and a request body may have
 * keystrokes still waiting to be committed. `null` means there is nothing to copy, and the button
 * says nothing either.
 *
 * `refusal` keeps the button pressable rather than `disabled`: a disabled button emits no pointer
 * events, so the tooltip that says why could never open (`docs/design-system.md`). It is
 * `aria-disabled` instead, which is the same thing to a screen reader.
 *
 * A timeout rather than a store flag, as in `CommandPane` and `Banner`: this is one button's own
 * transient state, and nothing else needs to re-render for it.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { IconButton } from "./Controls.js";
import { CheckIcon, CONFIRMATION_WEIGHT, CopyIcon } from "./icons.js";

const COPY_FEEDBACK_MS = 1500;
const COPIED_LABEL = "Copied";

export function CopyButton({
  label,
  read,
  refusal,
  onFail,
}: {
  readonly label: string;
  readonly read: () => string | null | Promise<string | null>;
  /** Why it cannot copy, as the tooltip. Absent when it can. */
  readonly refusal?: string;
  /** Told when the clipboard itself refuses; `read` reports its own failures. */
  readonly onFail?: (message: string) => void;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeout.current !== null) clearTimeout(timeout.current);
    };
  }, []);

  const onClick = useCallback(async () => {
    if (refusal !== undefined) return;
    const text = await read();
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (cause) {
      onFail?.(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setCopied(true);
    if (timeout.current !== null) clearTimeout(timeout.current);
    timeout.current = setTimeout(() => {
      setCopied(false);
    }, COPY_FEEDBACK_MS);
  }, [read, refusal, onFail]);

  return (
    <IconButton
      label={refusal ?? (copied ? COPIED_LABEL : label)}
      aria-disabled={refusal !== undefined}
      onClick={() => void onClick()}
    >
      {copied ? <CheckIcon weight={CONFIRMATION_WEIGHT} /> : <CopyIcon />}
    </IconButton>
  );
}
