/**
 * Buttons, inputs and tooltips at tool density.
 *
 * Every control here is 26px or 30px tall against a 13px body size. That is the retune decision 11
 * calls for, and it is why no component library ships this: 26px is uncomfortably small for a
 * marketing page and exactly right for a pane you keep open all day.
 *
 * `Field` and `Select` are native elements on purpose. A styled `<div role="combobox">` has to
 * re-earn keyboard behaviour, form association and the OS focus ring that `<select>` gets free,
 * and decision 10 refuses shadcn `Form` for the same reason: uncontrolled inputs that commit on
 * blur are what keeps keystroke-to-paint under 8ms with forty header rows.
 */
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ComponentProps, ReactNode, Ref } from "react";

import { cn } from "./cn.js";

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

const INPUT_CLASS =
  "h-control w-full min-w-0 rounded-sm border border-line-strong bg-control px-2 text-xs text-ink placeholder:text-ink-faint disabled:text-ink-faint";

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

export interface SelectProps extends Omit<ComponentProps<"select">, "className"> {
  readonly mono?: boolean;
  readonly ref?: Ref<HTMLSelectElement>;
}

/**
 * Sizes to its content rather than filling its parent: a picker holding the word `GET` has
 * no business being as wide as the URL beside it. Callers that need a different width wrap
 * it, which is also why `className` is not accepted here.
 */
export function Select({ mono = false, ...rest }: SelectProps) {
  return (
    <select
      className={cn(
        "h-control cursor-default rounded-sm border border-line-strong bg-control px-1.5 text-xs text-ink",
        mono && "font-mono",
      )}
      {...rest}
    />
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
