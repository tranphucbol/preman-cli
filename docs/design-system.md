# preman design system

`packages/desktop/src/renderer/app.css` is the design system. It names every token and, in its
comments, the reason each value is what it is. What a token _resolves to_ is another matter: colours
come from `renderer/appearance/themes/` and heights from `renderer/appearance/density.ts`, and
`appearance/apply.ts` is the one module that writes either onto the document. This file does not
repeat any of it. It answers the question a token list cannot: **which token do I reach for, and
what breaks if I reach for the wrong one.**

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
| **row**     | `--spacing-row`        | 28px   | `CellField`, every virtualized list row, the phase rail   |

Every height in this file is the `default` density. Two other presets exist, and the tiers hold in
all three — that is what makes them presets rather than three designs. `appearance/density.ts` has
the numbers; decision 21 has the reason.

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
not a judgement call — it is arithmetic. The air is what the presets preserve: `tab` is always
`control + 6` and `bar` is always `control-lg + 10`, in every density.

Current assignment, which is the audit as much as the rule:

- `h-bar` — the title bar (`App.tsx`), and only that. It is the row the macOS traffic lights are
  centred in, which is why a density change has to reach the main process at all; see decision 21.
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

A list that can be long is virtualized, per decision 9, and its row height is read as a number
rather than a class, because TanStack Virtual needs the number.

| List                                | Height | Derivation                                  |
| ----------------------------------- | ------ | ------------------------------------------- |
| Sidebar, Variables, Console, Runner | 28px   | `useDensityTokens().row`                    |
| `CommandPalette`                    | 34px   | `paletteRowHeight()` — `row + 6`, two lines |
| `SearchPane`                        | 44px   | `searchRowHeight()` — `row + 16`, plus path |

The two that are not `row` are not drift: both hold more than one line, and both say so as
arithmetic on `row` rather than as a second constant. A new list that holds one line reads
`row` directly.

The Console is the one whose height is an estimate rather than a fact. A collapsed row is `row`,
and an expanded call row holds the request and response it logged — many lines of it. That is why
every row in the drawer carries `measureElement`: `estimateSize` places the row and the measurement
corrects it, so a list of mostly-collapsed rows still scrolls off the estimate. A list whose rows
are all one line does not need the ref and should not carry it.

A virtualized list has one more obligation: `useRemeasure(virtualizer, rowHeight)` from
`stores/appearance.ts`. TanStack caches measurements, so a changed `estimateSize` closure alone
leaves the list at the old height until something else invalidates it.

## Vertical selection lists

A vertical list with one current entry takes the **row** tier and the sidebar's paint —
`bg-selected` for the current one, `bg-hover` under the pointer — and not the horizontal sub-tab's
accent underline. The Scripts phase rail (`ScriptsPane` in `RequestEditor.tsx`) is a Radix tab list
and still follows this rule, because it is read as a list. The create dialog's type list
(`ui/Dialog.tsx`) is three native radios and follows it too, and adds the one glyph the rule does not
name: `SelectOption`'s tick, on the right, in the accent. Two visual languages for "this is the
current one" inside one pane is the confusion; picking by orientation rather than by widget is what
stops it.

A radio group in a **grid** is the other shape, and it is a card: `rounded-md border p-2`,
`border-accent bg-selected` when on, `border-line-strong bg-control hover:bg-hover` when off — the
`Choice` in `panes/SettingsPane.tsx`. Both are a native `<input type="radio">` inside a `<label>`
with `sr-only` on the input and `has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-accent` on the
label, because that is what buys arrow keys and the roving tab stop for free. Share the mechanism,
not the markup: one component with a layout prop puts "which one" back in the caller's hands.

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

Those five surfaces and three tiers are now the same five and three in forty-three themes, which
means the sentence above stopped being a description of one palette and became a constraint on all
of them. `packages/desktop/scripts/audit.ts` states it as arithmetic — the ink tiers against the
worst of the five surfaces, the surfaces monotonically stepping away from the ink, the six verbs
pairwise distinct in OKLab, every syntax colour readable on canvas and panel, `--syntax-template`
far enough from `string`, `number` and `property` that a `{{token}}` never reads as one of them — and
`test/renderer/themes.test.ts` runs it over every committed theme. A theme is not a set of
preferences; it is a set of numbers that pass. Decision 20 is why.

What that buys the rules below: they still hold. `text-glyph` clears 3:1 in every theme because the
generator solves for it rather than reading it, and the method colours stay six recognisably
different things because the generator repairs them until they are.

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

The 36 `--syntax-*` tokens belong to the editor, and 35 of them are a Lezer tag: `ui/highlight.ts`
is the whole map, and `test/renderer/appearance.test.ts` asserts it is exhaustive. The thirty-sixth,
`--syntax-template`, has no tag because `{{token}}` is not a language construct — `ui/template.ts`
paints it with a decoration, and the audit holds it further from `string`, `number` and `property`
than any two verbs have to be from each other, because it sits on the same line as all three.
Decision 23 is why.

