# 010: Explicit save, and app state never enters the workspace

Status: Accepted

## Decision

Request definitions are saved explicitly, with a dirty dot and `Cmd+S`. Nothing autosaves to the
workspace.

Open tabs, cursor positions, scroll offsets, window bounds and unsaved drafts go to Electron's
`userData` and never into the workspace directory.

Environment values written by scripts are the one exception: they persist through core's existing
writeback, exactly as they do from the CLI.

## Rationale

The workspace is a git repository. Autosave would mean a background process writing tracked files
while the user is on a branch, and `git status` would never be clean while the app was open. That
makes the app hostile to the workflow it is supposed to serve.

Explicit save also matches Postman, so it costs nothing in familiarity.

Session state is excluded from the workspace for the same reason and a second one: it is per-user.
Committing which tabs someone had open would put a merge conflict between two people using the same
repository.

Script writeback stays because it is existing CLI behaviour, and a request that sets a token for
the next request must work the same way from either surface.

## Consequences

**The app holds state the workspace does not, so a crash can lose work.** Drafts are persisted to
`userData` on a debounce to bound that. The trade is explicit: a draft is recoverable after a
crash, but it is not committable until saved.

`git status` in a workspace stays clean while the app is open, which is what makes the git overlay
in the sidebar meaningful.

`userData` is machine-local. Moving to another machine loses tab state, and that is correct.
