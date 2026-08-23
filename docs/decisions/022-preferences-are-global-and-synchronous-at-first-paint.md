# 022: Preferences are global, and read synchronously at first paint

Status: Accepted

## Decision

Appearance preferences — theme, density, editor font size, and an optional mono and sans family —
are one global record in app state, next to the window bounds. Not per workspace, not per tab.

The preload reads them with `ipcRenderer.sendSync` and exposes them as a plain value,
`window.preman.preferences`. `renderer/main.tsx` applies them to `documentElement` _before_
`createRoot().render()`.

`Preferences` was added to `AppState` without bumping `STATE_VERSION`, and `reconcile` merges the
stored record over the defaults field by field.

Two values are denormalised into the stored record: `canvas` and `barHeightPx`. They are a cache of
what the chosen theme and density resolve to, written back whenever either changes.

## Rationale

The whole decision is one requirement: no flash. A tool that opens white and turns dark a frame
later is a tool that looks broken every single time it starts, and the frame is not hypothetical —
it is the round trip from renderer boot to an async IPC reply.

`index.html` sets `script-src 'self'`, so the usual trick — an inline bootstrap `<script>` in the
document head — is not available. The remaining options were an async read with a hidden body, or a
synchronous one. `sendSync` blocks the renderer for well under a millisecond at a point where it has
nothing else to do, and there is precedent already in the bridge: `titleBarGutter` is exposed the
same way, as a value rather than a call.

The denormalised `canvas` and `barHeightPx` exist because the main process constructs the window —
`backgroundColor`, and the traffic light position — before any renderer exists to tell it what the
theme is. Main could import the theme table, but then main knows about themes, and the whole point
of `apply.ts` is that exactly one module does. Caching two resolved numbers keeps the fence intact.

Not bumping `STATE_VERSION` is deliberate. `reconcile` returns defaults _wholesale_ on a version
mismatch, so bumping would throw away every user's workspace list and window bounds to add a field
that has a perfectly good default. Merging field by field means an old state file gains defaults for
what it lacks and keeps everything it has.

Global rather than per workspace because appearance is a property of the person, not of the project.
Nobody wants the app to get darker when they switch to the staging workspace.

## Consequences

**One launch of staleness.** If a theme's canvas colour changed under a user — which today can only
happen by regenerating the themes — the window's `backgroundColor` is right one launch late. It is
the paint behind the app during the first frames; nobody will see it, and the alternative is main
knowing about themes.

**`sendSync` is a blocking IPC call, and it is the only one.** It is fine here because it happens
once, before first paint, on a renderer that has nothing to do. Adding a second one anywhere else
is a different decision and should be made as one.

**Applying before render means `apply.ts` cannot use React.** It is a plain function over
`HTMLElement`, which is also why it is testable against a recording stub rather than a DOM.

**A future per-workspace override has a migration.** Making appearance per workspace later means
moving the field, and moving it means either a version bump or a merge path. The global record was
chosen knowing that; recording it here is so the next reader knows it was chosen and not defaulted
into.
