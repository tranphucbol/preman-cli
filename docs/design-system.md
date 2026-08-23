# preman design system

`packages/desktop/src/renderer/app.css` is the design system. It holds every token and, in its
comments, the reason each value is what it is. This file does not repeat it. This file answers the
question a token list cannot: **which token do I reach for, and what breaks if I reach for the
wrong one.**

It exists because four bugs shipped in one screen from the same cause — one token doing five jobs,
with nothing written down to say it should not. Every rule below is one of those bugs, generalised.

The CLI has no design system. It has `packages/cli/src/render/` and picocolors, and none of this
applies to it.

## The one rule

**A container is sized by the tallest control it holds. A control is sized by the tier it is in.**

Everything else here is that sentence applied to a particular place.

## Control tiers

Two heights, and a control belongs to a tier by what it is for, never by where it fits.

| Tier        | Token                  | Height | Default for                                               |
| ----------- | ---------------------- | ------ | --------------------------------------------------------- |
| **content** | `--spacing-control-lg` | 30px   | `Button` primary/neutral/danger, `Field`, `Select`        |
| **chrome**  | `--spacing-control`    | 26px   | `Button` quiet, `IconButton` (`size-control`), menu items |
| **row**     | `--spacing-row`        | 28px   | `CellField`, and every virtualized list row               |

Content tier is the thing you came to the pane to operate: the URL, the method, Send. Chrome tier
is everything that acts on the pane rather than being it: toolbars, menus, icon affordances.

Size and paint are separate axes. `Button` and `Select` both take `tier`, and the table above is
only what they do when the caller says nothing; a `neutral` button in a pane toolbar is
`tier="chrome"`, and it is still a `neutral` button. `Field` has no `tier`, because a text input
is always the content it edits.

**Never mix tiers in one row.** A 26px field beside a 30px button is the first bug: they read as
one control, and one of them looks broken.

## Chrome rows

A chrome row is a full-width strip of controls with a hairline. There are two, and which one you
use is decided entirely by the tier of the tallest control inside it.

| Token           | Height | Holds                  | Air per side |
| --------------- | ------ | ---------------------- | ------------ |
| `--spacing-tab` | 32px   | 26px controls, or text | 3px          |
| `--spacing-bar` | 40px   | 30px controls          | 5px          |

Putting a 30px control in `h-tab` leaves 1px top and bottom. That is bugs two and three, and it is
not a judgement call — it is arithmetic.

Current assignment, which is the audit as much as the rule:

- `h-bar` — the title bar (`App.tsx`), and only that. It is the row the macOS traffic lights are
  centred in, which is what fixes its height; `TITLE_BAR_HEIGHT_PX` mirrors the token.
- `h-tab` — everything else: the tab bar and sidebar header and status bar (`App.tsx`), the
  breadcrumb and the message and body toolbars (`RequestEditor`), `KeyValueGrid`, `RunnerPane`,
  `VariablesPane`, `ConsoleDrawer`, both `BodyViewer` strips, and the sub-tab triggers in
  `RequestEditor` and `ResponsePane`, which are text and take the shorter row.

That `h-bar` has one caller is the rule working, not a token going spare: a pane toolbar that
wanted `h-bar` was a toolbar that had not been asked which tier its buttons were in.

One row is neither, on purpose: the request bar (`RequestEditor.tsx:142`) is `px-gutter py-2`
around a 30px field, so 46px. It is the only row in the app that is the subject of its pane rather
than chrome around one, and it is allowed the extra 6px for exactly that reason. Do not add a
second exception without deciding it is one.

## Virtualized rows

A list that can be long is virtualized, per decision 9, and its row height is a TypeScript constant
because TanStack Virtual needs the number, not the class.

| List                                | Height | Why not 28                   |
| ----------------------------------- | ------ | ---------------------------- |
| Sidebar, Variables, Console, Runner | 28px   | `--spacing-row`              |
| `CommandPalette`                    | 34px   | two lines of text in one row |
| `SearchPane`                        | 44px   | a match plus its file path   |

The two that are not 28 are not drift: both hold more than one line. A new list that holds one line
uses 28 and mirrors `--spacing-row`.

## Ink and surfaces

Five surfaces, darkest to lightest, and each has one job.

| Token         | Use it for                                                           |
| ------------- | -------------------------------------------------------------------- |
| `bg-canvas`   | the window itself, and the two chrome rows that belong to the window |
| `bg-panel`    | a pane that sits on the window, and every floating surface           |
| `bg-control`  | the fill of an input, a select or a neutral button                   |
| `bg-hover`    | pointer hover, and a highlighted menu item                           |
| `bg-selected` | the selected row — tinted toward the accent, not a lighter grey      |

Three ink tiers, all of which clear 4.5:1 on all five surfaces. `text-ink` is content,
`text-ink-dim` is a label, `text-ink-faint` is metadata you still have to read: durations, byte
counts, paths.

