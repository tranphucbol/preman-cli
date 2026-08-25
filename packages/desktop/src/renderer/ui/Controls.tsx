/**
 * Buttons, inputs and tooltips at tool density.
 *
 * Every control here is 26px or 30px tall against a 13px body size. That is the retune decision 11
 * calls for, and it is why no component library ships this: 26px is uncomfortably small for a
 * marketing page and exactly right for a pane you keep open all day.
 *
 * `Field` is a native element on purpose, and decision 10 refuses shadcn `Form` for the same
 * reason: uncontrolled inputs that commit on blur are what keeps keystroke-to-paint under 8ms
 * with forty header rows. `Select` used to be native for the same reason and is not any more -
 * see its own note. The line between them is whether the OS draws anything the user looks at.
 */
import * as SelectPrimitive from "@radix-ui/react-select";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { useCallback, useEffect, useRef, type ComponentProps, type FocusEvent, type ReactNode, type Ref } from "react";

import { clearFlush, registerFlush } from "@preman/desktop/renderer/pending.js";

import { cn } from "./cn.js";
import { CheckIcon, GLYPH_CLASS, PickerIcon } from "./icons.js";
import { initialText, TokenOverlay, useTokenPills } from "./TokenOverlay.js";
import type { TokenReporter } from "./template.js";

const TOOLTIP_DELAY_MS = 400;

/** How long "already explaining things" lasts. Within it, the next tooltip skips the delay. */
const TOOLTIP_SKIP_DELAY_MS = 300;

/**
 * The transition list is spelled out rather than `transition-colors` plus `transition-transform`,
 * because a second `transition-*` utility replaces the first rather than adding to it — which is
 * how a button ends up depressing instantly and fading its colour, or the other way round.
 *
 * `active:scale-[0.97]` is the whole point of this class, and `disabled:active:scale-100` is what
 * stops a disabled button from claiming it heard you. Decision 26.
 */
const BASE_CONTROL =
  "inline-flex select-none items-center justify-center gap-1.5 rounded-sm text-xs whitespace-nowrap transition-[color,background-color,border-color,transform] duration-(--duration-press) ease-out active:scale-[0.97] disabled:text-ink-faint disabled:active:scale-100";

/**
 * The two heights a control comes in, named for the row it belongs to rather than for its size.
 *
 * `content` is 30px, for a control that is part of the thing being edited: the URL, the Send
 * beside it, the method picker beside that. `chrome` is 26px, for a control in a strip that frames
 * the thing being edited - a pane's toolbar, the tab bar - where 30px makes it the tallest object
 * in a row it is not the subject of.
 *
 * Size and paint are separate axes on purpose. They used to be one, which is how the app ended up
 * with a toolbar whose only job was to hold a button and which was therefore sized by it.
 */
const TIER_CLASS = {
  content: "h-control-lg",
  chrome: "h-control",
} as const;

export type ControlTier = keyof typeof TIER_CLASS;

const VARIANT_CLASS = {
  /** The accent is a fill exactly once per pane: the thing you came here to press. */
  primary: "bg-accent px-3 font-medium text-canvas hover:bg-accent/85 disabled:bg-control",
  neutral: "border border-line-strong bg-control px-3 text-ink hover:bg-hover",
  quiet: "px-2 text-ink-dim hover:bg-hover hover:text-ink",
  danger: "border border-danger/40 px-3 text-danger hover:bg-danger/15",
} as const;

export type ButtonVariant = keyof typeof VARIANT_CLASS;

/**
 * Which tier a variant lands in when the caller does not say. `quiet` is the chrome variant by
 * construction - it has no border and no fill, so it only reads as a button in a strip of them -
 * and the other three are the ones you press to make something happen.
 */
const DEFAULT_TIER: Record<ButtonVariant, ControlTier> = {
  primary: "content",
  neutral: "content",
  quiet: "chrome",
  danger: "content",
};

