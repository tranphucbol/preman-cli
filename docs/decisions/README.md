# Decisions

Architecture decision records. One file per decision, numbered, never renumbered. A decision that
is later reversed keeps its file and gains a status, so that the reasoning behind the reversal has
something to point at.

These are the decisions behind the desktop app, and from 030 the pipeline that ships both of them.
The CLI's own design predates the practice.

| #                                                                   | Decision                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [001](001-electron-not-tauri.md)                                    | Electron, not Tauri                                                    |
| [002](002-three-processes-and-a-direct-port.md)                     | Three processes, and a direct port between renderer and engine         |
| [003](003-core-stays-synchronous.md)                                | Core stays synchronous                                                 |
| [004](004-the-app-authors-the-workspace.md)                         | The app authors the workspace, so core gains write responsibility      |
| [005](005-yaml-document-api-and-atomic-writes.md)                   | Writes go through the YAML Document API, atomically                    |
| [006](006-never-regenerate-methoddescriptor.md)                     | The app never regenerates `methodDescriptor`                           |
| [007](007-postman-information-architecture.md)                      | Postman's information architecture, our own visual system              |
| [008](008-react-and-zustand.md)                                     | React 19 with Zustand                                                  |
| [009](009-radix-fenced-and-density-retuned.md)                      | shadcn on Radix, fenced — and density retuned first                    |
| [010](010-explicit-save-and-app-state.md)                           | Explicit save, and app state never enters the workspace                |
| [011](011-a-watcher-reconciles-external-edits.md)                   | A file watcher reconciles external edits                               |
| [012](012-one-window-many-workspaces.md)                            | One window, many workspaces, one engine host each                      |
| [013](013-response-bodies-stay-in-the-engine.md)                    | Response bodies stay in the engine host                                |
| [014](014-codemirror-everywhere.md)                                 | CodeMirror 6 everywhere, no Monaco                                     |
| [015](015-what-v1-ships.md)                                         | What v1 ships                                                          |
| [016](016-the-performance-budget-is-asserted.md)                    | The performance budget is an assertion, not an aspiration              |
| [017](017-interaction-budgets-measure-blocking-at-the-median.md)    | Interaction budgets measure blocking time, attributed, at the median   |
| [018](018-what-goes-in-the-packaged-bundle.md)                      | What goes in the packaged bundle                                       |
| [019](019-the-failure-crosses-the-wire.md)                          | The failure crosses the wire                                           |
| [020](020-themes-are-generated-audited-data.md)                     | Themes are generated, audited data                                     |
| [021](021-density-is-a-preset-and-typescript-owns-the-token.md)     | Density is a preset, and TypeScript owns the token                     |
| [022](022-preferences-are-global-and-synchronous-at-first-paint.md) | Preferences are global, and read synchronously at first paint          |
| [023](023-the-parser-is-fed-a-masked-document.md)                   | The parser is fed a masked document                                    |
| [024](024-the-console-repeats-the-response-pane.md)                 | The console repeats the response pane                                  |
| [025](025-variable-resolution-stays-in-the-engine.md)               | Variable resolution stays in the engine                                |
| [026](026-the-app-is-allowed-to-move.md)                            | The app is allowed to move                                             |
| [027](027-the-app-reports-its-own-phases.md)                        | The app reports its own phases                                         |
| [028](028-the-create-dialog-asks-what-before-it-asks-name.md)       | The create dialog asks what before it asks name                        |
| [029](029-the-engine-loads-the-send-path-on-demand.md)              | The engine loads the send path on demand                               |
| [030](030-ci-asserts-everything-but-the-clock.md)                   | CI asserts everything but the clock, and the tag is the version        |
| [031](031-an-authored-body-is-re-indented-not-reserialised.md)      | An authored body is re-indented, not reserialised                      |
| [032](032-the-linux-watcher-is-partial-and-said-so.md)              | The Linux watcher is partial, and says so in prose rather than in code |
| [033](033-migrating-from-postman-cloud.md)                          | Migration reads Postman's own private API, with Postman's own token    |
| [034](034-the-sidebar-starts-shut.md)                               | The sidebar starts shut                                                |
| [035](035-the-log-contains-no-traffic.md)                           | The log contains no traffic                                            |
| [036](036-the-log-says-how-bad-it-was.md)                           | The log says how bad it was                                            |
| [037](037-the-sidebar-starts-open-again.md)                         | The sidebar starts open again                                          |
| [038](038-a-proto-is-declared-through-a-shared-link.md)             | A proto is declared through a shared link                              |
| [039](039-a-request-resolves-twice-around-the-scripts.md)           | A request resolves twice, around the scripts                           |
| [040](040-the-app-measures-itself-only-while-watched.md)            | The app measures itself, only while watched                            |
| [041](041-a-throw-after-the-response-is-a-failed-test.md)           | A throw after the response is a failed test                            |
| [042](042-the-resolver-has-two-roots.md)                            | The resolver has two roots, and the writer has one                     |
| [043](043-importing-a-pasted-command.md)                            | Importing a pasted command, behind a fence                             |

