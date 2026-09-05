# 048: The comment shortcut is offered wherever a `{{token}}` is

Status: Accepted

## Decision

`Cmd+/` toggles `//` line comments in every editor on the `json-template` language. That is the
gRPC request message, the GraphQL variables, and the raw HTTP body — all three editors that hold a
body somebody typed, and not only the two whose comments preman removes before the wire.

It is implemented as two markers and nothing else. `commentTokens` is published into the language
data of `jsonTemplate()`'s `LanguageSupport`, taken from `renderer/model/comments.ts` rather than
restated, so what the keystroke writes is by construction what the mask blanks and the painter
paints.

Plain `json` — the response body, the sent-message view, the preview — publishes nothing and the
shortcut stays inert there.

## Rationale

The binding was never missing. `defaultKeymap` has bound `Mod-/` to `toggleComment` since the
editor was built, and the command reads `commentTokens` out of the language data at the caret and
returns `false` when nobody published any. `@codemirror/lang-json` publishes none, correctly:
JSON has no comments. So the shortcut already worked in scripts, in the settings YAML and in XML,
and did nothing at all in the one place 047 had just made comments legal. Two markers were the
whole gap, which is worth writing down because it is the shape of the test as well — an assertion
about `COMMENT_TOKENS` would have passed against the version where pressing the key did nothing.

The interesting part is the raw HTTP body, because 047 draws a line that this decision crosses.
That decision's line is what **preman parses**: a gRPC message and GraphQL variables are parsed, so
a comment in them is unambiguously not data and is masked away; a raw HTTP body is opaque bytes
whose meaning the far end defines, so `http/body.ts` sends it verbatim. Under that line, `Cmd+/` in
a raw body writes two characters that go on the wire.

It is offered there anyway, for the reason the editor already paints a comment there: the raw body
editor is on `json-template`, and the alternative is an editor that colours `//` as a comment,
accepts it through Beautify, and then refuses to type one. A shortcut that works in two of three
identical-looking panes is a worse thing to explain than a body that says what it contains. The
author of a raw body is the author of every byte in it — that is what "verbatim" means — and the
keystroke does not hide what it wrote.

The alternative was real and was considered: thread a flag from the two panes that parse, through
`CodeEditor`, into `jsonTemplate()`, and leave the raw body without tokens. It is more faithful to
047 and it was rejected on cost against benefit. It adds a prop to the one editor component the app
has, to make a keystroke conditional on something the reader cannot see, while leaving the
painting — the louder signal, and the one that actually suggests `//` is safe — untouched. If the
raw body should not look like it takes comments, the thing to change is the painting, and that is a
larger decision than this one.

## Consequences

`Cmd+/` in a raw HTTP body produces a payload containing `//`, which the server receives. Nothing
warns. This is the cost, it is stated here rather than discovered, and it is the paragraph to
reopen if it turns into a support question.

`renderer/model/comments.ts` now exports its three markers. It was already the definition of what a
comment is on this side of the fence; it is now the definition in both directions, so a scanner
that learned a fourth form could not ship without the keystroke learning it too.

`vitest.config.ts` aliases `@codemirror` into the desktop package, and `test/renderer/tsconfig.json`
maps it the same way. CodeMirror is a dependency of `packages/desktop`, so a test at the repo root
cannot resolve it by walking up, exactly as `electron` could not. It buys running `toggleComment`
for real: it is a `StateCommand`, so it needs an `EditorState` and not an `EditorView`, and a suite
with no DOM can therefore assert the document that comes back rather than the constant that went
in.

`block` is published and no binding reaches it. `toggleComment` takes `line` whenever a language
has one and never consults `block`, so the shortcut is whole lines however small the selection.
The pair is published because the facet describes the language — 047 made both forms legal in the
file — and not because the keymap uses both; `lang-javascript` publishes the pair on the same
grounds. One test holds it, since nothing else would notice it drifting.
