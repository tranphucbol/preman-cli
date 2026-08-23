# 009: shadcn on Radix, fenced — and density retuned before any screen is built

Status: Accepted

## Decision

Take from shadcn/ui, on Radix: `DropdownMenu`, `ContextMenu`, `Dialog`, `AlertDialog`, `Popover`,
`Select`, `Tabs`, `Collapsible`, `Command`, `Sonner`.

Refuse: `Table`, `Form`, `ScrollArea`, and `Accordion` for the tree.

Nothing from shadcn is ever mounted per row.

Retune the density tokens before building the first screen, not after.

## Rationale

What shadcn is good at is the accessible-primitive problem: focus traps, roving tabindex, escape
handling, portalled positioning that survives a scroll. Those are weeks of work to get right and
are invisible when they are right.

What it is bad at here is anything that owns a list. `Table` and `ScrollArea` cannot virtualize,
and `Accordion` mounts every panel — used for the tree, they would each independently break the
5000-node scroll budget. The tree, the key/value grids and the body viewer are hand-built over
TanStack Virtual instead.

"Nothing per row" is the rule that keeps the two halves apart: a `DropdownMenu` per sidebar row is
five thousand Radix instances. One menu, positioned at the row that asked for it.

Density is listed as a decision rather than a task because retuning it afterwards is not a
find-and-replace. Postman is 2-4px radii, 26-28px control heights and 12-13px text. shadcn ships
`--radius: 0.625rem` and `h-9`. Building screens against the defaults and then compressing them
means every hand-tuned spacing relationship in every screen shifts at once.

## Consequences

Components are vendored, not imported from a package, so upgrading is a manual diff. That is the
usual shadcn trade and it is what makes the density retune possible at all.

Two conventions have to hold or the fence leaks: a new list is virtualized, and a new per-row
affordance is hoisted to a single instance.
