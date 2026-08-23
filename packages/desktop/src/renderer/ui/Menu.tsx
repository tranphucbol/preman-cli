/**
 * Menus, on Radix, retuned.
 *
 * Radix ships behaviour (focus trapping, typeahead, collision flipping, Escape) and no opinion
 * about size. shadcn's defaults are the wrong size for this app by roughly a third: `h-9` items
 * and a 10px radius belong to a marketing dashboard, not to a tool whose rows are 28px. The
 * classes here are the retune decision 11 asks for, kept in one place so a menu cannot drift from
 * a menu.
 *
 * Both flavours share `ITEM_CLASS` because a right-click menu and a caret menu that look different
 * teach the user there are two kinds of menu, and there are not.
 */
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "./cn.js";

const CONTENT_CLASS = "z-menu min-w-44 rounded-md border border-line-strong bg-panel p-1 shadow-lg shadow-black/40";

const ITEM_CLASS =
  "flex h-control cursor-default select-none items-center gap-2 rounded-sm px-2 text-xs text-ink outline-none data-highlighted:bg-hover data-disabled:text-ink-faint";

/** A destructive item is coloured, not iconless: colour alone is not an affordance. */
const DANGER_ITEM_CLASS = "text-danger data-highlighted:bg-danger/15 data-highlighted:text-danger";

const SEPARATOR_CLASS = "-mx-1 my-1 h-px bg-line";

const SHORTCUT_CLASS = "ml-auto font-mono text-2xs text-ink-faint";

const LABEL_CLASS = "flex h-control items-center px-2 text-2xs tracking-wide text-ink-faint";

export interface MenuItemProps {
  readonly children: ReactNode;
  readonly icon?: ReactNode;
  readonly shortcut?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

/** The dropdown flavour: a caret button that owns its menu. */
export function DropdownMenu({ children }: { readonly children: ReactNode }) {
  return <DropdownMenuPrimitive.Root>{children}</DropdownMenuPrimitive.Root>;
}

export function DropdownTrigger({ children, ...rest }: ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return (
    <DropdownMenuPrimitive.Trigger {...rest} asChild>
      {children}
    </DropdownMenuPrimitive.Trigger>
  );
}

export function DropdownContent({
  children,
  align = "start",
  side = "bottom",
}: {
  readonly children: ReactNode;
  readonly align?: "start" | "center" | "end";
  readonly side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content align={align} side={side} sideOffset={4} className={CONTENT_CLASS}>
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownItem({ children, icon, shortcut, danger, disabled, onSelect }: MenuItemProps) {
  return (
    <DropdownMenuPrimitive.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(ITEM_CLASS, danger && DANGER_ITEM_CLASS)}
    >
      {icon}
      {children}
      {shortcut !== undefined && <span className={SHORTCUT_CLASS}>{shortcut}</span>}
    </DropdownMenuPrimitive.Item>
  );
}

export function DropdownSeparator() {
  return <DropdownMenuPrimitive.Separator className={SEPARATOR_CLASS} />;
}

export function DropdownLabel({ children }: { readonly children: ReactNode }) {
  return <DropdownMenuPrimitive.Label className={LABEL_CLASS}>{children}</DropdownMenuPrimitive.Label>;
}

/**
 * The context flavour, mounted ONCE per surface rather than once per row.
 *
 * `ContextTrigger` wraps a whole scroll viewport. Which row was hit is read off the event target by
 * the caller, not by mounting five thousand Radix roots. That is the difference between a tree that
 * scrolls at 60fps and Postman.
 */
export function ContextMenu({
  children,
  onOpenChange,
}: {
  readonly children: ReactNode;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  return <ContextMenuPrimitive.Root onOpenChange={onOpenChange}>{children}</ContextMenuPrimitive.Root>;
}

export function ContextTrigger({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <ContextMenuPrimitive.Trigger className={className}>{children}</ContextMenuPrimitive.Trigger>;
}

export function ContextContent({ children }: { readonly children: ReactNode }) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content className={CONTENT_CLASS}>{children}</ContextMenuPrimitive.Content>
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextItem({ children, icon, shortcut, danger, disabled, onSelect }: MenuItemProps) {
  return (
    <ContextMenuPrimitive.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(ITEM_CLASS, danger && DANGER_ITEM_CLASS)}
    >
      {icon}
      {children}
      {shortcut !== undefined && <span className={SHORTCUT_CLASS}>{shortcut}</span>}
    </ContextMenuPrimitive.Item>
  );
}

export function ContextSeparator() {
  return <ContextMenuPrimitive.Separator className={SEPARATOR_CLASS} />;
}