001-015 were taken before implementation began. 016-019 were taken during it, and 017 in particular
exists because measuring the budget in 016 disproved the first way it was phrased. 020-022 came with
configurable appearance; 021 answers 009 rather than reversing it, and 020 shows that 014's "the
theme is defined once" is still true word for word. 023 came straight after, from looking at what
the newly legible syntax colours had made obvious: the grammar had been misparsing every body with
a `{{token}}` in it all along. 024 is the first that accepts duplication as the point rather than
the cost: it widens 019's event again and then renders a response body a second way, because 013's
"bodies stay in the engine" also means the engine forgets them. 025 keeps the answer to a token in
that same engine, then gives plain inputs a lighter overlay rather than turning every grid cell into
a CodeMirror instance. 026 reverses the "Motion" bullet in `docs/design-system.md` — the app moves
now — and the reversal cost a one-frame transition suppression guard in `appearance/apply.ts`,
without which a theme switch would start a colour transition on every mounted control at once. 027
is the first to answer 016 with an instrument rather than a number: opening a large workspace was
slow, nobody could say which of the three processes was slow, and 002's port turned out to have no
way to ask the one that was. It also has to say why it is not 017 — wall-clock phases and
attributed blocking time measure two different questions — and it admits, in the record, that its
own new budget row is gated well above its goal. 028 is the smallest of them and reverses a rule
that was never written down as one: a `Do not simplify them into a toggle` comment held for exactly
as long as the dialog had two answers, and a folder made it three. It is here rather than in a diff
because the comment's own argument — that a protocol is not a setting you change later — survives the
reversal and picks the new shape. 029 is the first thing 027's instrument found that was worth
fixing rather than explaining: the engine spent 4.8 seconds of a cold launch evaluating faker,
grpc-js and chai before it could answer a question about YAML files, and 016's cold-start row is
defined to discard exactly the launch where that is visible. It is also the first to move a function
between modules for what the module's imports cost rather than for what the function does, and the
first whose gate is a source-graph assertion instead of a number — because the number it would
assert is only observable on a machine whose page cache has just been destroyed. 030 is the first to
take something away: 016 said every budget row is a test that fails, and it turns out a shared
two-core runner cannot hold a row with 26% of headroom, so the three clock budgets are skipped in CI
and the only perf gate that survives there is 029's import graph — the one 029 built to be
machine-independent for a different reason. It is also the first record about how the repository
leaves the repository, and it answers that with the tag: nothing is committed between releases,
because a bump that can be committed is a bump that can disagree with the tag it was released under.

031 is the second record to answer 023, and the first to refuse a shortcut on the grounds of what it
would send: the app already had a JSON formatter, and reusing it on a body somebody is still writing
turns a bare `{{token}}` into `0` and a twenty-digit id into a rounded one. It costs a hand-written
scanner and inherits 023's two holes as two bodies that decline to format, and it says so in the
record rather than only in the module.

