# 047: A body preman parses may carry comments

Status: Accepted

## Decision

A body that **preman itself parses** may contain `//` line comments and `/* */` block comments.
They are removed before it is parsed, and what remains is what goes on the wire. That is two
bodies today: a gRPC request message, and a GraphQL body's variables.

A body preman does not parse is untouched. That is the raw HTTP body, which
`packages/core/src/http/body.ts` sends verbatim.

`packages/core/src/json/comments.ts` holds the mechanism, as a leaf both `grpc/` and `http/` import
rather than one importing the other. It removes by masking, not by deletion: every character of a
comment becomes a space and every line break survives, so the document handed to `JSON.parse` is
the same length and the same shape as the one the author is looking at. A gRPC message that is
nothing but comments is an empty message, on the same grounds an empty body already was, and
GraphQL variables that are nothing but comments send no `variables` key.

The masker tracks whether it is inside a string and honours the backslash escape, so `//` in a URL
and `/*` in a sentence stay data, and a value ending in `\"` does not read as an unclosed string
that swallows the next line. It is not a JSON parser and does not try to be one.

## Rationale

Postman's body editor is a text box, and it drops comments on the way to the wire. People write
them for the reason people always write them: a field that is commented out today is a field that
was there yesterday and will be there again next week. So a body carrying comments is not a
malformed body, it is one preman is expected to understand, and refusing it makes preman stricter
than the tool whose workspace it is reading — which is the one thing this codebase is not allowed
to be by accident.

The trigger was a real workspace. Two fields of a `blockadeRecord` body were commented out, and
the request could not run at all; the parser said `Unrecognized token '/'` and named neither the
line nor the reason, on a body where the offending characters were deliberate.

The alternative was implemented first and then reversed, which is why it is worth recording. It
refused the body and listed every commented line as `details`, on the argument that stripping half
a document is preman guessing what the author meant. That argument is wrong here, and it is worth
being precise about why: a comment is not an ambiguous half of the document. It is the half that
every JSON-adjacent tool in this space, including the one that wrote the file, already agrees is
not data. There is no guess to make. The cost of the strict reading was paid by the author of a
body they had written correctly for Postman.

Masking rather than deleting is decision 023's trick, reused for the same reason and not for
tidiness. Same length means positions map 1:1, so when the parse fails for some _other_ reason the
engine's own `position` still indexes the author's text — two comment lines above a fault do not
shift the line the fault is reported on. Deleting the comments would have required translating
every offset back, which is an operation that can be got wrong; keeping the lengths equal means
there is nothing to get wrong.

The line that failure quotes is best effort on purpose. V8 reports a position for some faults and
not others, and JavaScriptCore reports one for none, so `details` names a line when the engine said
where and stays empty when it did not. An empty `details` is better than a line number invented
from a scan preman would have had to write a second JSON parser to do properly.

The line is drawn at what preman parses, and that is a real boundary rather than a scope excuse. A
gRPC message must be parsed to become a protobuf, and GraphQL variables must be parsed to be
re-serialised into the `{query, variables}` envelope. In both, preman is the thing reading the
text, so a comment in it is unambiguously not data. A raw HTTP body is opaque bytes whose meaning
the far end defines and which preman only interpolates — it might not be JSON at all — so removing
characters from it would be preman editing a payload it does not own.

The first version of this decision said "the gRPC body alone", and it was wrong within a day. It
was written from the request that prompted it and not from the question it claimed to answer, and
it missed GraphQL variables, which sit on the same side of the very line the decision drew — as
decision 023 had already noticed when it listed "the gRPC message, the raw HTTP body, and the
GraphQL variables" as the three editors holding text a human wrote. The rule is stated as a
property now, so the next body preman parses is covered by it rather than by an amendment.

## Consequences

The strict behaviour is gone, and with it the `details` that listed every comment line. Anyone
looking for it will find this file.

A body may now parse that a strict JSON reader rejects, so the two ends can disagree about the same
text. The disagreement is one-directional and quiet — preman accepts a superset — but a body that
round-trips through preman is not proof that the file is JSON.

Trailing commas are still an error. Commenting out the last field of an object leaves the comma
that preceded it behind, and that comma is data, not a comment. The parser's message and the quoted
line are what the author gets, which is the case the position detail was kept for.

GraphQL variables keep their old answer for a genuinely blank string, whatever it is. Only a source
that had something in it and masks away to nothing is treated as absent, so this decision changes
the commented case and nothing else.

The editor had to follow, and did. Left alone it would have called a body broken that the engine
was about to send without complaint — the grammar met a `/` where a property name belongs, and the
worst of it was not the colour: `formatJsonTemplate` gates Beautify on the same parse, so the
button refused a valid body and gave `UNPARSEABLE_REASON` as the explanation, which names a token
used as a key and two adjacent tokens. Neither is present. A wrong reason is worse than no button.

So `packages/desktop/src/renderer/model/comments.ts` is the scanner again, on the renderer's side
of the fence. It is written twice rather than imported because the renderer may not import
`@preman/core`, and that fence is the whole architecture; what is duplicated is a definition of
JSON's syntax, which does not change, and not any of preman's behaviour. The renderer's copy
exports ranges rather than only the masked text, because an editor has to paint what an engine only
has to ignore.

`maskAuthored` composes the two masks, tokens first. A name is not a string, so `{{a//b}}` would
otherwise have its tail blanked as a comment; masked to digits first it is safe, and a token inside
a comment gives the same answer whichever order runs. Both masks preserve length, so the
composition does too, and 023's 1:1 position mapping survives.

Comments are painted from the scan and not from the tree, which is the one place this differs from
every other token in the editor: by the time the grammar runs they are whitespace, which is exactly
what stops them being error nodes. `--syntax-comment` already existed — `theme.ts` has carried
`comment` and `comment-doc` since the generator was written, and all 43 themes define them — so
unlike `--syntax-template` this needed no solver, no audit threshold and no palette work. The scan
runs over the whole document rather than the viewport, because `//` is only a comment when it is
not inside a string and a viewport can start in the middle of one.

The beautifier now treats a comment as a fourth thing it copies through verbatim, beside strings,
numbers and tokens. It is the only one that constrains the layout instead of being laid out: `//`
runs to the end of its line, so a comment is given a line of its own, opened and closed. That is
not a preference — anything left on the line after it would be swallowed. The visible cost is that
a trailing comment written beside a value moves to its own line, which is consistent with a
re-indenter that already derives every other line break from structure rather than preserving one.
A body of nothing but comments is returned unchanged instead of refused, since there is no
structure to re-derive and it will send as an empty message.
