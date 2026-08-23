# 019: The failure crosses the wire

Status: Accepted

## Decision

`RunEvent` gains a `response-failure` variant carrying a `stage`, the `message`, its actionable
`details`, and the gRPC `trailers`. It is emitted whenever a request produced nothing the reader
can inspect, in one of two stages:

| `stage`     | Emitted when                                                                                                           | Carries                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `transport` | a gRPC call returned a non-`OK` status, or an HTTP request never got a response                                        | the server's or socket's own words, plus gRPC trailers            |
| `build`     | `runRequest` threw before anything reached the wire — a missing proto, an unparseable request, an unsupported protocol | the `PremanError`'s `message` and `details[]`, never any trailers |

HTTP 4xx and 5xx do not emit it, because they have a body and that body is the server's own
account of the error.

This is the first `RunEvent` that exists because the window needs it and the CLI does not.

`stage` is on the event rather than inferred in the renderer because it cannot be inferred: a
build failure and an HTTP transport failure both arrive with no `response-head`, and "no response
arrived" is the wrong thing to say about a call that was never placed.

## Rationale

`packages/core/src/api/events.ts` opened with the claim that the batch `RunOutcome` is the
authority and that the streamed events exist only so the window is not blank until it arrives.
Under that reading, a failure needs no event: the outcome carries `invoke.message`, and the CLI
prints it.

The desktop app does not consume the batch outcome per request. It assembles `RequestRun` from
events (`packages/desktop/src/renderer/stores/runs.ts`). So a rejected gRPC call reached the
window as a red status name on the summary row and, in the Body tab, the sentence "This request
returned no body." The server had said why it refused — `Not found app_id=100331.` — and the app
discarded it. The reader's next move was to leave the window and run the same call through the
CLI, which is the round trip the desktop app exists to remove.

Three alternatives were considered and rejected:

- **Forward the batch outcome per request.** It is much larger than the failure, it duplicates
  everything the events already delivered, and it would make the store's assembly path conditional
  on which source arrived first.
- **Put `message` on `response-head`.** A field that is meaningful for one status and empty for
  every other is a field every consumer must learn to ignore. It also has nowhere to put trailers,
  and no answer for HTTP, which emits no head at all when nothing arrived.
- **Synthesise a body containing the error text.** It would make the failure indistinguishable
  from a server that genuinely returned that text, and it would go through the `BodyStore` — a
  handle, a publish, a window fetch — for one sentence.

## Consequences

The header comment in `events.ts` no longer holds without qualification, and now says so. Every
`RunEvent` consumer gains a variant to handle; today that is `applyToItem` in the runs store,
which is exhaustive over an `Extract`, so the compiler names the omission.

Trailers now reach the window on a failure and still do not on a success. That asymmetry is
deliberate — a rejection is where servers attach structured detail — and it is narrow enough to
close later by widening `response-head`, rather than something this decision should pre-empt.

`details` duplicates lines that also arrive in the run's `warnings` at `run-done`, so a TLS
handshake hint appears both in the failure block and in `RunnerPane`'s warning list. Accepted: a
single-request user never opens the runner, and a hint about the flag that would fix the handshake
is worthless one pane away from the handshake that failed.

The `build` stage means one event now fires from a `catch` that previously only closed the row.
The throw still propagates unchanged, so the CLI's exit path and message are untouched; the event
is additive. `givenRequestThatCannotBeSent_whenRunning_thenTheRowIsStillOpenedAndClosed` asserts
the exact event sequence and was updated to expect the failure between `request-start` and
`request-end` — a reminder that any future emission from that `catch` is a visible contract change.

The CLI is untouched. `requestEvents` returns `NO_REQUEST_EVENTS` when no sink is passed, so the
whole feature still costs one `undefined` check when nobody is listening, and
`givenCliRun_whenNoSinkPassed_thenOutcomeIsByteIdenticalToBefore` still passes.

Not decided here: decoding `grpc-status-details-bin` into `google.rpc.Status`. The trailer travels
as the base64 the server sent. Decoding it means resolving `google.rpc.*` descriptors at response
time, which is a change to `packages/core/src/grpc/schema.ts`, not to this event.
