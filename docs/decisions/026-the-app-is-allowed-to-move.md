# 026: The app is allowed to move

Status: Accepted

## Decision

The app animates. Specifically, and exhaustively:

- **Floating surfaces animate on enter only.** Menus, the context menu, the select popup, the
  tooltip, the dialog and its scrim fade and scale up from the transform origin Radix already
  publishes. There is no exit animation on any of them.
- **Controls acknowledge hover and press.** Colour transitions on buttons, icon buttons, inputs and
  select triggers, plus a `scale(0.97)` on press for the two that are pressed. A disabled control
  does not move; a text field does not scale, because a field that flinches when clicked is a field
  that moved the caret.
- **The in-flight request says so.** A 2px hairline sweeps the top edge of the response pane while a
  request is open, and a response body fades in once when it replaces a hint.
- **Two surfaces get presence**, because they are conditional renders and CSS cannot transition an
  element out of the tree: the failure/host/degraded banner, and the overlay-pane swap.
- **The disclosure caret rotates**, in the sidebar and in the console drawer, and the drag pill
  travels to the row it landed on instead of being destroyed at pointer-up.

Motion is a token tier in `app.css`: three easing curves and six named durations, nothing above
200ms. `--ease-out` and `--ease-in-out` are retunes of Tailwind's own keys rather than additions, so
`ease-out` means the app's ease-out in a control nobody has patched yet. `--ease-in` is left at
Tailwind's default and **never used on UI**: it starts slow, which delays the exact frame the user is
watching, so a stray `ease-in` in a diff is visibly not one of ours.

Every animation animates `opacity`, `transform` or colour. Never `height`, `width`, `top`, or
`transition: all`.

The Cmd+K command palette never animates, in or out, permanently.

`prefers-reduced-motion` is honoured twice: once in the base layer of `app.css` for everything CSS
drives, and once via `<MotionConfig reducedMotion="user">` for the two JS-driven surfaces, because
a CSS rule does not reach a WAAPI animation.

This reverses the "Motion" bullet under "What this system does not have" in
`docs/design-system.md`, which said hover and press transitions were all there was — and which was
itself untrue in the other direction, because `BASE_CONTROL` ended in `transition-none` and there
was no `:active` rule anywhere in the renderer.

## Rationale

The symptom is not that the app looked cheap. It is that a tool which never moves cannot tell you
where something came from or that it heard you. A context menu that flicks into existence at the
pointer gives no clue it belongs to the row that was right-clicked. A banner that appears by shoving
the tree down by its own height costs the reader their place mid-read. A Send button that does not
depress leaves the user genuinely unsure whether the click landed, which is why people press it
twice.

The constraint that shaped every choice is decision 17: the interaction budgets are blocking-time
medians, attributed to the interaction that caused them. Motion is therefore only affordable if it
is compositor work rather than main-thread work. That is the whole reason the answer here is CSS
transitions on `opacity`, `transform` and colour rather than a JS animation runtime by default, and
the reason nothing in this decision animates a geometric property. A `height` animation is layout
every frame, on the main thread, in the same budget a keystroke is measured against.

Enter-only on Radix surfaces follows from how Radix works rather than from taste. `Presence` keeps
an exiting element mounted until an `animationend` it can observe, so an exit transition does not
hold the element at all and an exit animation means `@keyframes` — which restart from zero when a
menu is reopened before it finished closing, and which make dismissal feel slower than no animation
at all. `@starting-style` gets the enter half with no JS involved.

The palette is exempt because it is a 100+/day keyboard action. Raycast's palette has no transition,
and that is the correct answer for anything invoked that often.

Motion (the library) is in the bundle for two surfaces and nothing else, behind `LazyMotion` with
`strict` and an ESLint fence. It is a bad trade on the arithmetic — roughly 65 kB raw for a banner
and a crossfade — and it is here because the alternative, a hand-rolled `useExitPresence` hook, is
thirty lines that do one thing and would have to grow the moment a third surface needed presence.
The gate that made this measurable rather than assumed is recorded in `docs/performance.md`.

## Consequences

**A token tier was added, and `docs/design-system.md` says a tier is not cheap.** The mitigation is
that the tier is three curves and six durations and no more. A fourth curve has to argue for itself.
The "which token do I reach for" answer is in `docs/design-system.md`: `ease-out` for anything
entering or leaving, `ease-in-out` for something moving on screen, `ease-drawer` for a panel,
`ease-in` never.

**The theme-switch budget stops being a measurement of stillness, and now depends on a guard.**
`applyPreferences` writes about sixty custom properties in one call. Once controls have a colour
transition, roughly 40–100 mounted sidebar rows would each start one in the single frame that
`THEME_SWITCH_BUDGET_MS = 16` is measuring. `apply.ts` therefore sets `data-retheme` on `:root`,
writes, forces one style flush, and removes the attribute — behind a `transition: none !important`
rule in `app.css`. It is a `try`/`finally`, because a throw between the two attribute calls would
leave the whole app with transitions permanently disabled, a bug that presents as "the animations
stopped working sometimes". The forced flush is a recalculation the theme switch already paid for.