**`text-glyph` is never text.** It clears 3:1, which is WCAG 1.4.11 for a non-text control and is
below AA for anything with words in it. It is for carets, drag handles, the select's own caret, and
a border that is a control's only affordance. `GLYPH_CLASS` in `ui/icons.ts` is the same value
named for that use. If you are about to put `text-glyph` on a string, you want `text-ink-faint`.

`--color-accent` has no dimmed variant, deliberately: the one that used to exist read at 2.5:1.
The accent is a fill exactly once per pane — the thing you came there to press.

The `--color-method-*` tokens are keyed by verb, and so is the one function that reads them:
`methodClass()` in `ui/method.ts`. Never write `text-method-get` at a call site. The sidebar, the
tab strip and the method picker all show the same verb within a few hundred pixels of each other,
and three copies of the map is how one of them ends up a shade off.

## Floating surfaces

Menus, select popups, dialogs and tooltips are one visual family, and they look alike because to
the user they are alike. `Menu.tsx` holds `CONTENT_CLASS` and `ITEM_CLASS`; `Controls.tsx` mirrors
them for the select popup. A new floating list copies those two constants rather than inventing a
surface.

| Layer                         | Token       |
| ----------------------------- | ----------- |
| sticky pane chrome            | `z-chrome`  |
| resize handles                | `z-handle`  |
| the sidebar drag preview      | `z-drag`    |
| menus, select popups, dialogs | `z-menu`    |
| tooltips                      | `z-tooltip` |

The scale is closed. An arbitrary `z-50` at the point of pain is how a tool ends up with a dropdown
behind a drawer. `z-chrome` is currently unused; it is kept because a sticky pane header is the
obvious next thing and it should not be invented at 10 by hand.

Tooltips clear menus because a tooltip explaining a menu item has to. The drag preview sits _below_
menus because the two are never on screen at once: a drag begins on pointer-down, which closes any
open menu.

## The sidebar column invariant

`Sidebar.tsx` draws every row as the same three columns, and the invariant is that **every name
starts at the same x**, whatever kind of node it is.

| Constant             | Value | What it is                                                               |
| -------------------- | ----- | ------------------------------------------------------------------------ |
| `INDENT_PX`          | 12    | one level of nesting                                                     |
| `LEAD_COLUMN_PX`     | 64    | one right-aligned column: caret + folder for a group, verb for a request |
| `GIT_COLUMN_PX`      | 10    | the dirty marker, on the far right                                       |
| `DROP_LINE_INSET_PX` | 16    | where a drop indicator starts, so it does not span the lead column       |

The lead column is **one** column, right-aligned. It was two — a caret column then a verb column —
and that is bug four: a group's caret sat a full `DELETE` width from its own folder icon. Anything
that adds a per-row affordance goes inside the existing column or the invariant is gone.

## Tokens mirrored in TypeScript

A token that a layout engine or the main process needs cannot live only in CSS. These are the
duplicates. **Changing one side without the other is a silent bug**, because nothing type-checks
across the boundary.

| CSS token        | TypeScript                                                                | Read by                                            |
| ---------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| `--spacing-row`  | `ROW_HEIGHT` in `Sidebar`, `VariablesPane`, `RunnerPane`, `ConsoleDrawer` | TanStack Virtual's `estimateSize`                  |
| `--spacing-bar`  | `TITLE_BAR_HEIGHT_PX` in `preload/bridge.ts`                              | `main/main.ts`, to centre the macOS traffic lights |
| `--z-index-drag` | `DRAG_Z_INDEX` in `Sidebar.tsx`                                           | the drag preview's inline style                    |

`TITLE_BAR_GUTTER_PX = 76` in `bridge.ts` is not mirrored — it is the horizontal room the traffic
lights need, and only the title bar's padding depends on it.

## What this system does not have

- **A light theme.** Not "dark by default": there is no second palette and no OS following. A
  request tool that repaints itself at sunset changed under the user's hands mid-debug.
- **A spacing scale of its own.** Tailwind's default 4px scale is used as-is for padding and gaps.
  Only the named `--spacing-*` tokens above are ours, and they are heights, not spacing.
- **Motion.** Hover and press transitions, and nothing else moves. `prefers-reduced-motion` is
  honoured once in the base layer rather than per component, which is affordable precisely because
  there is so little to honour.
- **A component library boundary.** shadcn components are vendored and retuned, per decision 9.
  There is no `@preman/ui` package and there should not be one for a single consumer.

## Changing this system

Adding a token is cheap. Adding a _tier_ is not: the tier list above is short so that "which one"
is answerable without reading the call site, and a third height makes every existing answer a
judgement call again.

If a change retunes density app-wide, or reverses a stance recorded in `docs/decisions/`, it is an
ADR, not an edit to this file. This file records what the system currently is; the ADRs record what
it cost to get there.
