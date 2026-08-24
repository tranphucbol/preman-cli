# 023: The parser is fed a masked document

Status: Accepted

## Decision

An authored request body is not JSON. It is JSON with `{{token}}` holes in it, and the holes are
interpolated as raw text before anything parses the result — a bare `{{amount}}` in a numeric field
is correct and must stay unquoted, because quoting it would send a string.

So the editor gets its own language. `packages/desktop/src/renderer/ui/template.ts` wraps
`jsonLanguage`'s parser in one that replaces every `{{...}}` with a same-length decimal number
before the grammar sees it, and a `ViewPlugin` paints the real tokens back on top in
`--syntax-template`. `CodeEditor`'s `language` prop gains `"json-template"`, and the three editors
that hold text a human wrote use it: the gRPC message, the raw HTTP body, and the GraphQL variables.
A body that came back off the wire is already interpolated and stays on plain `"json"`.

`--syntax-template` is a real thirty-sixth syntax token, solved by the generator and gated by
`auditTheme` at a wider distance than the method column: `TEMPLATE_MIN_DISTANCE` is 0.1 where
`METHOD_MIN_DISTANCE` is 0.08.

This reverses one line of `docs/plans/015-configurable-appearance.md` §11, which listed `{{token}}`
interpolation highlighting as out of scope.

## Rationale

The mask is not about colour. `{{x}}` is brace-balanced, so Lezer's JSON grammar opens two objects
on `{{` and pairs the two closers with them — which means the brace that should have closed the
_enclosing_ object is eaten. Measured on a real body, one bare token turns every key below it from
`PropertyName` into `String`, and bracket matching, folding and auto-indent are wrong with it, until
the next `{` resynchronises. `{"a":{{x}},"b":"{{y}}","c":"lit"}` yields eleven error nodes and only
`"a"` survives as a key. The colours were the visible half of a broken parse.

The alternative was decorations alone: leave the grammar to fail and paint over the wreckage. It is
a much smaller change and it was rejected because it fixes only what you can see. Bracket matching,
`selectParentSyntax`, folding and auto-indent all read the tree, and a tree that thinks the document
ended four lines early stays wrong however it is painted. Masking repairs the tree, so everything
downstream of it is repaired at once.

The mask is length-preserving on purpose. Same length means positions map 1:1, so no offset
translation exists to get wrong, and CodeMirror's incremental reparse still works — a fragment is
still valid at the same position after an edit elsewhere. A number rather than a string because a
token is _usually_ bare where a number goes, and a quoted token masks to `"0.00"` which is still a
valid string; masking to a string would have produced `""___""` for the quoted case.

The token colour had to be new, and that was a measurement, not a preference. `--syntax-macro` was
the obvious reuse — a macro is also a name expanded before evaluation — and four of the vendored
palettes give `macro` and `property` the same hex, with several more within 0.04 of `number` in
OKLab. A token appears exactly where a string or a number would, with a `property` key beside it, so
unlike the six verbs, which only have to differ from each other, this one has three fixed neighbours
it did not choose. Hence the wider threshold, and hence a solver.

## Consequences

The `--syntax-template` solver is the third one in the generator that has to place a colour rather
than read one, after the ink tiers and the method column. `separator()` now holds the four
measurements the method column and the template token share. One palette needed more than the hue
circle: `mono-dark` is pure greyscale with `number`, `string` and `property` at OKLab lightness 0.68,
0.77 and 0.92, and a readable floor at 0.58, so the template token is placed by solving the 1-D
problem exactly — the ends of the readable band and the midpoints of the gaps — rather than sweeping
a grid, whose 0.03 step missed the floor by 0.01 and lost the only gap that existed.

Decoration precedence is load-bearing and was measured in a real window, not reasoned about. The
token span wraps the grammar's spans, and `color` on an inner element always beats an inherited
value, `!important` or not — so at `Prec.low` the tokens rendered as numbers and strings. At
`Prec.highest` they render as tokens. The doc comment on `jsonTemplate()` says so, because lowering
it would silently stop working.

Two holes remain, both documented in `template.ts`. A token used as a _key_ still breaks the parse,
because `{"{{k}}": 1}` masks to `{"0.00": 1}` only when the token is quoted; a bare key has nowhere
to go. Two adjacent bare tokens mask to two adjacent numbers, which is one number to the grammar.
Neither appears in a body anybody has written.

Masking reads the whole document once per parse. That is free for a request body and not free for a
600KB response, so above `MASK_LIMIT_CHARS` the text is handed to the grammar untouched — a document
that big is not one somebody typed a token into. There is no new performance budget row: the masked
parse is the same parse plus one `replace` over a document that is, by that cap, small.

A future `{{token}}` feature — completion from the variable scope, a hover showing the resolved
value, an underline for an unresolved name — now has a language to hang off. That was not the reason
for this change and it is not promised here.

Two of those three were then built on it. Decision 025 adds the unresolved underline as a `linter()`
over this language and a click that opens the value for editing; completion is still unpromised. The
mask stayed untouched: the new work compiles its own narrower pattern, because a name is what a box
opens on and `{{}}` has no name in it.
