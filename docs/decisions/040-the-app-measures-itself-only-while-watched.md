# 040: The app measures itself, only while watched

Status: Accepted

## Decision

Settings gains a third tab, `Resources`, listing one row per Chromium process the app owns: a label,
CPU as a percentage, working set, peak working set, and a sparkline of that process's CPU over the
last minute. The rows are named rather than numbered — `Main`, `Window`, `GPU`, and one
`Engine — <workspace>` per open host, recovered by reversing the `SERVICE_NAME_PREFIX` that
`hosts.ts` gives each `utilityProcess`.

The only source of those numbers is `app.getAppMetrics()`, and it is only callable in main. The
renderer fence forbids `electron` outright, so the sample travels over the preload bridge —
`CHANNELS.resourceSample` out, `CHANNELS.watchResources` back — and not over 002's port. The engine
host is a subject of this measurement, not the measurer.

**Nothing samples until a panel asks.** Mounting the tab sends `watchResources(true)` and unmounting
sends `false`; between those two the sampler holds a one-second interval, and outside them it holds
no timer at all. An app with the tab shut does exactly what it did before this record.

The first read after `watch(true)` is taken and thrown away. `percentCPUUsage` is an average over the
interval since that process was last sampled, so the first read after a gap is an average over the
gap.

The numbers are reported as Chromium gives them. `workingSetSize` counts the shared Chromium
framework once in every process that maps it, which is why `docs/performance.md` gates idle RSS at
450MB against a 250MB goal it measures as roughly 372MB. The pane says that in a line of prose under
the total instead of correcting the total.

`ui/Sparkline.tsx` is the second indicator in the app, and it takes its colour from its caller.

Colour on the table is a **magnitude scale and not a fault scale**. A row's CPU figure and its line
share one band — `ok` under 15% of a core, `warn` under 60%, `danger` above — read once per row and
resolved through `toneClass()` in `model/response.ts`, which already owned the only tone-to-class map
in the renderer. The total row is not banded, because a sum across five processes is not a per-core
reading of anything. A legend under the table says the colours mean size rather than health, in
words, because a red row during a collection run is the engine doing what it was asked to.

Nothing about this reaches `preman.log`: 035 fenced that file to lifecycle and failure, and a metric
is neither.

## Rationale

016 made every performance number a test that fails, and 030 then took the three clock budgets out of
CI because a two-core shared runner cannot hold them — so the enforcement point for those rows is a
developer choosing to run them locally. 027 is the record that responded to a related gap with an
instrument rather than a number: opening a large workspace was slow, and 002's port had no way to ask
which of the three processes was slow. This is that argument applied to steady state instead of to
launch. The idle RSS row is the clearest case: the gap between its goal and its gate is entirely a
per-process fact, the record of it lives in a paragraph of `docs/performance.md`, and the app itself
has never been able to show anybody which process is holding what. A developer watching this app get
heavy has had the same tools as a user, which is Activity Monitor and a guess at which `Utility` is
which.

The bridge rather than the port, for two reasons that point the same way. The first is mechanical:
only main can call `getAppMetrics`, and it reports on every process, so routing it through a host
would mean a process reporting on its siblings through a channel it does not own. The second is that
012 gives each workspace its own host and 013 keeps response bodies inside it, which makes the engine
host the single process whose memory a reader most wants to watch — and the process you most want to
watch is the worst possible choice of reporter, because the interesting reading is the one taken
while it is thrashing, and the interesting failure is the one taken after it is gone. Main outlives
every host by construction, including the ones `HOST_RESPAWN_LIMIT` gave up on.

The gate is the part of this record that does real work. 017 measured the idle app blocking its own
main thread for 7-16ms periodically, which is above the tab-switch and the keystroke budget both, and
an always-on sampler adds a walk of the process list, an IPC hop, a store write, a React commit and a
repaint to every second the app is open — forever, for a readout nobody has asked to see. It would
also be measured by the very row that motivated it: the idle RSS assertion reads `getAppMetrics` after
a three-second settle, so a permanent sampler is a feature that moves its own headline number. Gating
on visibility makes the idle app byte-identical to the one before this record, and that is the only
version of this feature that does not have to argue with 016 to exist.

Discarding the first read is not tidiness. Without it, the number on screen for the first second after
opening the tab is the average CPU since the app started, which on a cold launch is 029's four-second
faker-and-grpc-js evaluation smeared across however long the window has been open. It would read as a
live figure, it would be wrong by an order of magnitude, and it would be wrong in the direction that
makes people file bugs.

Reporting `workingSetSize` raw is the same choice 032 made about the Linux watcher: say the true
thing in prose rather than encode a correction nobody can audit. The alternative on the table was to
subtract an estimate of the shared framework, or to show only private bytes. Both produce a pane whose
total disagrees with Activity Monitor, which is precisely the tool a reader will open next to it, and
a monitor that loses that comparison is a monitor nobody trusts for the reading it got right.

