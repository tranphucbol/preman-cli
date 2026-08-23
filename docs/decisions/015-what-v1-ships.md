# 015: What v1 ships

Status: Accepted

## Decision

**v1**: the core authoring and running experience, plus the collection runner, the proto method
picker, the command palette, bulk-edit for headers and params, global search, and a git status
overlay in the sidebar.

**v1.1**: cookie manager, TLS settings UI, response history.

**Dropped, not deferred**: OpenAPI import, code generation.

Also out of scope, and named so the boundary is not argued twice: streaming gRPC and websockets,
cloud sync, converting core to async, script type checking, Tauri.

## Rationale

The v1 line is drawn at "can this replace Postman for the work these files are for". The runner,
the picker and the palette are on the daily path. Cookies and TLS have working CLI flags and
config, so their absence in the UI is an inconvenience rather than a blocker — the capability is
there, only the affordance is missing.

OpenAPI import and code generation are dropped rather than deferred because they are a different
product. Both are conversion tools between formats, neither is on the path of running a request,
and each is large enough to fund itself. Leaving them on a roadmap invites them to be half-built.

## Consequences

The v1.1 items must be reachable without redesign: cookies and TLS already have engine-side
implementations and protocol space, so adding the UI is additive.

Streaming being out of scope is load-bearing for 003. If it comes back, core's synchrony is the
first decision to reopen, not the last.
