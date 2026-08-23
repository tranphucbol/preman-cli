# 021: Density is a preset, and TypeScript owns the token

Status: Accepted

## Decision

Three densities — `compact`, `default`, `comfortable` — each a fixed set of eight numbers: five
heights and three text sizes. No free slider.

`packages/desktop/src/renderer/appearance/density.ts` holds the table and is the single source.
`apply.ts` writes the chosen preset onto `document.documentElement.style` as `--spacing-row`,
`--spacing-control`, `--spacing-control-lg`, `--spacing-tab`, `--spacing-bar`, `--text-2xs`,
`--text-xs` and `--text-sm`. The virtualized panes import the same record for `estimateSize`.

`app.css` still declares those eight tokens, and what it declares is what `default` says. The block
stays `@theme` and not `@theme inline`.

This reverses the "tokens mirrored in TypeScript" rule in `docs/design-system.md`: the mirror had
CSS as the original and TypeScript as the copy. It is now the other way round.

## Rationale

`009` says density was retuned _before any screen is built_, because retuning afterwards "is not a
find-and-replace" — every hand-tuned spacing relationship in every screen shifts at once. Density
presets are retuning afterwards, three times over. That objection has to be answered, not skated
past.

It is answered by single-sourcing. What `009` was afraid of was a diffuse change: 26 becomes 30 in
forty places and thirty-nine of them are right. Here there is one table, the tokens derive from
each other (`tab = control + 6`, `bar = control-lg + 10`), and every consumer reads a token. The
relationships that `009` wanted protected are now written down as arithmetic instead of being
distributed across the stylesheet as coincidences.

TypeScript has to own the numbers because five of them are already in TypeScript whether we like it
or not: TanStack Virtual needs `estimateSize` as a number, and it cannot read a custom property.
The old mirroring made CSS authoritative and asked a comment to keep the constants honest. Inverting
it deletes the class of bug where the comment is wrong — there is one table, the stylesheet's
literals are the `default` row, and `test/renderer/appearance.test.ts` asserts they match.

`@theme` and not `@theme inline` is load-bearing and easy to undo by accident. `inline` substitutes
the literal at build time, which leaves nothing on `:root` for `apply.ts` to override. The
distinction earns a comment in `app.css` next to the block.

Three presets and not a slider because a slider is a promise. Every value between 22 and 40 would
have to look deliberate, and the text sizes do not scale linearly with the heights — `13.5px` at
`row: 28` is a judgement, not a ratio. Three columns can each be looked at.

## Consequences

**Six virtualizers must be told.** TanStack caches measurements, so a changed `estimateSize`
closure is not enough on its own; `useRemeasure(virtualizer, rowHeight)` calls `measure()` when the
height changes. A seventh virtualized list added later and not given the hook will silently keep
the old row height until something else invalidates it. That is the leak to watch, and it is the
same shape as the "a new list is virtualized" convention from `009`.

**The window chrome is not CSS.** `--spacing-bar` is also the title bar, and on macOS the traffic
lights are positioned by the main process in native pixels. Density change therefore crosses the
IPC boundary — `setWindowChrome` — where nothing else about appearance does.

**Fractional text sizes.** `10.5px` and `13.5px` are real values in the table. They render fine and
they look wrong in a spec sheet; they are there because the intermediate steps needed somewhere to
be.

**Density switching has a budget, and it is a loose one.** Every pane re-measures, so it is held to
50ms as a long-task ceiling rather than to a tab switch's 16. See `docs/performance.md`.
