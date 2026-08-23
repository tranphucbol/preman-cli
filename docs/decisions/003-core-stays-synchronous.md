# 003: Core stays synchronous

Status: Accepted

## Decision

`@preman/core` is not converted to `async`/`await` for the desktop app. Only the catalog build and
the file watcher are async. The engine host process is the isolation boundary; `await` is not.

## Rationale

The instinct on putting a GUI in front of a synchronous engine is to make the engine async so it
does not block. That instinct is answering the wrong question here. What must not block is the
thread that paints, and by decision 002 that thread is in a different process. Inside the engine
host there is nothing else to yield to.

`runner.ts` is 831 lines and the hottest file in the repository. Threading promises through it
would touch every line of the code that the e2e suite asserts byte-for-byte on the wire, in
exchange for concurrency that a one-request-at-a-time engine cannot use.

The catalog build is async because it is I/O over hundreds of files and is the one operation whose
latency the user feels as a blank sidebar. The watcher is async because it is an event source.

## Consequences

Two long-running operations in one host serialise. In practice the operations are a run and a
catalog refresh, and a user who starts a run does not simultaneously need the tree rebuilt.

A second workspace gets a second host rather than a second thread of control, which is why
decision 012 spawns per workspace.

If streaming gRPC or websockets ever ship, this decision is the first one to reopen — those are
genuinely concurrent, and they are out of scope for v1 partly because of this.
