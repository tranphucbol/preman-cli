# 008: React 19 with Zustand

Status: Accepted

## Decision

The renderer is React 19. State is Zustand, one store file per subscription surface: catalog, tabs,
runs, session.

## Rationale

The framework is not the performance lever here, and choosing one as if it were would be choosing
for the wrong reason. A virtualized viewport reconciles about forty rows; React does that in 1-2ms,
and so would Solid, Svelte or Vue. The budget in `docs/performance.md` is met by virtualizing the
tree and keeping the engine in another process, not by the diffing algorithm.

React wins on the three libraries that cannot reasonably be avoided:

- **TanStack Virtual** for the sidebar and the body viewer,
- **dnd-kit** for reordering and moving nodes,
- **react-resizable-panels** for the pane layout.

Each is the best-in-class implementation of a problem that is genuinely hard to get right —
particularly drag-and-drop across a virtualized tree — and reimplementing any of them to use a
smaller framework would spend the entire budget the smaller framework was chosen to save.

Zustand rather than Context because the subscription granularity matters: a keystroke in one tab
must not re-render the sidebar. One store per surface makes the subscription boundaries the file
boundaries.

## Consequences

React 19's compiler is not enabled; memoisation is manual where it is needed and absent where it is
not, and `docs/performance.md` is what says whether it is needed.

The renderer bundle is about 1MB minified. It is loaded from disk, not the network, and accounts
for roughly 250ms of a ~550ms warm start — inside the 800ms budget, and the obvious lever if that
row ever gets tight.
