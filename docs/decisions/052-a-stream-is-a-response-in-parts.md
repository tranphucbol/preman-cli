# 052: A stream is a response in parts

Status: Accepted

Extends 013. A response body still never crosses to the renderer whole; a `text/event-stream`
additionally never becomes a document.

## Decision

`invokeHttp` takes an optional `stream` sink. A caller that passes one, and only such a caller, gets
a response read as it arrives when the head says `content-type: text/event-stream`. Everything else,
and every caller that passes nothing, is buffered exactly as before.

Handing over a sink changes three things about the exchange:

- `timeoutMs` stops applying once the head has been read. A stream ends when the server ends it, when
  the peer dies, or when the reader cancels (051). Killing it at `--timeout` would be killing the
  feature.
- The head is reported early, carrying `headersMs` instead of `durationMs`, because at that moment
  the exchange has no duration and inventing one would be a lie the reader could not detect.
- The socket dying after the head is no longer a failure. The status was real, the frames were real,
  and the result carries the partial body plus a `cutShort` reason and a warning.

Three `RunEvent`s describe it. `response-head` arrives first with `headersMs`; `response-frames`
repeats, carrying a batch; `stream-end` closes with the `durationMs` the head could not carry, the
count of every frame dispatched, and any `cutShort`. The raw bytes still become one `response-body`
at the end, so the body store, `pm.response`, the reports and the CLI see the response they always
saw.

The renderer keeps a bounded ring of the most recent frames and a total; the Body tab shows them as
a list rather than a document, newest first.

Both front ends decide for themselves. The desktop passes a sink because it has a window that can
show a frame the moment it lands. **The CLI passes nothing**, so `preman run` against a stream
buffers and `--timeout` remains a hard ceiling in a script and in CI.

## Rationale

A completion stream has no document. Four hundred chunks concatenated and pretty-printed produce
something the server never sent and nobody wants to read, and waiting until the last of them to show
the reader anything is the specific failure this feature exists to fix — the response is interesting
for the thirty seconds it is arriving, and interesting mostly at its newest end.

The sink is optional rather than a mode flag because the difference between the two front ends is
real and worth keeping in the type. A window can afford to hold a socket open indefinitely: someone
is looking at it, and there is a button. A CI run cannot; nobody is watching, and the only thing
standing between a hung server and a stuck pipeline is the timeout this feature would otherwise
remove. Making that a parameter of the call rather than a global lets the two answers coexist
without either one being a special case.

Reporting the head early is what makes the elapsed clock in the window worth anything. Without it
the reader stares at `Running…` for the whole stream and the status arrives with the last byte.

The alternative shapes considered:

- **Emit each frame as its own event.** Rejected. A model streaming tokens dispatches faster than any
  window can paint, and each frame crossing the port alone is a structured clone, a message, a store
  write and a React render. The renderer loses that race long before the network does. Batching on a
  32ms tick in the engine is the whole of the fix, and it changes only ordering.
- **Keep every frame in the renderer.** Rejected for 013's reason, which does not weaken just because
  the bytes arrived in pieces. A stream that runs for an hour would cost an hour of heap. The window
  keeps the most recent thousand and says so; the engine still has all of it behind the body handle.
- **Parse SSE in the renderer.** Rejected. It would mean sending the raw bytes across as they arrive,
  which is the thing 013 exists to prevent, and it would put a protocol in the view layer.

## Consequences

`--timeout` now means two different things depending on who is calling, and the only place that is
visible is the presence of a sink. It is documented on the field, and there is a test asserting that
a never-ending stream with no sink still times out — that test is guarding the CLI's contract, not
the transport's behaviour.

A stream that is compressed, or that arrives on a redirect hop, is read the buffered way. The
decompressors here take a whole buffer, and there is not one yet; reading it the old way is correct
where reading it wrongly would not be. A server that gzips an event-stream therefore gets no live
view, silently. That is the right failure but it is a silent one.

`response-head` is no longer the last word on a response, which is a real loosening of the event
contract. Anything that reads `timings.durationMs` off a head must now tolerate its absence until
`stream-end`. Inside the app there is one such reader and it is the elapsed clock, which already had
a number to show meanwhile.

A cancelled stream and a cancelled request now end differently: the request is a transport failure
(051), the stream is a success with a warning. The distinction is defensible — the request never
happened, the stream happened and was stopped — but it means "cancelled" is not one thing in the
codebase, and the two live one function apart in `invoke.ts`.

The frame batcher may drop frames, and reports how many rather than hiding it. It is bounded at 500
per flush, which at 32ms is a rate no server has yet reached in testing; the count exists so that a
reader comparing rows against `stream-end`'s total is told why they differ instead of quietly seeing
a smaller number.

Scripts still see the whole raw stream in `pm.response.text()`, unchanged, but `afterResponse` does
not run until the stream closes. For a subscription that never closes, it never runs. That follows
from the response not being finished, and no useful alternative exists — a test asserting on a body
that is still arriving would be asserting on a coin flip.