032 is the first record written because a pipeline found something. 030's second run failed on ubuntu
and not on macOS, and underneath was a watcher that Node accepts recursively on Linux and then backs
with one inotify watch per file, so the atomic save in `workspace/atomic.ts` quietly drops the watch
on everything the app has touched. It is not fixed, because every fix costs either the perf budget
or the design 016 and this function's own docblock already settled, and 018 does not ship the app
there. What is fixed is the comment that claimed the opposite, which is the part that could have
cost someone a day.

033 is the first record about getting a workspace in rather than about what happens to one once it is
here, and the first whose main dependency is another vendor's undocumented surface. It takes the
transport preman was built to avoid needing — Postman's own private RPC proxy, with the token borrowed
from a signed-in desktop window — because the documented API cannot see the gRPC requests that are the
README's first paragraph. It says in its own consequences that it will break without notice, which is
the point of writing it down: the next reader will find a broken feature and needs to know it was
built that way knowingly, and where to look. It also applies 029's argument to a second process, and
declines to invent the `.proto` that 006 forbids inventing.

034 is the first record to give something back rather than add something, and the first whose whole
cost is discoverability. It reverses no earlier record — 007 put the tree on the left and it is still
on the left — but it does answer 007 on a question 007 did not ask, which is whether the pane should
be there before you have asked for it. It takes the console drawer's arrangement wholesale, down to
sharing 024's footer with it, and it is the second time the perf suite has had to be told what the
app now looks like at launch. It is also the first record to amend the motion rules rather than obey
them: a horizontally collapsing pane has no transform that expresses it, so it tweens `flex-grow` and
says in its own text why 017's argument survives that — the spend is one pane for 180ms on an
explicit gesture, which is the test a progress fill fails. The fence moved with it, since the one
that existed read components and would never have seen a rule in `app.css`.

035 is the first record about what the app writes down about itself, and the first whose substance is
a prohibition. It exists because the same properties that make the engine the right place to resolve
a `{{token}}` (025) and to hold a response body (013) make it the one process whose output cannot be
logged: a traffic log written by it is a credential file the user never enabled. So the file is
unconditional and the content is fenced, which is the opposite of the usual trade, and it leans on
024 to say where a request actually goes when you want to look at one. It is also the first record to
put something outside `userData` on purpose, and the cost is a file two renames deep that answers
nothing about last week.

036 is the first record to amend another rather than reverse it or extend it, and 035 is nine days
old. It exists because 035's file turned out to be right about what it must not hold and quiet about
most of what went wrong: opening a real workspace and picking a method put three failing specs in a
banner and nothing in the log, because the engine host turns every failure into a response and a
response is not a record. Fixing that meant relaxing 035's path clause, since the warning is made of
paths — so this is also the first record whose cost is a privacy one taken knowingly rather than
avoided, and it says so in its own text. The levels are the smaller half: four, no `debug`, and no
filter, because a level you can turn off is the switch 035 already refused. The tag the engine
prefixes its lines with is the same argument as 027's shared phase names, applied to severity: two
processes, one file, and no guessing at the boundary.

037 is the first outright reversal in the set, and it reverses the newest record but one. 034 kept
its file and its argument and changed its status, which is the convention working as intended: the
pane's default has now been argued twice and both halves are here to read. It also demonstrates what
034 was buying, which 034 could only assert — with the tree mounting in the first render again, the
5000-node start-up budget went from comfortable to marginal, and the record says so rather than
quietly moving the number.

