# 024: The console repeats the response pane

Status: Accepted

## Decision

The console drawer logs every HTTP and gRPC call the app makes, as a third row kind interleaved with
script logs and `pm.sendRequest` summaries by arrival order. The call row is expandable, and expanded
it shows request headers or metadata, request body, response headers, status, duration and a clamped
response body — all of which the response pane already shows.

Three things follow, and they are the decision:

| #   | Consequence chosen                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `request-sent.sent` stops being `unknown` and becomes a discriminated `SentRequest` union on the public surface, with gRPC metadata added to it. |
| 2   | The renderer grows a second body-rendering path — a clamped `<pre>` — beside `BodyViewer`.                                                       |
| 3   | Two places in the app answer "what did the server say", and they answer it at different depths.                                                  |

The row takes its place in the console at `request-sent`, not at `request-start` or `request-end`, so
pre-request logs sort above it and everything it caused sorts below it. It parents both other row
kinds: the call sits at the outer indent and logs and side requests indent under it, which inverts
the previous layout.

The clamp is two caps, `CONSOLE_BODY_LINES = 12` and `CONSOLE_BODY_CHARS = 2000`, and its footer is a
button that focuses the response pane. The console owns the bounded view; the pane keeps the
windowed one.

## Rationale

The drawer used to render exactly two row kinds, and the call the reader pressed Send for was the one
thing missing from it. A pre-request log, a token refresh and a post-response assertion all appeared
in order, with a hole where the actual request went. In a five-request collection run that made the
console one flat stream with nothing to divide it, because the only thing that could have separated
the runs was the request itself.

The cheap alternative is real, and it was rejected: collapsed rows only, clicking one calls
`focus(runId, itemKey)`, zero duplication, no core change, no expansion state. One fact decided
against it. `BODY_RETENTION = 20` in `packages/desktop/src/engine/bodies.ts` means the engine keeps
the last twenty response bodies, so focusing the four-hundredth-from-last call in a long run produces
a dead handle and the error "the last 20 response bodies are kept". The `preview` string, by
contrast, arrived inline on the `response-body` event and is retained in the renderer for the life of
the run. **Expansion survives eviction; focus does not.** A console whose rows go blank the moment
they are worth reading is a console you stop trusting, which is the same argument the drawer's header
comment already makes about truncation.

`sent` had to be retyped rather than annotated. It carried two incompatible shapes with no
discriminator — `{ method, url, headers, body }` for HTTP and the bare request message for gRPC — and
a renderer could not statically tell them apart. `ResponsePane` had sidestepped this by JSON-dumping
the whole thing into a read-only editor, which works precisely because it never has to know which
shape it holds; a row with a headers table does. Adding a `protocol` field beside an `unknown` would
have left the `unknown` in place, so the union removes it instead.

gRPC sent metadata was added to the union in the same change. It was computed in `runGrpcRequest` and
handed to `invokeUnary`, but never put on the event; it survived only in the batch
`GrpcRunOutcome.metadata`, which the engine does not forward. Without it the gRPC row would be a bare
JSON message while the HTTP row was a full request, and the console would be honest about one
protocol and not the other.

## Consequences

**`sent` changes type on the public surface.** `SentRequest` is exported from `@preman/core`, and
`RequestRun.sent` in the renderer store goes from `unknown` to `SentRequest | null`. `sentText` in
`ResponsePane` now dumps the payload rather than the envelope, so the Request tab does not grow a
`"protocol"` key it never had — a one-line change with no visible drift, in a pane this work was not
otherwise asked to touch.

**Two places render a body, and they will drift.** `BodyViewer` is a windowed CodeMirror instance
over a handle the engine holds; the console row is a clamped `<pre>` over a string the event carried.
The second one deliberately has no syntax highlighting: `CodeEditor` is a CodeMirror instance per
decision 014, and mounting one per expanded row in a virtualized list is not a thing to do casually.
A reader who wants the body highlighted, searchable or whole clicks the row and gets the pane.

**The console drawer stops being a fixed-height list.** `ROW_HEIGHT` stays correct as `estimateSize`
and every collapsed row is still 28px, but an expanded one holds many lines and is measured. The
virtualized-rows section of `docs/design-system.md` gained a sentence saying so; without it that
table now reads as a claim the console no longer meets.

**This puts a pre-existing leak on screen without fixing it.** The renderer's `requests` Map is never
pruned, and each entry holds a `preview` of up to `PREVIEW_BYTES = 256 * 1024`. A five-thousand-request
run already retains on the order of a gigabyte of preview text. Nothing rendered it before, which is
why nobody had noticed; this is the first thing that does, so a reader who profiles the app after
this ships will find it. Pruning `requests` changes what the runner list and the response pane can
show for an old item and needs its own decision, so it is named here and left.

**Expansion state lives in the store, not in the row.** `expandedCalls: Set<string>` mirrors
`catalog.collapsed` but is named for the opposite default. The virtualizer unmounts off-screen rows,
so row-local `useState` would silently collapse every open row on scroll. `calls` also gets its own
`CONSOLE_MAX_LINES` cap, for the reason already written next to the console's: a run that logs
nothing would never trip the console's own cap, and the calls would grow unbounded behind it.

**Two defaults were chosen without asking**, and are recorded so they can be objected to. Indent
depth is two rather than three, even though a side request is caused by a script which is caused by
the call: three levels inside a 28px row leaves no room for a URL, and a side-request row is already
distinguishable by its own layout. And the caret expands while clicking the rest of the row focuses
the pane — two affordances in one control, so the deep viewer stays one click away.

Not decided here: copying a call as `curl` or `grpcurl`. The row now holds everything such a command
needs, which makes it the obvious next request, but the renderer has no clipboard call yet.
