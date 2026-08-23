# 004: The app authors the workspace, so core gains write responsibility

Status: Accepted

## Decision

Full authoring parity: create, rename, move, delete and reorder requests, folders, collections and
environments, and edit every field of a request. The mutations live in `@preman/core`, not in the
app.

## Rationale

A client that can only run what someone else wrote in a text editor is a viewer. Parity with
Postman means the workspace is editable from the window.

Putting the mutations in core rather than in the desktop package is the part worth arguing. Core is
where the schemas are, where `PremanError` and the exit codes are, and where the CLI could one day
need the same operations. More importantly, the invariants being protected are not UI concerns:
a move into a node's own descendant is a corrupt workspace whichever surface asked for it.

## Consequences

**This adds write responsibility to an engine that had never had it.** Every previous plan in this
repository extended a read-and-run tool. This one gives core the ability to destroy a user's files.

Atomicity, collision handling and refusing structurally invalid moves are therefore core concerns
with `PremanError` exit codes and actionable `details[]`, not dialogs bolted on in the renderer.

The renderer may compute a _plan_ — a drop plan, a rename target — as pure code under
`src/renderer/model/`, but the engine validates it again before touching disk. The renderer's copy
exists to grey out an impossible drop, not to authorise a possible one.