`--syntax-template` is now the token for a `{{token}}` **wherever one is editable**, not only in the
editor, and `ui/template.ts` exports it as `TOKEN_COLOR` so there is one declaration of it. A plain
field cannot carry a decoration, so `ui/TokenOverlay.tsx` paints a pill behind the text instead: the
same colour at 22% in OKLab, on a backdrop the input sits transparently on top of. A token is also
clickable in both — the box that opens is `ui/TokenBox.tsx`, on `Menu.tsx`'s floating surface below.
An unresolved name gets CodeMirror's own `linter()` underline rather than a colour of its own,
because a warning squiggle is a shape the editor already speaks and a second red would have to be
audited against the other 36. Decision 25 is why. The pill is opt-in per call site: `Field` and
`CellField` paint one only where `onToken` is passed, because the search box and the rename dialog
hold text nothing will ever interpolate.

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

## Saying something went wrong

Three things, and they are not interchangeable.

| Shape                | Component                   | For                                                                       |
| -------------------- | --------------------------- | ------------------------------------------------------------------------- |
| a strip above a pane | `ui/Banner.tsx`             | this pane is usable but something is off: a stale file, a run that failed |
| the pane's content   | `panes/ResponseFailure.tsx` | there is nothing to show, and why there is nothing is the information     |
| one faint line       | a local `Hint`              | there is nothing to show and that is unremarkable: no cookies, no tests   |

`Banner` is `border-{tone}/40 bg-{tone}/10` with a `WarningIcon`, chrome tier, `px-gutter py-1.5`,
and only two tones: `danger` and `warn`. `ok` and `neutral` do not warrant a bar. It takes either a
`detail` beside the message — monospace and truncated, so an id or a path — or `details` below it,
one prose line each, which is what a `PremanError` carries. It exists because four panes wanted it
and three had already written their own with three different class strings.

A failure that fills a pane is centred in `max-w-lg`: a 24px mark, the headline with its status tag
beside it, one line of guidance, then the server's own words verbatim in a
`rounded-sm border-danger/30 bg-danger/10` block, with any `PremanError` details inside that same
block below a hairline rather than floating under it. The block's own text stays left-aligned — it
is parsed character by character, not read.

Centre it with `m-auto` on the child, never `items-center` on the scroll container. A
cross-axis-centred flex child in `overflow-auto` has a top that cannot be scrolled back to, so a
failure with its trailers open would lose its own headline. Auto margins absorb free space when
there is some and collapse to zero when there is not, which is the same composition without the
trap. The block is `select-text`, which is a
deliberate exception to the app-wide `select-none` in `app.css`: it is the one string the reader
wants in their clipboard. Trailers go in a collapsed native `<details>` — most of what a server
attaches to a rejection is `date` and `content-type`, and five rows of that bury the one line that
matters. No illustration — at these sizes a drawing pushes the informative line below the fold, and
it would be the same drawing for every failure.

## Statuses wear one tag

`ui/StatusTag.tsx` paints every response status, both transports, in both the response summary and
the failure block: `rounded-sm px-1.5 py-px font-mono text-2xs` over `toneTagClass(statusTone(…))`.

The tone is graded, and the grading is not ours: `statusTone` maps each gRPC code name through the
canonical `google/rpc/code.proto` HTTP equivalent, so everything that is a 4xx reads `warn` and
everything that is a 5xx reads `danger`. `NOT_FOUND` and `404` are therefore the same colour,
because they are the same event. A code name this build does not know reads `danger`, since an
unrecognised status is no evidence that the caller can fix it.

The filled pairs are audited like every other: `ok` 6.72:1, `warn` 7.52:1, `danger` 5.97:1 on their
own `/10` tint over `--color-panel`, and `neutral` 7.26:1 on `--color-control` — a grey tint on a
grey surface is a smudge, not a tag.

What the tag grades is the status. What surrounds it does not: the mark and the report block in
`ResponseFailure` stay `danger` whatever the code, because that pane only renders when nothing came
back, so its tone is a constant and carries no information.

## The sidebar column invariant

`Sidebar.tsx` draws every row as the same three columns, and the invariant is that **every name
starts at the same x**, whatever kind of node it is.

| Constant             | Value | What it is                                                               |
| -------------------- | ----- | ------------------------------------------------------------------------ |
| `INDENT_PX`          | 12    | one level of nesting                                                     |
| `LEAD_COLUMN_PX`     | 64    | one right-aligned column: caret + folder for a group, verb for a request |
| `GIT_COLUMN_PX`      | 10    | the unsaved mark or the git letter, on the far right                     |
| `DROP_LINE_INSET_PX` | 16    | where a drop indicator starts, so it does not span the lead column       |

