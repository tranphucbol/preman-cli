# 034: The sidebar starts shut

Status: Reversed by 037

## Decision

The sidebar panel is `collapsible` with a `collapsedSize` of zero, and its `defaultSize` is that
same zero. On a fresh install the window opens with no tree: title bar, tab bar, editor, status bar.

_(037 reversed this one sentence: `defaultSize` is `SIDEBAR_OPEN` again and the app starts with the
tree showing. Everything else below — the two controls, the absent header toggle, the animation, the
widths — is still what the app does.)_

Two controls open it, and both call one `toggleSidebar` in `App.tsx`:

- an `IconButton` in the status bar, at the left end, wearing `SidebarSimple` and `aria-pressed` to
  the pane's state;
- `Cmd+B`, bound in `useShortcuts` above the open-tab gate, and listed in the palette as
  `Toggle sidebar`.

The sidebar's own header has no toggle. The pane animates open and shut, by `flex-grow` at
`--duration-panel` on `--ease-drawer`.

The width the pane opens to is `SIDEBAR_OPEN`, the 22% it used to default to. Nothing else about the
pane changes: `SIDEBAR_MIN`, `SIDEBAR_MAX`, the handle and the tree are as they were.

## Rationale

The pane is a navigator, and a navigator is a thing you use to arrive. Once a request is open the
tree is a column of names you are not reading, next to the one pane in the window whose content
scales with how wide it is: a gRPC message, a response body, a header grid whose value column is the
first thing to truncate. On a laptop the sidebar is a fifth of the window spent on a question the
tab strip has already answered.

The counter-argument is real and is why this is a record rather than a commit. A tree that is not
there is a tree nobody finds, and "hidden by default" is how a feature becomes a feature only its
author knows about. Three things answer it, in order of how much they carry:

- The tab strip and `Cmd+K` are the two ways people actually reach a request after the first day.
  The palette searches every request in the workspace and needs no pane at all.
- The toggle is in the status bar, at the left end, next to nothing and opposite the console's.
- `Cmd+B` is that same shortcut in every editor this app's users already have open.

The toggle is in the footer and not in the sidebar because a control that lives inside the pane it
hides can only ever hide it, and a second copy that can only do half of what the first does is a
second thing to find, keep labelled and keep honest. The sidebar's header is a toolbar for the tree —
search, new collection — and hiding the tree is not an operation on the tree. `Cmd+B` is the answer
for anyone who wants it without crossing the window.

The footer rather than the title bar, which was the first arrangement, because the status bar is
already the strip that owns pane toggles: the console's has been there since 024, for the argument
that a pane with no visible handle is a pane nobody finds. Two of them there gives the strip a rule
— each toggle sits in the corner nearest the pane it opens, sidebar left and console right — where
one in the title bar and one in the footer only gives it two habits. The title bar keeps its own
rule as a result: it is about which workspace, and nothing else.

## The animation, and the rule it breaks

The pane slides. `app.css` transitions `flex-grow` on `[data-panel][data-sliding]` at
`--duration-panel` on `--ease-drawer` — the token that has said "a panel" since 026 and until now
had no panel.

This is a layout property, and `docs/design-system.md` said `width`, `top` and `all` animate
nowhere. That sentence is amended rather than quietly stepped around, because the alternative was
tried first and is worse. There is no transform that expresses a horizontally collapsing pane:
translate it and it slides over the editor instead of out from under it, scale it and every glyph in
the tree distorts, and in both cases the editor beside it still has to hand the width back on some
frame, so the layout is paid for anyway and now it is paid for abruptly. The first attempt animated
the toggle's glyph instead and left the pane snapping, which is a different thing that moves rather
than the thing that was asked to move.

What makes it affordable is that it is bounded, and that is the test to apply to the next request
like it: one pane, 180ms, on an explicit gesture with nothing else in flight. `ui/Progress.tsx` fails
that test — a determinate fill is per-frame layout for as long as the operation lasts — which is why
it still uses `scaleX` and why 017's argument is untouched for everything else.

Three things follow from where the transition had to live:

- It is on `[data-panel]`, a library-owned element. `react-resizable-panels` renders its own sized
  div as the _parent_ of the one our `className` reaches, and puts the width in `flex-grow`, so a
  Tailwind class on the `Panel` cannot get at it. `data-sliding` is passed through `Panel`'s rest
  props to land on that outer div, and the rule is a stylesheet rule rather than a class.
- It is armed and disarmed rather than standing. The resize handle drags the same `flex-grow`; a
  permanent transition would run the pane 180ms behind the pointer, which reads as a broken pane
  rather than an animated one. `toggleSidebar` sets `sliding`, and a `setTimeout` of
  `SIDEBAR_SLIDE_MS` clears it. That constant restates `--duration-panel` for the reason three
  modules already restate `--ease-out`, and it is safe to err long and unsafe to err short.
- `test/renderer/motion.test.ts` gained a case, because the existing fence reads `.tsx` and would
  not have seen a `transition` in `app.css` at all. The new one allows this exact rule and no other,
  so the exception cannot be cited by the next diff to justify a second one.

The tree squeezes as the pane narrows rather than sliding out from behind its edge, because the
library's inner element is `overflow: auto` and the content has no width to hold. Making it a true
slide would mean pinning a content width in pixels, which is a magic number and a horizontal
scrollbar. Not worth it at 180ms.

One consequence of `onResize` being ResizeObserver-driven: the footer button's `aria-pressed` drops
at the end of a close rather than at its start, since the pane is genuinely still open until the last
frame. That is correct and it is also 180ms of a button looking pressed after you pressed it.

Collapsed and not unmounted, which is the same call the console drawer made and for the same reason:
a panel that unmounts loses its size, so every reopen would guess a new one. It also keeps the tree's
scroll position and the virtualizer's measurements across a toggle, so opening the pane is a width
animation rather than a rebuild.

## Consequences

Persistence is unchanged and already correct: `react-resizable-panels` writes the layout to
`localStorage` under `preman:panes`, so `defaultSize` is only consulted when there is nothing stored.
An existing install keeps the sidebar it had. A new one starts shut, and stays whichever way it was
left. The state is per-machine rather than per-workspace, which matches the console drawer and is the
honest scope for a window preference.

`test/renderer/perf.app.test.ts` paid for this. It launches into a fresh `--user-data-dir`, so it
gets the new default, and a collapsed panel is zero pixels wide — every `[role="treeitem"]` is in the
DOM and none of them has a bounding box, so its definition of "the window is interactive" would have
timed out rather than failed. `launch()` now clicks the footer's toggle before it waits, selecting on
`Show the sidebar (Cmd+B)`, which is the half of the name the in-pane copy never says. The
start-up row is not measurably worse for it: the button paints with the first frame, which is already
on the critical path to the first row, so the click overlaps the engine's catalog build instead of
following it.

What this costs is the first ten seconds. Someone opening preman for the first time sees an empty
editor and has to press something before the workspace they just opened is visible, and no empty
state currently says which thing to press. That is the follow-up this record is holding open.
