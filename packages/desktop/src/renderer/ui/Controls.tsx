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
import type { ComponentProps, ReactNode, Ref } from "react";

import { cn } from "./cn.js";
import { CheckIcon, GLYPH_CLASS, PickerIcon } from "./icons.js";

const TOOLTIP_DELAY_MS = 400;

const BASE_CONTROL =
  "inline-flex select-none items-center justify-center gap-1.5 rounded-sm text-xs whitespace-nowrap transition-none disabled:text-ink-faint";

const VARIANT_CLASS = {
  /** The accent is a fill exactly once per pane: the thing you came here to press. */
  primary: "h-control-lg bg-accent px-3 font-medium text-canvas hover:bg-accent/85 disabled:bg-control",
  neutral: "h-control-lg border border-line-strong bg-control px-3 text-ink hover:bg-hover",
  quiet: "h-control px-2 text-ink-dim hover:bg-hover hover:text-ink",
  danger: "h-control-lg border border-danger/40 px-3 text-danger hover:bg-danger/15",
} as const;

export type ButtonVariant = keyof typeof VARIANT_CLASS;

export interface ButtonProps extends Omit<ComponentProps<"button">, "className"> {
  readonly variant?: ButtonVariant;
  readonly ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = "neutral", type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={cn(BASE_CONTROL, VARIANT_CLASS[variant])} {...rest} />;
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
          "inline-flex size-control shrink-0 items-center justify-center rounded-sm hover:bg-hover disabled:text-ink-faint disabled:hover:bg-transparent",
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
  return <TooltipPrimitive.Provider delayDuration={TOOLTIP_DELAY_MS}>{children}</TooltipPrimitive.Provider>;
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
          className="z-tooltip max-w-72 rounded-sm border border-line-strong bg-panel px-2 py-1 text-2xs text-ink shadow-lg shadow-black/40"
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
 */
const INPUT_CLASS =
  "h-control-lg w-full min-w-0 rounded-sm border border-line-strong bg-control px-2 text-xs text-ink placeholder:text-ink-faint disabled:text-ink-faint";

export interface FieldProps extends Omit<ComponentProps<"input">, "className"> {
  readonly mono?: boolean;
  readonly ref?: Ref<HTMLInputElement>;
}

/** Uncontrolled by convention: pass `defaultValue` and commit on blur, never `value` per keystroke. */
export function Field({ mono = false, ...rest }: FieldProps) {
  return <input className={cn(INPUT_CLASS, mono && "font-mono")} spellCheck={false} {...rest} />;
}

/**
 * A borderless input for grid cells. The border is dropped because forty bordered cells in a
 * column is a wall, and the row's own hairline already says where the cell ends.
 */
export function CellField({ mono = true, ...rest }: FieldProps) {
  return (
    <input
      className={cn(
        "h-row w-full min-w-0 bg-transparent px-2 text-xs text-ink placeholder:text-ink-faint focus:bg-control",
        mono && "font-mono",
      )}
      spellCheck={false}
      {...rest}
    />
  );
}

/**
 * The two heights a select comes in, named for the row it belongs to rather than for its size.
 *
 * A select is the one control that turns up in both tiers, which is why it is the one that has to
 * say which. `content` is 30px, matching `Button` and `Field`, for a picker that is part of the
 * thing being edited: the method beside the URL and Send. `chrome` is 26px, matching `IconButton`
 * and a `quiet` button, for a picker in a strip of chrome - where 30px makes it the tallest thing
 * in a row it is not the subject of.
 */
const SELECT_TIER = {
  content: "h-control-lg",
  chrome: "h-control",
} as const;

export type SelectTier = keyof typeof SELECT_TIER;

const SELECT_TRIGGER_CLASS =
  "inline-flex w-fit cursor-default select-none items-center gap-1 rounded-sm border border-line-strong bg-control pr-1 pl-2 text-xs text-ink outline-none data-placeholder:text-ink-faint data-disabled:text-ink-faint";

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
  "z-menu min-w-[var(--radix-select-trigger-width)] rounded-md border border-line-strong bg-panel p-1 shadow-lg shadow-black/40";

const SELECT_VIEWPORT_CLASS = "max-h-[var(--radix-select-content-available-height)]";

const SELECT_ITEM_CLASS =
  "flex h-control cursor-default select-none items-center gap-4 rounded-sm px-2 text-xs text-ink outline-none data-highlighted:bg-hover data-disabled:text-ink-faint";

export interface SelectProps {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly children: ReactNode;
  readonly mono?: boolean;
  readonly tier?: SelectTier;
  readonly disabled?: boolean;
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
 * no business being as wide as the URL beside it. Callers that need a different width wrap
 * it, which is also why `className` is not accepted here.
 */
export function Select({
  value,
  onValueChange,
  children,
  mono = false,
  tier = "content",
  disabled = false,
  "aria-label": label,
}: SelectProps) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        aria-label={label}
        className={cn(SELECT_TRIGGER_CLASS, SELECT_TIER[tier], mono && "font-mono")}
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
      <label htmlFor={htmlFor} className="text-2xs text-ink-dim">
        {label}
      </label>
      {children}
      {hint !== undefined && <p className="text-2xs text-ink-faint">{hint}</p>}
    </div>
  );
}
