# 051: Cancel reaches the socket

Status: Accepted

Supersedes the cancellation half of 002's process model as it was built: the Cancel button now
stops the exchange, not only the reporting of it.

## Decision

`AbortSignal` is threaded through core's send path. `HttpInvokeOptions`, the gRPC `InvokeOptions`,
`RunOptions`, `ScriptOptions` and `RunSelectionArgs` each take an optional `signal`, and the engine
host gives every run an `AbortController` whose signal it passes down and whose `abort()` the
`cancel` request calls.

The signal reaches four places:

- the HTTP request, which is `destroy()`ed rather than merely left unread;
- the gRPC call, which is `cancel()`led and reports `CANCELLED` like any other non-OK status;
- `pm.sendRequest`, by the same route `tlsCerts` already travels, because a script's call is the
  other place a cancelled run can still hold a socket;
- the group loop, before each request and again after `--delay-request`, which stops a cancelled
  collection entering the next one.

A cancelled request still reports. It ends as a transport failure whose message is
`the request was cancelled`, and a cancelled group run gains a fourth `bailReason`, `"cancelled"`.

The host keeps its `cancelled` flag alongside the controller. The flag silences events; the
controller stops work. The reader is told the run is over as soon as the button is pressed, not
when core finishes unwinding.

## Rationale

The previous behaviour was recorded honestly in a comment on `cancelRun`: core had no cancellation,
so an in-flight request ran to completion, its writeback still happened, and what stopped was the
reporting. That was defensible while every response was finite. `invokeHttp` buffers to `res.end`,
and for a normal response `end` always arrives — at worst at `--timeout`, which destroys the socket
itself.

A `text/event-stream` response breaks that assumption. It ends when the server decides, which for a
subscription or a stalled completion may be never, and the whole point of clearing the exchange
timer for a stream (052) is that `--timeout` no longer rescues it. Without a
real abort, pressing Cancel on a stream would leave a socket open in the utility process, its run
entry deleted, its events discarded, and nothing left holding a reference that could ever close it.
The button would be a lie in a way it previously was not, and the leak would be per press.

The alternative — cancel by tearing down the utility process — was rejected. It is a real option and
it does free the socket, but it takes the body store, the catalog, the proto cache and every other
run in that workspace with it (012), which turns a per-request Cancel into a per-workspace one.

Threading the signal is unremarkable plumbing except for one thing worth saying out loud: it is the
first argument core takes that is about _stopping_, and it does not make core asynchronous in any
new way (003 is untouched — the send path was already the async part).

## Consequences

`req.destroy(new Error(...))` surfaces through the existing `error` listener, so an abort reaches
the caller by exactly the path a timeout already took, and needed no new failure shape. The cost is
that the two are distinguished only by their message.

`aborted` is a readonly property, so the compiler narrows it. The group loop asks twice around an
`await`, and the second check had to move behind a `cancelled(signal)` function or TypeScript would
insist the answer was still `false`. That function exists for the type system, not for the reader,
and the comment on it says so.

A cancel that lands while a script is running still waits for that script: the sandbox's own
`timeoutMs` bounds it, and interrupting `node:vm` mid-execution is a different problem. The window
is therefore up to one script timeout, not unbounded — the socket, which was the unbounded part, is
gone.

The CLI gains a `stopped early: cancelled` line it cannot currently produce, since only a window has
the button. It is written anyway: `main(argv)` is exported, an embedder can pass a signal, and a
reason with no line to print is how a report goes quiet about the thing the reader most needs.

`dispose()` now aborts as well as silencing, so closing a workspace cannot leave a stream reading
into a host nobody is listening to.