export interface ButtonProps extends Omit<ComponentProps<"button">, "className"> {
  readonly variant?: ButtonVariant;
  readonly tier?: ControlTier;
  readonly ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = "neutral", tier, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(BASE_CONTROL, VARIANT_CLASS[variant], TIER_CLASS[tier ?? DEFAULT_TIER[variant]])}
      {...rest}
    />
  );
}

export interface IconButtonProps extends Omit<ComponentProps<"button">, "className" | "children"> {
  /** Required, not optional: an icon-only control with no accessible name is an unlabelled button. */
  readonly label: string;
  readonly children: ReactNode;
  readonly active?: boolean;
  readonly ref?: Ref<HTMLButtonElement>;
}

export function IconButton({ label, children, active = false, type = "button", ...rest }: IconButtonProps) {
  return (
    <Tooltip content={label}>
      <button
        type={type}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          "inline-flex size-control shrink-0 items-center justify-center rounded-sm transition-[color,background-color,transform] duration-(--duration-press) ease-out hover:bg-hover active:scale-[0.97] disabled:text-ink-faint disabled:hover:bg-transparent disabled:active:scale-100",
          active ? "bg-selected text-accent" : "text-ink-dim hover:text-ink",
        )}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * One provider at the root, per decision 10. Radix needs a `Provider` in scope for every `Root`,
 * and mounting one per row is the mistake that makes a tree janky.
 */
