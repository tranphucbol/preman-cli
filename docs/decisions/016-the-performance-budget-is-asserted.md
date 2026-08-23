# 016: The performance budget is an assertion, not an aspiration

Status: Accepted

## Decision

Every row of the budget in `docs/performance.md` is a test that fails, or is marked `not asserted`
in the table so that the gap is visible.

`test/perf.test.ts` holds the rows that need no window and runs with the normal suite.
`test/renderer/perf.app.test.ts` holds the rows that need a real window, launches Electron eight
times, and is gated behind `PREMAN_PERF=1`.

The budget table lives in `docs/performance.md`, which is tracked, and not in the plan, which is
not.

## Rationale

A performance target in a document is a target nobody is measuring. The failure mode is not that
someone ships a regression deliberately; it is that the app gets 15% slower every quarter and no
single change is ever the one to blame.

The gated split exists because a perf suite that makes `bun run test` slow gets deleted within a
month. Catalog builds are a function call and cost a second, so they run always. Launching Electron
eight times costs half a minute, so it does not.

The location matters as much as the content: `docs/plans/` is gitignored — only `TEMPLATE.md` is
tracked — so a budget kept there is absent from a fresh clone. A contract nobody else has is not a
contract. Same reasoning as this directory existing at all.

## Consequences

Two rows are read differently from how the plan phrased them, and both readings are argued in
`docs/performance.md`:

- **Idle RSS is gated at 450MB against a 250MB goal.** 250MB is a private-footprint number and
  macOS does not report one — `privateBytes` is `0`, and `workingSetSize` charges the shared
  Chromium framework once per process across all five. Measured idle is ~372MB. A gate that cannot
  pass is not a gate; this one still catches a leak or an unintended sixth process.
- **"Sustained 60fps" is asserted as no dropped frame**, meaning no interval of two refresh
  periods. Under vsync, "no frame exceeds 16ms" can neither pass nor fail.

One row remains genuinely unasserted: **send to first response paint**. It needs a live server
fixture and instrumentation from the `response-head` push. Recorded as outstanding work, not as a
design exemption.

Measuring the budget changed the product once already. Cold start was 1750ms because
`utilityProcess.fork` ran on `did-finish-load`, serialising a Node boot after Chromium's for no
reason — the engine host is a Node process and the window is a Chromium one, and nothing orders
them. `HostRegistry.prewarm(root)` forks at launch; warm start is now ~550ms.

The thinnest row is `buildCatalog` over 1000 requests: 294ms against 400ms, of which 200-270ms is
`yaml.parse`. Left alone deliberately — a partial header reader would be a second YAML parser free
to drift from `readRequestHeader` — and when it does fail the fix is an mtime cache, not a faster
guess at the syntax.
