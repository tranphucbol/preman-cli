# 046: A request is named by its file, and a run that never opened still reports

Status: Accepted

## Decision

Two rules, one for each half of a request that could not be reached.

**A request is addressable by its file.** `RequestEntry` gains `file`, the workspace-relative
posix path — the same string as `CatalogNode.id` — and it is the only field on the entry that is
unique. `resolveSelector` gains a first tier that matches it, consulted only for a selector ending
in `.request.yaml` so no ordinary name can fall into it. Candidates are labelled by
`targetLabels(targets)` rather than `targetLabel(target)`: whether two rows read alike is a
property of the pair, so only the colliding rows are suffixed with their file. The desktop's
`selectorFor` returns that file for a request instead of rebuilding a name path.

**A failure before core opens the run is attributed to the node the window asked for.** When
`startRun` catches a throw and no `run-start` ever passed through the sink, the engine host
synthesises the report core could not: `run-start`, then — only if the node is a request —
`request-start`, a `response-failure` with `stage: "build"`, and `request-end`, then `run-end`.
The renderer's `finish()` materialises a run rather than returning `{}` for a runId it never saw.

## Rationale

A workspace had two requests in one folder both named `Freeze`. That is not a corruption: preman's
own import writes `Freeze (2).request.yaml` through `resolveCollision` and keeps the `name` the
author gave, because renaming what someone wrote is worse than a duplicate.

`RequestEntry.path` is built as `parent.path + "/" + name`, so both entries had the same path, and
every selector tier matched on display names only. The result was a request that could not be run
by any string at all, and an ambiguity error that listed its two candidates as the same six
characters twice. "Never guess what the user meant" held; "list the candidates" degenerated.

The window was worse, because it already knew the answer. `nodeId` is a file path and is unique;
`selectorFor` converted it into a name path and handed core an ambiguity it had not been asked to
resolve. The app then dropped the result: `selectTarget` runs before `run-start` in
`api/run.ts`, so nothing was emitted, and `finish()` began `if (run === undefined) return {}`.
Clicking the request produced no error, no failure, and — if it had ever succeeded before — the
previous response, still on screen, with nothing saying the send had failed. The store already
carried a comment admitting `run-end` could not be relied on, and discarded the error anyway.

Rejected, for the identity half:

- **Make `path` unique with an ordinal.** `payment/Freeze#2` is stable only until a sibling is
  added or `order` changes, and it would appear in reports, in `--reporter json`, and in anything
  a user had scripted. The file is already unique, already stable, and already the thing the user
  can open.
- **Disambiguate by picking the first.** This is the rule ambiguity exists to refuse.
- **Reject duplicate names at load.** It would make a workspace preman itself wrote unloadable.

Rejected, for the reporting half:

- **Emit the failure from core.** Core has no node to attribute it to. The failure _is_ that it
  could not pick one; `runSelection` receives a selector string and nothing else. The host is the
  only layer holding both the `nodeId` the window sent and the throw.
- **Add `nodeId` to the `run-done` push and select on it in the renderer.** It needs a run-level
  error path in `ResponsePane` beside the item path, an ordering rule to decide which outranks a
  stale response, and it still leaves the in-flight window blank. Synthesising the events reuses
  the failure rendering that ADR 019 already built.

## Consequences

`walk()` in `workspace/collections.ts` now takes the workspace root so it can compute `file`, and
`collections.ts` imports `nodeIdFor` from `paths.ts`. Anything constructing a `RequestEntry` by
hand gains a field; the compiler names them.

The host now emits `RunEvent`s that core did not, which is a fence this repository has otherwise
kept: events come from the engine. The narrow justification is that these describe a run core
declined to start, so there is no event core could have emitted without inventing the same thing
one layer down, with less information. `stage: "build"` is reused rather than a new `selection`
stage added, because the reader's question — did this reach the wire? — has the same answer, and a
new variant would cost every consumer an arm to render identically.

A group whose run never opened gets `run-start` and `run-end` and no invented request row.
`RunnerPane` already paints a run's own `error`, and fabricating a row for a group would put a
name in the list that is not a request.

`targetLabels` is exported from `@preman/core` and the interactive picker in `packages/cli` now
builds its rows from it, so the string the filter matches and the string the user reads are the
same one. The ambiguity error is two columns of plain text with no separator; it is aligned by a
double space, not by padding, so a long path does not reflow the block.

The cost this does not solve: `preman list` still prints both `Freeze` rows identically, because
it renders a tree and not a candidate set. A user who has never hit the ambiguity error has no way
to see, from `list` alone, that two rows are different requests.
