# 031: An authored body is re-indented, not reserialised

Status: Accepted

## Decision

The request side of the app gets its own formatter, and it is not the one the response side already
has. `packages/desktop/src/renderer/model/format.ts` walks the text once and rewrites only the
whitespace between values: strings, numbers, keywords and `{{token}}`s are copied through byte for
byte, and nothing in the document is ever parsed into a value and printed back. `{{…}}` is matched
as an atom before `{` is read as a brace, reusing `VARIABLE_TOKEN_SOURCE`, the one place that
pattern is written.

Well-formedness is a separate question, answered by `JSON.parse(maskTemplates(text))` — decision
023's masker, already tested — whose result is thrown away. It gates the scanner and never reaches
the output. Above `MASK_LIMIT_CHARS` the formatter declines, because a document the masker will not
mask is a document the oracle would reject.

The control is an `IconButton` in a new right-aligned group in both authored-body toolbars. It is
never `disabled`; a body it cannot format is reported through the pane's failure banner.

`BodyStore.format` in `packages/core/src/api/bodies.ts` stays exactly as it is, and the app now
holds two formatters that disagree on purpose.

## Rationale

A response body is already interpolated and is only ever looked at. A request body is bytes that go
on the wire. That difference is the whole decision, and it is measurable rather than aesthetic.
Against the real masker:

```
in   : {"id": "{{app_id}}", "n": {{count}}, "big": 12345678901234567890, "f": 1.0, "e": 1e3}
out  : "id"  → "{{app_id}}"              quoted token survives
       "n"   → 0                         nine characters became one
       "big" → 12345678901234567000      precision lost
       "f"   → 1                         literal rewritten
       "e"   → 1000                      literal rewritten
```

Every row but the first is a different request than the author wrote, and the bare token is not an
edge case: `test/renderer/template.test.ts`'s fixture is a real gRPC message with two of them, one
in a numeric field. A formatter that changes what will be sent is not a formatter, it is a silent
edit, and the button that runs it is pressed for cosmetic reasons.

Mask-then-unmask-by-position was the obvious repair and does not work. The masking trick depends on
the replacement being the same length as the token (`template.ts:13-15`), and a round trip destroys
that: `JSON.parse("0.0000")` is `0` and `JSON.stringify(0)` is `"0"`, so a nine-character hole comes
back one character wide with nothing to put in it.

Reaching for core's formatter was not an option even if it had been correct. It is keyed by a
response `handle` an authored body does not have, and it lives in `packages/core`, which the
renderer may not import at all.

Keeping the validity check as a masked `JSON.parse` rather than folding it into the scanner is the
one place this design spends something to buy simplicity. It is a second pass over the text, and in
exchange the scanner may assume balanced input — no error recovery, no diagnostics, no opinion about
what a number is. The pass is over a document bounded by the mask limit, so it is not a budget row.

## Consequences

**A hand-written scanner is the cost.** Roughly ninety lines that have to be right about strings,
escapes and nesting, where the alternative was two library calls. It is bounded — the oracle has
already proved the document is well-formed, so the scanner has no failure modes to design — and
`test/renderer/format.test.ts` holds it, with the literal cases stated as literals so a regression
reads as "12345678901234567890 became 12345678901234567000" rather than as a diff of indentation.

**Two token shapes refuse to format.** Decision 023's two documented holes are inherited: a bare
token used as a key (`{{name}}: 1`) and two bare tokens with nothing between them (`{{a}}{{b}}`)
mask to invalid JSON, so the oracle rejects a body that is, to its author, fine. That is the safe
direction, since the scanner is never handed something it might mangle, but the refusal is wrong
about why — so both messages say what was checked and name the two shapes, rather than pronouncing
the document invalid. `{{}}` is a third, narrower disagreement: the masker accepts it and
`VARIABLE_TOKEN_SOURCE` requires a name, and where they differ the formatter refuses.

**Someone will try to delete this in favour of core's.** Two formatters in one app, one of them a
hand-written scanner, is exactly the duplication a reader is right to be suspicious of. That is why
the argument is at the top of `model/format.ts` in the same measured form it has here, and why the
three literal tests exist: they are the cases the round trip fails, and they fail loudly.

**Beautify moves the caret and scrolls to the top.** The write routes through the store like every
other edit, so it arrives at `CodeEditor` as a whole-document replacement, which resets
`scrollDOM.scrollTop` and remaps the selection. Formatting a long body loses your place in it. The
fix is an imperative handle on `CodeEditor` so CodeMirror could dispatch a targeted change, and that
breaks the uncontrolled, commit-on-blur contract every input in the app shares — more than one
button should cost. `history()` is installed, so `Cmd+Z` reverts a reformat, which is the property
that actually matters.

**The button reads the store, not the props.** `CodeEditor` commits on blur and after a 300ms idle,
so the projected `data` a toolbar renders from can be older than what is on screen. Beautify calls
`flushPending()` first — the same seam `Cmd+S` uses — and then reads `useTabsStore.getState()`. The
alternative, trusting mousedown to blur, blur to commit and React to flush before `click`, is three
assumptions deep and being wrong means discarding the last keystrokes into the thing it rewrites.

**Making room for it rebalanced both toolbars.** `ViewSwitch` was the row's spacer, so a right-hand
group could not exist until it gave up its hardcoded `ml-auto`; `Edit | Preview` now sits at the
left, next to the pane it labels. The gRPC pane paid for the space: `Generate example` became a
glyph, which demotes the highest-value control in that pane for the person least likely to find it,
and its "set a method path first" hint moved across the row to stay adjacent to it. Both are noted
in that pane's doc comment, and restoring the label is one word of JSX.

**Only raw bodies.** The GraphQL pane has two editors under one toolbar, so a single button there
cannot say which of them it formats; `urlencoded` and `formdata` are pair grids with no whitespace
to fix. And the editor's language is `json-template` unconditionally, so the app has no notion of a
raw body that is not JSON — giving it one is a body-subtype feature, not a button.

**No format-on-save, no format-on-paste, no shortcut.** The first two rewrite bytes the user did not
ask to have rewritten, which is the objection this whole record is built around. A button is a
request.