export function TooltipProvider({ children }: { readonly children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={TOOLTIP_DELAY_MS} skipDelayDuration={TOOLTIP_SKIP_DELAY_MS}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export function Tooltip({
  content,
  children,
  side = "bottom",
}: {
  readonly content: ReactNode;
  readonly children: ReactNode;
  readonly side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="surface-enter z-tooltip max-w-72 rounded-sm border border-line-strong bg-panel px-2 py-1 text-2xs text-ink shadow-lg shadow-black/40 [transition-duration:var(--duration-tooltip)]"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/**
 * `h-control-lg`, matching `Button`, and that is the whole reason it is not `h-control`. A field
 * and the button that acts on it are one control in the user's head - the URL bar and Send, the
 * search box and its toggle - and 26px beside 30px reads as one of them being broken. 26px stays
 * the height of the chrome tier: icon buttons, quiet buttons, menu items.
 *
 * Split up because the token backdrop sits behind the input and has to agree with it about where a
 * character lands. `METRICS` plus one of the two `PAD`s is the half that decides that, and the join
 * of them is handed to the overlay verbatim; `FILL` moves to the wrapper when there is a backdrop
 * or a lead, because an opaque input has nothing behind it; `INK` is the input's alone.
 */
const FIELD_METRICS = "h-control-lg w-full min-w-0 border text-xs";
/**
 * The horizontal padding, separate from the rest of the metrics because a `lead` changes it.
 *
 * Two exclusive classes rather than one plus an override: `cn` is a join and not a merge, so
 * `px-2` and `pl-8` in the same string would leave which of the two wins to the order Tailwind
 * happened to emit them in - and getting that wrong puts the text under the lead.
 */
const FIELD_PAD = "px-2";
/** `pl-8` is 32px: the 2px the lead is inset by, its 24px square, and 6px of air before the text. */
const FIELD_LEAD_PAD = "pl-8 pr-2";
/** Where a `lead` sits: inside the input's border, vertically centred, hard against its left edge. */
const FIELD_LEAD_CLASS = "absolute inset-y-0 left-0 flex items-center pl-0.5";

/**
 * What a `lead` may be, if it is a button.
 *
 * 24px square: WCAG 2.5.8's minimum target, and the widest thing `FIELD_LEAD_PAD` reserves room
 * for. Exported so the budget and the padding that reserves it cannot drift apart in two files -
 * a lead that outgrows this does not clip, it slides under the text.
 *
 * Not `IconButton`: that is `size-control`, 26px, which does not fit inside a 30px field and is
 * the chrome tier - a thing that acts *on* the pane. A lead acts on the field it is drawn in.
 *
 * Carries no ink, deliberately, the same way `FIELD_METRICS` carries no fill: a lead's colour is
 * what it is *saying*, so the caller declares it and there is only ever one declaration. A
 * `text-*` in here would be a second one, and `cn` joins rather than merges - which of the two won
 * would be decided by the order Tailwind emitted them in.
 */
export const FIELD_LEAD_BUTTON_CLASS =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-sm transition-[color,background-color] duration-(--duration-press) ease-out hover:bg-hover";
const FIELD_FILL = "rounded-sm bg-control";
/**
 * Colour only, and deliberately no `active:scale-*` like `BASE_CONTROL` has: a text field that
 * flinches when you click into it is a text field that moved your caret. Decision 26.
 */
const FIELD_INK =
  "rounded-sm border-line-strong transition-[color,background-color,border-color] duration-(--duration-press) ease-out placeholder:text-ink-faint disabled:text-ink-faint";

const CELL_METRICS = "h-row w-full min-w-0 truncate px-2 text-xs";
const CELL_INK =
  "bg-transparent transition-[color,background-color] duration-(--duration-press) ease-out placeholder:text-ink-faint focus:outline-none";

/**
 * A field's ink, as a closed set rather than a class the caller writes.
 *
 * The two grids both need to say "this value is here and loses" - a disabled header, a shadowed
 * variable - and both used to spell it out in their own class string. One vocabulary, because two
 * spellings of "struck through and dimmed" is how one of them ends up a shade off. It is also the
 * *only* declaration of a field's colour, since `cn` is a join and not a merge: a second one in the
 * base class would leave which of the two wins to the order the stylesheet happens to be in.
 */
const TONE_CLASS = {
  normal: "text-ink",
  /** Present, but not what a run will use: a disabled header, a shadowed variable. */
  struck: "text-ink-faint line-through",
  /** Not present at all. */
  muted: "text-ink-faint",
} as const;

export type FieldTone = keyof typeof TONE_CLASS;

/** For the read-only twin of a field: a grid column that is a `span` and not an `input`. */
export function toneClass(tone: FieldTone): string {
  return TONE_CLASS[tone];
}

export interface FieldProps extends Omit<ComponentProps<"input">, "className"> {
  readonly mono?: boolean;
  readonly ref?: Ref<HTMLInputElement>;
  readonly tone?: FieldTone;
  /**
   * Present only where core interpolates this field's value, per decision 14. Paints `{{token}}`s
   * as pills behind the text and reports the one that was clicked; absent leaves the markup exactly
   * as it was, which is what the rename dialog and the search box want.
   */
  readonly onToken?: TokenReporter;
  /**
   * A control drawn inside the field's own box, against its left edge.
   *
   * For the affordance that is a property *of* the value rather than an action *on* it - the url
   * bar's TLS lock. Beside the field it read as a third control in a row that already has a method
   * picker and a Send; inside it, it reads as the scheme, which is what it edits. The text is
   * padded clear of it, so nothing here overlaps.
   *
   * One 24px square fits, and `FIELD_LEAD_BUTTON_CLASS` is that size. There is no width
   * negotiation: `FIELD_LEAD_PAD` is a constant, so a wider lead slides under the text.
   */
  readonly lead?: ReactNode;
}

/** Uncontrolled by convention: pass `defaultValue` and commit on blur, never `value` per keystroke. */
export function Field({ mono = false, ref, onFocus, onBlur, tone = "normal", onToken, lead, ...rest }: FieldProps) {
  const node = useRef<HTMLInputElement | null>(null);
  const setRef = useCallback(
    (element: HTMLInputElement | null) => {
      node.current = element;
      if (typeof ref === "function") ref(element);
      else if (ref != null) ref.current = element;
    },
    [ref],
  );

  // Read through a ref rather than closed over directly, so `flush` below can hold one identity
  // across renders while still calling the current handler: `registerFlush`/`clearFlush` match by
  // reference, and a caller's inline `onBlur` is a fresh closure on every render.
  const onBlur$ = useRef(onBlur);
  useEffect(() => {
    onBlur$.current = onBlur;
  }, [onBlur]);

  // `Cmd+S` is bound at `window` precisely so no field can swallow it, which also means it never
  // reaches this input to blur it and commit. This is what lets Save ask "what is the caret
  // sitting on right now?" without moving focus off the field to get an answer - the caret stays
  // put, and the same `onBlur` a real blur would have called runs against the live element.
  const flush = useCallback(() => {
    const element = node.current;
    if (element === null) return;
    onBlur$.current?.({ currentTarget: element, target: element } as FocusEvent<HTMLInputElement>);
  }, []);

  // React does not fire `blur` when a focused input is unmounted, so the `onBlur` handler below
  // is not enough on its own: switching tab or sub-tab with the caret in a field would leave this
  // flush registered, holding a detached element and the *old* tab's `onBlur`. The next `Cmd+S`
  // would then write that field into whichever tab it captured. Cleared, never committed -
  // `CodeEditor` commits on teardown because losing a script is losing an afternoon, while
  // committing a vanished field's last keystroke into another request is the bug, not the save.
  useEffect(() => () => clearFlush(flush), [flush]);

  const pills = useTokenPills(initialText(rest.defaultValue), onToken);
  // One string, handed to both the input and the backdrop, so the lead's inset moves the pills with
  // the text by construction rather than by two call sites agreeing about a number.
  const metrics = cn(FIELD_METRICS, lead === undefined ? FIELD_PAD : FIELD_LEAD_PAD, mono && "font-mono");
  const boxed = onToken !== undefined || lead !== undefined;

  const input = (
    <input
      ref={setRef}
      className={cn(metrics, FIELD_INK, TONE_CLASS[tone], boxed ? "bg-transparent" : FIELD_FILL)}
      spellCheck={false}
      onFocus={(event) => {
        registerFlush(flush);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        clearFlush(flush);
        onBlur?.(event);
      }}
      onInput={pills.onInput}
      onScroll={pills.onScroll}
      onMouseUp={pills.onMouseUp}
      {...rest}
    />
  );

  if (!boxed) return input;

  // The fill moves out here so the backdrop has somewhere to be seen from. `border-transparent` on
  // the overlay rather than no border at all: the input's 1px border insets its text by 1px, and a
  // backdrop that skips it is a backdrop one pixel to the left.
  //
  // The input keeps its own border, rounding and therefore its `:focus-visible` outline, so the
  // ring still hugs the whole field including the lead. And the lead is rendered *after* the input,
  // never before: `follow()` in `TokenOverlay.tsx` reaches the backdrop as the input's
  // `previousElementSibling`, so anything inserted ahead of the input silently breaks the
  // horizontal scroll sync on a long value.
  return (
    <span className={cn("relative block w-full min-w-0", FIELD_FILL)}>
      {onToken === undefined ? null : (
        <TokenOverlay value={pills.value} className={cn(metrics, "border-transparent")} />
      )}
      {input}
      {lead === undefined ? null : <span className={FIELD_LEAD_CLASS}>{lead}</span>}
    </span>
  );
}

/**
 * A borderless input for grid cells. The border is dropped because forty bordered cells in a
 * column is a wall, and the row's own hairline already says where the cell ends.
 */
export function CellField({ mono = true, tone = "normal", onToken, ...rest }: FieldProps) {
  const pills = useTokenPills(initialText(rest.defaultValue), onToken);
  const metrics = cn(CELL_METRICS, mono && "font-mono");

  const input = (
    <input
      className={cn(metrics, CELL_INK, TONE_CLASS[tone], onToken === undefined && "focus:bg-control")}
      spellCheck={false}
      onInput={pills.onInput}
      onScroll={pills.onScroll}
      onMouseUp={pills.onMouseUp}
      {...rest}
    />
  );

  if (onToken === undefined) return input;

  // `focus-within` on the wrapper rather than `focus` on the input: the focus fill has to be behind
  // the pills, and the pills are behind the input.
  return (
    <span className="relative block w-full min-w-0 focus-within:bg-control">
      <TokenOverlay value={pills.value} className={metrics} />
      {input}
    </span>
  );
}

/** Colour only, for the same reason as `FIELD_INK`: this is a field-shaped control, not a button. */
const SELECT_TRIGGER_CLASS =
  "inline-flex cursor-default select-none items-center gap-1 rounded-sm border border-line-strong bg-control pr-1 pl-2 text-xs text-ink outline-none transition-[color,background-color,border-color] duration-(--duration-press) ease-out data-placeholder:text-ink-faint data-disabled:text-ink-faint";

/**
 * The popup is a menu, because to the user it is one.
 *
 * Same surface, same radius, same hairline and same shadow as `Menu`'s `CONTENT_CLASS`, and the
 * items are `Menu`'s `ITEM_CLASS` with the icon column moved to the right of the label. A select
 * popup that looked like its own kind of surface would teach the user there are two kinds of
 * floating list in this app, and there are not.
 *
 * `--radix-select-trigger-width` as a floor rather than a width: the trigger holding `GET` must
 * not clip `DELETE`, but a wide trigger should not be re-flowed by a narrow list either.
 */
const SELECT_CONTENT_CLASS =
  "surface-enter z-menu min-w-[var(--radix-select-trigger-width)] rounded-md border border-line-strong bg-panel p-1 shadow-lg shadow-black/40";

const SELECT_VIEWPORT_CLASS = "max-h-[var(--radix-select-content-available-height)]";

/**
 * No transition here, and none on `Menu`'s `ITEM_CLASS` either. `data-highlighted` follows the
 * pointer down a list at whatever speed the pointer moves, and 120ms of lag on it reads as the list
 * failing to keep up rather than as polish. Decision 26.
 */
const SELECT_ITEM_CLASS =
  "flex h-control cursor-default select-none items-center gap-4 rounded-sm px-2 text-xs text-ink outline-none data-highlighted:bg-hover data-disabled:text-ink-faint";

export interface SelectProps {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly children: ReactNode;
  readonly mono?: boolean;
  /** A select is the control that turns up in both tiers most often, so it always declares one. */
  readonly tier?: ControlTier;
  readonly disabled?: boolean;
  /**
   * Lands on the trigger, which is a `<button>` and therefore a labelable element. Without it a
   * `Labelled` cannot point at a select, and the caller ends up writing its own label markup — which
   * is how the app grew a second label language once already.
   */
  readonly id?: string;
  /**
   * Fills its parent instead of sizing to its value. For a picker in a form column, where the field
   * above it is full width and a trigger that resizes as the value changes reads as a bug.
   */
  readonly full?: boolean;
  /** Required, not optional, for the same reason `IconButton` requires one: there is no label. */
  readonly "aria-label": string;
}

/**
 * On Radix, which decision 9 sanctions, because a native `<select>` cannot be styled where it
 * matters. The closed control took the app's tokens; the open list was drawn by the OS, so the
 * one moment the control is doing its job was the one moment it stopped looking like this app.
 * That is the trade decision 9 anticipated: the popup is worth re-earning keyboard behaviour for,
 * `Field` is not - a text input's "popup" is the caret, and the OS draws that fine.
 *
 * Sizes to its content rather than filling its parent: a picker holding the word `GET` has
 * no business being as wide as the URL beside it. `full` is the one other answer, because `w-fit`
 * on the trigger is not something a wrapper can talk it out of; any width between the two is the
 * caller's wrapper, which is why `className` is not accepted here.
 */
export function Select({
  value,
  onValueChange,
  children,
  mono = false,
  tier = "content",
  disabled = false,
  id,
  full = false,
  "aria-label": label,
}: SelectProps) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        id={id}
        aria-label={label}
        // A branch rather than `w-fit` plus an override, because `cn` concatenates and does not
        // merge: which of two width utilities won would be decided by their order in the generated
        // stylesheet, which is not a thing this call site can see.
        className={cn(SELECT_TRIGGER_CLASS, TIER_CLASS[tier], mono && "font-mono", full ? "w-full" : "w-fit")}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon className={GLYPH_CLASS}>
          <PickerIcon />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        {/* `popper`, not the default `item-aligned`: item-aligned overlays the trigger the way a
            macOS select does, and every other floating list here drops below its trigger. */}
        <SelectPrimitive.Content
          position="popper"
          side="bottom"
          sideOffset={4}
          className={cn(SELECT_CONTENT_CLASS, mono && "font-mono")}
        >
          <SelectPrimitive.Viewport className={SELECT_VIEWPORT_CLASS}>{children}</SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export interface SelectOptionProps {
  readonly value: string;
  readonly children: ReactNode;
  readonly disabled?: boolean;
}

/**
 * The tick is on the right and the label is not indented for it.
 *
 * A reserved left column would align these labels with `DropdownItem`'s icons, but the icon in a
 * menu names the action and the tick here only marks the row you are already on - and the list is
 * short enough to see at a glance. Indenting `GET` by an icon width to make room for a mark that
 * is present once costs more than it says.
 */
export function SelectOption({ value, children, disabled = false }: SelectOptionProps) {
  return (
    <SelectPrimitive.Item value={value} disabled={disabled} className={SELECT_ITEM_CLASS}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="ml-auto text-accent">
        <CheckIcon />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

/**
 * What a form label looks like, exported so that a group of controls with no single labelable
 * element — a radio group, which is labelled by `aria-label` on the group rather than by `for` —
 * can wear the same one without `Labelled` growing an arm for it.
 */
/**
 * Mirrored from `Menu.tsx`, per the floating-surface rule: a new floating list copies those
 * constants rather than inventing a surface. Both content classes are `p-1`, so the negative
 * margin reaches the popup's edges here exactly as it does there.
 */
const SELECT_SEPARATOR_CLASS = "-mx-1 my-1 h-px bg-line";

/**
 * `Menu.tsx`'s `ITEM_CLASS` verbatim, which is `SELECT_ITEM_CLASS` with a smaller gap. The
 * difference is the point: the wide gap in a select item holds a label away from a tick on the
 * far right, while this gap holds a label next to the icon that names it — and a row that acts
 * like a menu item should measure like one.
 */
const SELECT_COMMAND_CLASS =
  "flex h-control cursor-default select-none items-center gap-2 rounded-sm px-2 text-xs text-ink outline-none data-highlighted:bg-hover";

/** A rule between groups of options. Radix skips it in keyboard navigation; it is decoration. */
export function SelectSeparator() {
  return <SelectPrimitive.Separator className={SELECT_SEPARATOR_CLASS} />;
}

export interface SelectCommandProps {
  /** A sentinel the owner recognises and refuses to store, since this row is not a value. */
  readonly value: string;
  readonly icon: ReactNode;
  readonly children: ReactNode;
}

/**
 * A row that does something instead of being one of the answers.
 *
 * It is a `SelectPrimitive.Item` because that is the only child Radix will let the keyboard
 * reach, and it wears an icon and no tick because those are the two marks that say which kind
 * of row this is: the tick is the select's word for "the one you are on", and a row that can
 * never be the one you are on must not be able to show it. The owner is expected to keep it
 * last and behind a `SelectSeparator`, so the accidental press it invites is a press on a
 * dialog's Cancel rather than on a silently changed value.
 */
export function SelectCommand({ value, icon, children }: SelectCommandProps) {
  return (
    <SelectPrimitive.Item value={value} className={SELECT_COMMAND_CLASS}>
      {icon}
      {/* Radix reads an item's typeahead text from here, so the label is inside it and the icon is not. */}
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export const LABEL_CLASS = "text-2xs text-ink-dim";

/**
 * A labelled block. Label above, helper below, per the form rules: a placeholder is not a label,
 * because it disappears exactly when the user needs to check what they typed.
 */
export function Labelled({
  label,
  hint,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly htmlFor: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className={LABEL_CLASS}>
        {label}
      </label>
      {children}
      {hint !== undefined && <p className="text-2xs text-ink-faint">{hint}</p>}
    </div>
  );
}
