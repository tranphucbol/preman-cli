# 012: One window, many workspaces, one engine host each

Status: Accepted

## Decision

One window. Workspaces are switched in place from a dropdown at the top left, not opened in
separate windows.

Each open workspace gets its own engine host. Hosts are spawned lazily on first use and reaped
after five minutes idle (`HOST_IDLE_MS`). A host that dies is respawned up to three times
(`HOST_RESPAWN_LIMIT`) before the failure is surfaced.

## Rationale

One window because the alternative is per-window menu state, per-window updater behaviour, and the
question of which window owns a modal — all paid for a feature the users did not ask for.

A host per workspace because by decision 003 core is synchronous, so two workspaces sharing a host
would serialise: a collection run in one would freeze the tree in the other. Isolation also means
a proto cache and a body store scoped to the workspace that filled them, and a crash in one
workspace's engine that does not take the other down.

Reaping is the counterweight. Without it, a day of switching between six workspaces holds six Node
processes. Five minutes is long enough that switching back and forth is warm — the budget for a
warm switch is 100ms and is asserted — and short enough that the abandoned ones go away.

Respawning is bounded because an engine that dies on start dies on every start, and an unbounded
loop turns a bad `.proto` into a fork bomb.

## Consequences

Switching to a cold workspace pays a process spawn. This is why `HostRegistry.prewarm(root)` exists
and is called at launch for the workspace being reopened — see 016.

The window's identity is the app, not the workspace, so window bounds are stored once rather than
per workspace.

Reaping is observable: come back after lunch and the first interaction is slower. Considered
acceptable against holding idle processes all afternoon.
