# 025: Variable resolution stays in the engine

Status: Accepted

## Decision

A `{{token}}` is now something you can see the value of and set the value of, and every answer about
what one resolves to comes from the engine.

Core gains `previewText(dir, environment, text)` in `api/preview.ts`, which is
`interpolate(text, readerScope(dir, environment).store)` and nothing else — the same store
construction `readVariables` already used, extracted so a listing and a preview can never describe
different chains. The wire gains a `preview` request kind. The renderer gains a Preview tab beside
Edit on the three editors that hold authored text, a warning underline on names that did not resolve,
and a popover on a clicked token that reads the value out of `readVariables` and writes it back
through `write-variable`.

The renderer never substitutes. It also never decides which layer wins: `tokenState()` in
`renderer/model/tokens.ts` reads the `scope` and `shadowed` fields off the binding the engine
answered with, and reports one of five states.

Both halves need to find a token in a string, and there are now two patterns that do it.
`VARIABLE_TOKEN_SOURCE` on the protocol is a copy of core's `TOKEN_SOURCE`, pinned by a test that
runs one corpus through both and compares the names they find. It is deliberately _not_
`ui/template.ts`'s `MASK_PATTERN`, which is wider because it has a different job.

The Preview pane says two things out loud in its footer: a dynamic value is one sample, and `data`,
`local` and `collection` exist only during a run.

## Rationale

The alternative was renderer-side substitution: the renderer already holds the whole variable view
for the Variables pane, so walking a string and replacing tokens from it is perhaps thirty lines and
no new wire kind. It is wrong for the reason `VariablesPane.tsx:4-8` already states about precedence.
`vars/interpolate.ts` is not a `replace` — it expands recursively to `MAX_DEPTH`, detects cycles and
names the chain, evaluates a `{{$dynamic}}` per occurrence and refuses to re-expand its result. A
second implementation would be a second answer, and the one thing worse than not showing the user
what will be sent is showing them something else.

That is also why `previewText` is `interpolate` with no logic of its own. The point is not to reuse
code; the point is that the preview is not a model of the send, it is the same function.

The five states exist because "you cannot edit this" is four different sentences. A dynamic variable
has no value to store; a globals value has a file to go and edit; an undefined name in an environment
is a key the box can offer to append; an undefined name with no environment chosen has nowhere to put
anything. Collapsing them into a disabled field would have produced a box that is technically honest
and practically useless. The fifth, `writable`, also carries what it shadows, so a value that
overrides globals says so — that is the case where editing the wrong layer is a real mistake.

The lint underline rather than a colour of its own: `--syntax-template` is already held at a wider
audited distance from `string`, `number` and `property` than any two method verbs are from each
other, on 43 themes. A second template colour would need the same treatment. CodeMirror's `linter()`
already draws a warning squiggle that reads as "this is not right" in every theme, and a diagnostic
carries a message, which a colour does not.

### The overlay, and the per-cell CodeMirror it refused

A URL, a header value and an environment value are all plain `<input>`s, and an `<input>` cannot
carry a decoration. The real alternative was to replace every one of them with a one-line CodeMirror
on the `json-template` language, which would have made the pill and the click identical everywhere
and is the option the next reader will otherwise reopen.

It was refused on cost, and the cost is per cell rather than per pane. The Variables pane and the key
value grids are virtualized because they hold hundreds of rows, and a CodeMirror instance is a view,
a state, a transaction pipeline and a set of DOM event handlers; twelve of them in a scrolling
viewport is a different order of expense from twelve inputs. It would also have had to reproduce what
an input gives for free — the browser's own ellipsis on a truncated cell, its selection behaviour,
its `defaultValue`-plus-blur commit, autofill — and none of that is what the feature is about.

So the backdrop: a transparent input on top of an `aria-hidden` copy of its own text, whose text is
also transparent and only whose token rectangles are painted. Painting the _pill_ rather than the
_text_ is what makes a clipped cell correct, because a rectangle cut off by `overflow: hidden` is a
rectangle cut off, where clipped coloured text is a second, wrong copy of the value with no ellipsis
on it.

## Consequences

The engine is now asked to resolve a body on every keystroke that lands in a Preview pane and on
every environment switch, and the answer is a whole substituted document. That is bounded by the
existing body size the editor holds and by the fact that only one pane is in Preview at a time. The
Preview pane is unmounted while Edit is on screen, which is why the set of unresolved names is held
in `RequestEditor`'s `TemplateEditor` rather than in the pane that fetched it.

Two performance findings, both from the gate rather than from reasoning about it:

Installing `linter()` unconditionally on the `json-template` editors cost the worst keystroke in a
burst 78.5ms against a 50ms long-task ceiling, with the median still inside budget. A linter runs a
debounced pass over the whole document whether or not it can report anything, so an editor that has
not yet been told any unresolved names now installs no linter at all rather than an empty one. The
consequence is a rule to keep: the extension is absent, not inert.

The overlay is skipped entirely for text with no `{` in it, which is nearly every value in a grid,
and `useTokenPills` returns the previous state rather than a new one in that case — so a field with
no token in it costs one `includes` per keystroke and no render. Neither the keystroke nor the
tab-switch median moved.

`docs/performance.md` gets no new row. Every number this touches is an existing one, which is the
point of gating on them.

Three things moved for the sake of having one declaration: `TOKEN_COLOR` is exported from
`ui/template.ts` so the pill and the decoration agree; `GLOBALS_READ_ONLY_HINT` moved from
`VariablesPane.tsx` into `ui/TokenBox.tsx` so the two surfaces that say "globals are not ours to
write" say it the same way; and `Field`/`CellField` gained a closed `tone` vocabulary that is now the
only place a field's ink colour is written, because `ui/cn.ts` is a join and not a tailwind-merge, so
two `text-*` classes on one element would be decided by stylesheet order.

`findTokens` drops a token whose name is only whitespace. `{{ }}` matches the wire's pattern with a
name of one space, and the engine resolves and reports that name as written, which is its business —
but a box offering to define a variable called `" "` is not. The underline still appears on it,
because it genuinely does not resolve.

The write path notifies twice: a session-wide counter every pane watches, and an optional callback
for the one caller that also holds a set of unresolved names a write makes smaller. Writing a value
from a box in the URL row therefore refreshes an open Preview pane, and writing one from the body
editor also drops that name's underline without a second round trip.

What this does not do is in the plan's own out-of-scope list, and two entries there are worth
repeating because they are the obvious next asks: a whole-request preview — URL, headers and auth
resolved together — needs the engine to render a request without sending one, which is a much larger
seam than `previewText`; and completion from the variable scope, which decision 023 named in the same
breath as the underline, is a genuinely separate piece of work over `readVariables`.