The sparkline has to answer `Progress.tsx`, which says of itself that it is an indicator and there is
exactly one of them. That rule holds and this does not break it, because the rule is about a
proportion: `Progress` takes a numerator and a denominator that cannot be revised, and its own
docblock rejects the cases where the denominator moves. A sparkline has no denominator. What 017's
motion argument actually forbids is a per-frame tween of a layout property, and this is not one — it
is a discrete repaint, once per second, of a fixed-size SVG with a fixed `viewBox` and no transition
on it, so nothing interpolates and nothing reflows. `vector-effect="non-scaling-stroke"` is what lets
it stretch to the row without the stroke distorting, and `aria-hidden` is honest: the CPU percentage
is in text on the same row, and the line is a second reading of a number that is already there.

It earns the tab because a single instantaneous percentage answers the wrong question. The reason
anybody opens this pane is that something felt slow a moment ago, and one sample cannot distinguish a
process that is spinning from a process that was caught mid-work. Sixty of them can, by eye, without
a legend. The y axis scales to the highest sample in the window and not to 100, because a process at
0.3% would otherwise be a flat line at the bottom on every row — and it scales to a _floor_ of
`SPARKLINE_MIN_CEILING_PERCENT` and not to the observed maximum alone, because an idle process
autoscaled to its own noise draws a mountain range out of rounding.

## Consequences

**You cannot see a spike you were not already watching.** The history is per-open and dies with the
tab, so the pane is useless for the report that begins "it locked up for a second an hour ago". That
is the bill for the gate and it is the whole cost of this record. Paying it would mean a ring buffer
in main and a sampler that never stops, which is the decision made here and made the other way; if it
is ever wanted, the reversal is that buffer plus a re-baselined idle RSS row, and it should be a new
record rather than a quiet change to the interval.

`Progress.tsx`'s "there is exactly one of them" is now false as written, and its comment changes to
say why there are two and what separates them — a proportion from a history — so the next reader is
held to the same argument rather than to a count. `docs/design-system.md`'s indicator section gains
the sparkline for the same reason.

**CPU is converted, and it is the one number that is.** `percentCPUUsage` is a percentage of the
whole machine rather than of one core, which the name does not say and Electron's documentation does
not either. Measured against `cumulativeCPUUsage` — CPU-seconds, and therefore ground truth — a
process pinning exactly one core for three wall seconds spends 3.0 CPU-seconds and reports `9.999`
on a ten-core machine: Chromium divides by the processor count. The sampler multiplies it back, from
an injected `cores`, so the column is percent of one core and a process on two cores reads 200%.

The alternative was to show the raw figure, and it is worse than it sounds. It is not just an unusual
scale, it makes every threshold machine-dependent: a saturated core is 25% on four cores and 6% on
sixteen, so a band meaning "pegged" on a laptop means "idle" on a workstation and no fixed number is
right on both. This was found by looking at the built app rather than by a test — the bands were
written against the documented meaning, and a full core rendered green — which is the argument for
that last step and not an aside. The cost of the conversion is that the pane now disagrees with a
reader who has independently read `getAppMetrics()` and believed its field name; the compensation is
that it agrees with Activity Monitor and `top`, which is what a reader actually cross-checks against,
and that the caption says which convention it is using.

History is keyed by pid, and pids here are not stable: `HOST_IDLE_MS` kills an unused host after five
minutes and the next open forks a new one. The store therefore drops history for any pid absent from a
sample, which also means a host that respawned mid-session starts its line again rather than
continuing a stranger's.

Processes Chromium names for itself — the zygote, a sandbox helper — are shown as Chromium names them.
Giving them friendlier labels would mean maintaining a table of another project's internal process
types across Electron upgrades, and being wrong about it silently. `ProcessMetric.name` is preferred
over `serviceName` for those labels, which is worth writing down because the pairing is not the one
the option name suggests: `utilityProcess.fork`'s `serviceName` option arrives in `name`, while
`serviceName` holds the mojo interface and reads `node.mojom.NodeService` for every host this app
forks. Labelling off `serviceName` therefore named every engine host the same thing, which is what it
did until the pane was looked at; `name` is also the friendlier of the two for Chromium's own
processes — `Network Service` against `network.mojom.NetworkService`.
`test/renderer/perf.app.test.ts:209` had already written the pairing down in order to find the host
it kills, and this record is the second place it is now stated.

`ok`, `warn` and `danger` stop being only status colours. They were an HTTP and gRPC outcome scale;
they are now also a magnitude scale, which is a real widening of what those three tokens mean and the
reason the legend is not optional. The alternative was six per-process identity hues, and the only
audited, mutually distinct family available for that is `--color-method-*` — which is keyed by verb,
read by exactly one function, and would have put `GET` green beside a process in a tool whose subject
is HTTP verbs. A monochrome table would have been better than that, and a banded one is better than
both.

`SettingsPane` had two tabs and now has three, which widens its `SettingsTab` union and is the first
time that pane has held anything that is not a preference. It goes there rather than behind its own
overlay because it is diagnostics, it belongs next to the log path that 035 put one tab over, and the
mount and unmount of a Radix tab is the visibility signal the gate needs — a dedicated overlay would
have cost a menu item, a palette entry, a keybinding and a line of session state to obtain the same
boolean.
