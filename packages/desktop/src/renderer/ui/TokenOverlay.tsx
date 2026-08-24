/**
 * The `{{token}}` pills behind a plain input, and the mechanics that keep them under its text.
 *
 * Decision 11: tokens are clickable in the fields too. The only way to paint a background behind
 * part of an `<input>`'s text is to make the input transparent and put a second copy of the text
 * behind it, aligned character for character. That copy is `aria-hidden` and `pointer-events: none`,
 * so to the accessibility tree and to the pointer it does not exist.
 *
 * The copy's own text is transparent and only the pill rectangles are painted. That is not a
 * shortcut: a grid cell's input carries `truncate`, so past the cell's width the browser draws an
 * ellipsis, and a backdrop cannot reproduce an ellipsis inside the flex box that centres it
 * vertically. A pill rectangle clipped by `overflow: hidden` is correct where clipped coloured text
 * would be a second, wrong copy of the value bleeding past the ellipsis. It also means the token
 * keeps the field's ink colour, which is what the disabled and struck-through tones need.
 *
 * The input stays uncontrolled - `Controls.tsx:9` is a budget, not a preference - so `useTokenPills`
 * keeps its own copy of the text and refuses to re-render for a keystroke that cannot change a
 * pill, which is nearly every keystroke in a grid of forty header rows.
 */
import { useCallback, useState, type InputEvent, type MouseEvent, type UIEvent } from "react";

import { couldHaveTokens, findTokens, tokenAt } from "@preman/desktop/renderer/model/tokens.js";

import { cn } from "./cn.js";
import { TOKEN_COLOR, type TokenReporter } from "./template.js";

const EMPTY = "";

/**
 * Everything that decides where the backdrop sits relative to the input, and nothing that decides
 * what a character looks like: the caller passes the input's own metrics for that.
 */
const OVERLAY_CLASS = "pointer-events-none absolute inset-0 flex select-none items-center overflow-hidden";

/** The same token the editor's decoration uses, at the weight a background can carry. */
const PILL_FILL = `color-mix(in oklab, ${TOKEN_COLOR} 22%, transparent)`;

const PILL_CLASS = "rounded-sm";

const PILL_STYLE = { backgroundColor: PILL_FILL };

export interface TokenOverlayProps {
  readonly value: string;
  /**
   * The input's own metrics - font, size, padding, border width, height. Passed rather than
   * restated: `--font-user-mono` and `--editor-font-size` are user preferences
   * (`docs/design-system.md:248`), and two declarations of a font is how a backdrop desynchronises
   * the first time somebody changes one.
   */
  readonly className: string;
}

/** The pills, and nothing else. Positioned by the caller, `aria-hidden`, never focusable. */
export function TokenOverlay({ value, className }: TokenOverlayProps): React.JSX.Element | null {
  const spans = findTokens(value);
  // Nothing to paint is the common case, and an element that paints nothing is still an element the
  // grid has to lay out for every visible cell.
  if (spans.length === 0) return null;

  const parts: React.ReactNode[] = [];
  let cut = 0;
  for (const span of spans) {
    if (span.from > cut) parts.push(value.slice(cut, span.from));
    parts.push(
      <span key={span.from} className={PILL_CLASS} style={PILL_STYLE}>
        {value.slice(span.from, span.to)}
      </span>,
    );
    cut = span.to;
  }
  if (cut < value.length) parts.push(value.slice(cut));

  return (
    <span aria-hidden className={cn(OVERLAY_CLASS, className)}>
      {/* `pre`, not `nowrap`: an input keeps the spaces you typed and a collapsing copy would slide
          every pill after the first one to the left. `shrink-0` so the flex box does not squeeze it
          instead of overflowing, which is what makes the horizontal scroll sync below possible. */}
      <span className="shrink-0 whitespace-pre text-transparent">{parts}</span>
    </span>
  );
}

export interface TokenPills {
  /** The text the backdrop is painting. */
  readonly value: string;
  readonly onInput: (event: InputEvent<HTMLInputElement>) => void;
  readonly onScroll: (event: UIEvent<HTMLInputElement>) => void;
  readonly onMouseUp: (event: MouseEvent<HTMLInputElement>) => void;
}

/**
 * The backdrop scrolls with the input rather than being re-rendered by it: a long value scrolled one
 * character at a time must not cost a render per character.
 *
 * Reached as the input's previous sibling rather than through a ref. The wrapper is built by the
 * same component that installs these handlers - the overlay is always the element immediately
 * before the input, and never anything else - so the relationship is a local invariant, and a ref
 * threaded out of a hook and back into JSX is the shape `react-hooks/refs` exists to refuse.
 */
function follow(input: HTMLInputElement): void {
  const backdrop = input.previousElementSibling;
  if (backdrop instanceof HTMLElement) backdrop.scrollLeft = input.scrollLeft;
}

/**
 * The backdrop's copy of an uncontrolled input's text, and the three handlers that keep it honest.
 *
 * `initial` is read once, on mount, which is exactly what `defaultValue` does on the input in front
 * of it: the two agree by construction rather than by an effect that re-synchronises them, and a
 * caller whose stored value changed from outside remounts the pair with `key` the way it already
 * has to for the input.
 *
 * `mouseup` and not `mousedown` for the hit test: the selection is not updated until the pointer is
 * released, and `selectionStart` is the whole reason decision 11 does not hit-test with geometry -
 * the browser has already worked out which character the pointer landed on, so asking it is exact
 * and costs nothing.
 */
export function useTokenPills(initial: string, report: TokenReporter | undefined): TokenPills {
  const [value, setValue] = useState(initial);

  const onScroll = useCallback((event: UIEvent<HTMLInputElement>) => {
    follow(event.currentTarget);
  }, []);

  const onInput = useCallback((event: InputEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const next = input.value;
    follow(input);
    // Returning `current` is a bail-out, not an update. Text with no brace in it cannot have a
    // pill, so typing a header value costs nothing here until the moment a `{` appears.
    setValue((current) => (couldHaveTokens(next) || couldHaveTokens(current) ? next : current));
  }, []);

  const onMouseUp = useCallback(
    (event: MouseEvent<HTMLInputElement>) => {
      if (report === undefined) return;
      const input = event.currentTarget;
      const caret = input.selectionStart;
      if (caret === null) return;
      // The live value, not the state above: the state is a render behind by construction.
      const token = tokenAt(input.value, caret);
      if (token === null) return;
      // The field's rect, not the token's: an input gives no per-character geometry, and a box that
      // drops below the field it belongs to is where the user is already looking.
      report(token.name, input.getBoundingClientRect());
    },
    [report],
  );

  return { value, onInput, onScroll, onMouseUp };
}

/**
 * An input's `defaultValue` as the string the backdrop needs. `ComponentProps<"input">` types it as
 * a string, a number or a list of strings, and only the first two are ever a field's text.
 */
export function initialText(value: unknown): string {
  if (typeof value === "string") return value;
  return typeof value === "number" ? String(value) : EMPTY;
}