The lead column is **one** column, right-aligned. It was two — a caret column then a verb column —
and that is bug four: a group's caret sat a full `DELETE` width from its own folder icon. Anything
that adds a per-row affordance goes inside the existing column or the invariant is gone. The
unsaved mark below is the case in point: it had nowhere else to go, so it took over the same
`GIT_COLUMN_PX` slot the git letter already used, rather than opening a fourth column.

### Two facts, one shape, one column

A node can be unsaved (edits sit in this tab, not yet written to disk) and modified in git (the
file on disk differs from the last commit) independently, and the app has always had one glyph
each for them: the accent-filled `size-1.5` disc — the same shape `TabStrip.tsx`'s close button
uses for a dirty tab — and the single-letter `GIT_MARK` (`M`/`A`/`D`/`R`/`U`/`!`/`•`) coloured by
`toneTagClass`. `docs/plans/016-unsaved-is-not-modified.md` makes that pairing consistent
everywhere a node can show one:

- **The filled accent disc always means "unsaved work of mine, right now."** Nowhere else uses
  that shape for anything else, so seeing it never requires reading a tooltip to know it means
  "you have not saved this."
- **The sidebar's `GIT_COLUMN_PX` slot shows at most one glyph, and unsaved outranks git.** A row
  with unsaved edits shows the disc, not the letter, even if the file is also modified in git —
  `resolveMark` in `model/git.ts` picks the disc first and only falls back to `GIT_MARK` once a
  tab has nothing unsaved. The `title` on that slot still names both facts when both are true
  (`"Unsaved changes · Modified in git"`), because outranking a fact in the glyph is not the same
  as hiding it.
- **The script-phase rail does not spend the disc on "this phase has code."** That fact is shown
  by the label's own ink brightness (`text-ink` once `slot.code` is non-empty, `text-ink-dim`
  otherwise) instead, freeing the disc for the fact that actually needs it: a phase with an
  uncommitted edit shows the disc next to its label, same shape, same meaning as the sidebar and
  the tab strip.

Two vocabularies now separate cleanly, and the plan is explicit that they must not swap: **unsaved**
describes this tab's drafts, is scoped to the running session, and clears the moment `Cmd+S` writes
the file; **git status** describes this file against the repository, is scoped to the working tree,
and clears the moment the change is committed. `M`/`A`/`D`/`R`/`U`/`!` keep their meaning exactly as
before — decision 16 changes what shares a column with them, not what they mean.

## TypeScript is the source

This section used to list tokens that CSS owned and TypeScript copied, with a warning that changing
one side silently broke the other. That mirror is gone. For anything configurable, TypeScript holds
the value and CSS receives it.

| Value                     | Owned by                          | Written to CSS by                          |
| ------------------------- | --------------------------------- | ------------------------------------------ |
| the eight density tokens  | `appearance/density.ts`           | `appearance/apply.ts`, before React exists |
| 21 colours, 36 syntax     | `appearance/themes/*.ts`          | `appearance/apply.ts`                      |
| `--editor-font-size`      | `Preferences` in `preload/bridge` | `appearance/apply.ts`                      |
| `--font-user-{mono,sans}` | `Preferences`                     | `appearance/apply.ts`                      |

`app.css` still declares all of them, and what it declares is what `default` and `preman-dark` say.
It is a fallback and a reading aid, not a second source. `test/renderer/appearance.test.ts` asserts
the two agree.

Two things are still literals on both sides, because neither is configurable:

| CSS token        | TypeScript                                | Read by                         |
| ---------------- | ----------------------------------------- | ------------------------------- |
| `--z-index-drag` | `DRAG_Z_INDEX` in `Sidebar.tsx`           | the drag preview's inline style |
| —                | `TITLE_BAR_GUTTER_PX = 76` in `bridge.ts` | the title bar's left padding    |

`TITLE_BAR_GUTTER_PX` has no CSS token at all: it is the horizontal room the traffic lights need,
which does not change with density, and only one element depends on it.

One consequence is worth stating plainly, because it is the rule the block in `app.css` depends on:
that block is `@theme` and **not** `@theme inline`. `inline` substitutes the literal at build time
and leaves nothing on `:root` for `apply.ts` to override, which would silently disable every
preference at once.

## Motion

The app moves, and the "nothing else moves" bullet that used to sit in the next section is gone.
Decision 26 is the reversal and the why; this is which token to reach for.