**No exit animation anywhere except the banner and the overlay swap.** This is a real loss: a dialog
that fades in and cuts out is asymmetric. It is accepted for the `Presence` reasons above.

**Motion is one module's dependency, enforced by a fence.** `ui/motion.tsx` owns the `LazyMotion`
boundary and re-exports `m` and `AnimatePresence`; `eslint.config.js` forbids importing `motion`
anywhere else. That override re-declares the engine and `node:*` fences, because
`no-restricted-imports` is replaced wholesale by a later config object rather than merged into —
omitting them would exempt the one file from the fence that decision 2 calls the whole architecture.

**Motion never animates `x`, `y`, `scale` or `rotate`.** Those shorthands are excluded from Motion's
compositor path; a composed `transform` string is not. Both Motion consumers therefore animate
`opacity` and a full `transform` string, and both duplicate `--ease-out`'s control points and one
duration as literals, because a CSS custom property is not readable from a Motion transition. Those
are the only duplicated curve and duration in the app, and both carry a comment saying so.

**Three things stayed still on purpose, and are not "not yet".** `KeyValueGrid` rows are keyed by
array index, so a presence animation there would animate the wrong row out. Sidebar folder
expand/collapse has no height to interpolate — rows are absolutely positioned off a JS density
token and collapse is a store-level filter — so animating it means animating a virtualizer, against
the sustained-60fps and ≤200-mounted-row assertions. Tab open/close/reorder would need
`layout`/`layoutId`, which needs `domMax`: another 10 kB for a FLIP engine, on a strip whose tabs
are opened and closed constantly.

**Amended by plan 019: two things stayed still, the tab refusal was mis-scoped, and the 10 kB was
wrong.** This decision stays Accepted, because what changed is a scope and a price rather than the
decision.

- _The scope._ "Tab" above meant `panes/TabStrip.tsx`, the strip of open requests, and that refusal
  stands: those tabs are opened and closed constantly and it is the interaction the 16ms budget is
  named after. It did not mean the request editor's section tabs, its Edit/Preview switch, or the
  response tabs, all three of which are one `Tabs.List` whose value changes. The codebase already
  drew that line before this paragraph blurred it — `test/renderer/perf.app.test.ts:68-69` scopes the
  budget's selector to `[role="tablist"][aria-label="Open requests"]`, under a comment reading
  "Named, because the request editor's own section triggers are `role="tab"` as well."
- _The price._ "Another 10 kB" was never measured in this repo. It was, and it is **46,815 bytes**
  of built renderer chunk: 1,269,059 with `domAnimation`, 1,315,874 with `domMax`, same source
  otherwise. The figure above was gzipped and from an older major, and Electron loads the chunk over
  `file://`, so there is no gzip in the real path. A refusal priced at a fifth of its cost is a
  refusal that looks cheaper to hold than it is, which is the more useful half of this correction.
- _What was bought._ `domMax` is loaded, and one `layoutId` uses it: the accent underline is now an
  element in `ui/Tabs.tsx` rather than each trigger's bottom border, so it travels between triggers
  instead of blinking. Its identity comes from `useId()` per `Tabs.List`, because two `ResponseView`s
  are mounted whenever the collection runner is open and a shared `layoutId` would slide the
  underline between panes. `test/renderer/motion.test.ts` asserts that exactly one module reaches for
  projection, so 46 kB serving one underline stays a decision rather than becoming a habit.
- _The sidebar folder does move, and the refusal above was argued from the wrong end._ It said
  animating a folder means animating a virtualizer, and asked how to tell a revealed child from a row
  scrolled into view. Both are true of fading the children in, and neither is needed: rows below the
  folder do not need to fade, they need to be somewhere else, and where each one belongs is
  `index * rowHeight` — arithmetic the pane was already doing at `Sidebar.tsx:361` to place the drop
  indicator. The real obstacle was one property. A row was positioned with `top`, so its offset was
  not animatable without a reflow per row per frame; it is a `translateY` now, which the doc comment
  above `Row` had claimed for it all along. Nothing else changed: the offset is an absolute position
  in the list, so it does not change while scrolling, and a row scrolled into view is a new element
  with nothing to animate from. Measured on the 5,000-node tree, with and without the transition:
  46 mounted rows and a 10.4ms worst frame gap, identical to the decimal, against a 32ms ceiling.
  The one thing it costs is a guard — `useRemeasure` moves every offset at once when the density
  token changes, and that is not a toggle, so the list is keyed by row height and remounts instead of
  sliding.
- _One thing started moving that this decision did not cover._ The console's call detail opens and
  shuts by height, which is the app's first exit animation outside a banner. `height: "auto"` is a
  measured animation, so the row's `ResizeObserver` fires once per frame while it runs; the console
  carries no perf budget, and the fallback if a full drawer stutters is to keep the opacity and let
  the height snap.