038 is the first record to take up something an earlier one built, measured and threw away. 033
implemented symlink-rewriting for the migrator, watched it take 28 resolving requests to 82, and
rejected it anyway, because a migrated file should say what Postman said. That half stands and
migration still writes Postman's paths verbatim; what 038 changes is that a person choosing a file
and confirming a named plan is not a migrator rewriting 188 requests nobody has read. It is also the
second record after 036 whose real subject is a bug the feature would have spread: `deriveIncludeDirs`
stopping at the workspace root, which 033 had already named in prose as the reason most migrated
protos still failed, and which nothing asserted until now. The cost it states plainly is the one it
was warned about while being chosen — a repository-local workspace stops being self-contained — and
it keeps that cost rather than special-casing it away.
039 is the first record about what the engine puts on the wire rather than about the app around it,
and the first taken from a bug report rather than from a design question. It answers what 025 left
open without contradicting it — 025 said every answer about a token comes from the engine, and said
nothing about when the engine is asked. The interesting half is what it declined: Postman's own
order, one pass after the scripts, was refused on the size of the restructure and named in the
record so that the next reader reopens it deliberately. Its cost is stated as three fields that
still resolve once and a duplicated key that resolves once, which is the shape of an honest partial
fix rather than a claim of completeness.
040 is the second record to answer 016 with an instrument rather than a number, and it is 027's
argument moved from launch to steady state: the idle RSS row's gap between a 250MB goal and a 450MB
gate is a per-process fact the app could never show anybody. It is also the first record whose
central decision is when _not_ to run — the sampler holds no timer unless a pane is looking at it,
because 017 already found 7-16ms of ambient blocking in the idle app and because the idle RSS
assertion would have measured the sampler that motivated it. The cost is stated plainly and is the
one thing the feature cannot do: a spike you were not watching is gone. It reports `workingSetSize`
uncorrected for the same reason 032 fixed a comment instead of a watcher, and it is the first record
to argue _for_ a second indicator against `Progress.tsx`'s "there is exactly one of them" — allowed
not by exception but because that rule is about a proportion and a sparkline has no denominator.

041 is the second engine record taken from a bug report, and like 039 it is about the moment either
side of the scripts rather than about the app. It is the first to argue that an error should be
demoted: a post-response throw stops being a dead run and becomes one failed assertion about a
response that had already arrived, which is what the reporters were always able to say and were
never given. Its mechanism is a listener rather than a new return type — the sandbox already
announced every assertion as it happened, and 039's lesson about not restructuring what already
works applied twice over, once to `runScript`'s throw and once to `PremanError.abortsGroup`, which
was already the flag that separates a request's own failure from an inherited one. The cost is
stated as the thing the fix buys and cannot un-buy: a script that throws halfway now persists the
variables it set before it threw.

042 is the first record to reopen a cost another one accepted knowingly, and it does it without
reversing anything: 038 priced "a repository-local workspace stops being self-contained" and named
the mitigation as a link named after the repository you just cloned, and 042 observes that a name a
person can act on is a name the resolver can act on. So the file keeps 038's single canonical
spelling — including from the method picker, which is why the writer's second boundary shipped in
the same phase as the reader's fallback rather than after it — and only what is _read_ gains a
second root. It is also the first to argue that a repair should stay visible after it stops being
needed: a link a repo-local workspace no longer needs is still needed by a workspace elsewhere, so
`via` distinguishes the two rather than letting the row read as plain healthy. Its costs are stated
as the two it cannot avoid: a deliberate repoint is overridden for a workspace inside a matching
clone, and a clone whose directory was renamed still gets nothing automatic — compensated only by a
pre-filled path, which is a suggestion and says so.

043 is the second record about getting something in, and the first about getting one request in
rather than a whole workspace. Where 033's hard part was another vendor's undocumented transport,
this one's is another program's command line: every short option preman defines is also a curl
option, three of them take a value on both sides, and `parseArgs` reports nothing when it eats a
request body as a workspace path. So it is the first record whose central decision is a papercut
accepted on purpose — the `--` fence is a rule the terminal has to teach, it has no cure, and the
reasoning is here rather than only in the refusal message. It is also the first to make a plan the
unit that crosses 002's port for a write rather than for a read, which is what lets the pane show
the exact document before a file exists and what constrains that document to be clone-safe. The
rest is deliberately not new: it writes through 033's own shaping functions so an imported file and
a migrated one cannot be told apart, it declares a pasted `-proto` through 038's link because a
person confirming one named plan is exactly the case 038 drew the line for, and it declines to
invent the descriptor 006 forbids inventing — which is why a reflection-only paste is written
knowingly unrunnable and says so twice, once at import and once at send. The costs it states are
the two it cannot argue away: one command per paste, because the protocol has one `nodeId`, and a
pasted credential written where it was pasted, because every place to move it to is a guess.

`TEMPLATE.md` is the shape of a new one.