| Token           | Value                             | For                                                         |
| --------------- | --------------------------------- | ----------------------------------------------------------- |
| `--ease-out`    | `cubic-bezier(0.23, 1, 0.32, 1)`  | anything entering or leaving — which is nearly everything   |
| `--ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | something moving while it stays on screen                   |
| `--ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)`  | a panel                                                     |
| `--ease-in`     | Tailwind's default                | **never.** It starts slow, delaying the frame being watched |

`--ease-out` and `--ease-in-out` are retunes of Tailwind's own keys, for the same reason density is
retuned in place: a later Radix or shadcn control inherits them without being patched. `--ease-in`
is left alone precisely so that a stray `ease-in` in a diff is visibly not one of ours.

Durations are named for the surface, not the number, and none exceeds 200ms: `--duration-press`
120ms, `--duration-tooltip` 125ms, `--duration-menu` 150ms, `--duration-glyph` 120ms,
`--duration-panel` 180ms, `--duration-modal` 200ms. Reach for the name; a `duration-150` at the
point of pain is how one answer becomes three.

What actually animates:

- **Floating surfaces, on enter only.** `.surface-enter`, `.modal-enter` and `.scrim-enter` in
  `app.css`'s `@layer components` fade and scale from the origin Radix publishes, with
  `@starting-style` and no JS. There is no exit animation on a Radix surface — see decision 26 for
  why `Presence` makes one worse than none.
- **Controls, on hover and press.** Colour transitions everywhere, plus `active:scale-[0.97]` on
  buttons and icon buttons. Never on a text field, and never on a disabled control.
- **The in-flight request.** `.inflight-bar` sweeps the top of the response pane; `.body-enter`
  fades a response body in once.
- **A workspace that is opening.** `.skeleton-block` pulses the placeholder bars `ui/Skeleton.tsx`
  fills the sidebar and the editor with. Opacity only, and no `transform`: a skeleton is a promise
  about where things will be, and a bar that also slides breaks that promise once a second. It only
  appears at all after 150ms of waiting — a workspace of a normal size opens inside that and paints
  no placeholder, which is the whole reason the delay is there. `docs/performance.md` gates both
  halves of that.
- **Two surfaces with real presence**, via Motion through `ui/motion.tsx`: the banner and the
  overlay-pane swap.
- **The disclosure caret**, in the sidebar and the console drawer, and dnd-kit's drop animation.
- **The active tab's underline**, which travels rather than blinking. `ui/Tabs.tsx` owns the trigger
  and the underline for all three tab groups; reach for `TabTrigger`, never for a bottom border on a
  trigger, or the underline will look right and not move.
- **The console's call detail**, opening and shutting by height. The one height animation in the app,
  and the one exit animation outside a banner.
- **Sidebar rows, on a folder toggle.** Each row is placed by `translateY` at `index * rowHeight`, so
  opening or closing a folder slides everything below it. The offset is absolute, which is why this
  never runs on a scroll. Position a row with `top` and the slide silently stops happening.

Everything on that list but the last animates `opacity`, `transform` or colour, because decision 17's
budgets are blocking-time medians and motion is mostly only affordable as compositor work. The
console detail is the exception and is allowed to be one: it is inside a drawer that carries no
budget, and a disclosure that opens by fading reads as a different gesture than one that opens.
`width`, `top` and `all` still animate nowhere — and `top` is now load-bearing rather than a
preference, since it is the one property that would turn the sidebar's slide back off.

## What this system does not have

- **OS following.** There is no `nativeTheme`, no `prefers-color-scheme`, and no "System" entry in
  the picker. Light themes exist and are chosen; a request tool that repaints itself at sunset is a
  tool that changed under the user's hands mid-debug. This is the surviving half of the original
  dark-only rule, and decision 20 is where the other half was reversed.
- **A free UI scale.** Density is three presets, not a slider. Decision 21.
- **Themes read from disk.** The forty-three are bundled and static. Decision 20 says what a
  loadable theme would cost.
- **A spacing scale of its own.** Tailwind's default 4px scale is used as-is for padding and gaps.
  Only the named `--spacing-*` tokens above are ours, and they are heights, not spacing.
- **A component library boundary.** shadcn components are vendored and retuned, per decision 9.
  There is no `@preman/ui` package and there should not be one for a single consumer.
- **Motion on the command palette, or on the open-request strip.** The palette is a 100+/day keyboard
  action and animates never, permanently. The strip needs `layout` rather than `layoutId`, on the
  interaction the 16ms budget is named after. Decision 26, as amended by plan 019, says what each
  costs; the tab _underline_ moves, and that is a different control from the strip.

## Changing this system

Adding a token is cheap. Adding a _tier_ is not: the tier list above is short so that "which one"
is answerable without reading the call site, and a third height makes every existing answer a
judgement call again.

If a change retunes density app-wide, or reverses a stance recorded in `docs/decisions/`, it is an
ADR, not an edit to this file. This file records what the system currently is; the ADRs record what
it cost to get there.
