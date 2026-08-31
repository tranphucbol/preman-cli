# 036: The log says how bad it was

Status: Accepted

## Decision

Every line in `preman.log` carries one of four levels — `info`, `warn`, `error`, `fatal` — in a
fixed-width column between the timestamp and the message. There is no `debug`, no filter, and no
way to turn a level off: 035 refused the switch and this record does not reintroduce it. A level is
a label on a file that is always written at one detail, not a knob.

The engine host tags its own lines. Its `stdio` is a pipe main reads, and main is the only writer of
the file (035), so a line main did not author arrives with no severity; the engine prefixes each of
its lines with `<preman:LEVEL>`, main reads the tag off and writes the level in the column. Output
from anything else in that process — Node's own `Debugger listening on ws://…`, a dependency's stray
write — is untagged and lands at `info`. Nothing infers a level from the text of a line.

Three kinds of failure that previously reached only the renderer now also reach the file: an engine
request that failed, a warning the engine returned as data (a `.proto` that would not load, a run
that completed with warnings), and a main-process IPC handler that threw. Successful requests are
still not logged — that is the traffic record 035 refused.

**This record amends 035.** Where 035 said the file may contain no file system path other than a
workspace root, it may now contain any path the app was already showing the user in a banner. The
prohibition on a URL, a header, a request or response body, and a variable name or value is
unchanged.

## Rationale

The file 035 produced was correct about what it must not contain and silent about most of what went
wrong. Opening a real workspace and picking a gRPC method put a banner on screen naming three specs
that would not parse, and wrote nothing at all to the log — because `handle` in the engine host
turns every failure into an `ok: false` response, and a response is not a record. The same was true
of the host registry: a host could be forked, die, and be restarted three times without a line, and
the failure at the end of that reached a dismissible banner and nowhere else. A log whose contents
are lifecycle and crashes is a log that describes the two failures the app almost never has.

The path clause is what stood in the way of fixing the loudest case. That warning is made of paths;
without them it degrades to "three protos could not be loaded", which tells a reader that something
is wrong and not which file to open. The clause was written to stop the log from becoming a record
of what the user did, and a spec that failed to parse is not that — it is the app explaining itself.
The honest cost is stated below rather than argued away.

Levels are the cheapest thing that makes the file scannable. Once failures are in it, a session is a
few hundred lines and the question a reader has is always the same: what is the worst thing in here.
A fixed column answers that by eye and answers it to `grep` with the same string. Four and not six,
because `debug` and `trace` are levels that only make sense with something to turn them on, and
`fatal` earns its place by being the one that means the process is not coming back — an engine host
that crashed and a renderer that is gone are different from a request that failed, and a reader
triaging a report needs to see which happened without reading the prose.

The tag is a contract rather than a heuristic because the alternative was pattern-matching a line
for the word `Error`, which misclassifies quietly and forever. It is printable rather than a control
character so that if it ever reaches a human — an engine run outside Electron, a pipe read by
something that is not main — it reads as a word. A line that merely looks tagged is passed through
whole, tag and all, because eating output on a near miss is worse than a mislabelled level.

## Consequences

The log now names absolute paths inside the workspace, which on a developer machine means the home
directory and the account name are in a file in `~/Library/Logs`. Anyone attaching a log to a bug
report is disclosing their username and their directory layout. That is a real cost and it is the
one this record chose to pay; the alternative on the table was a relative path, which would have
kept it and made the log's paths disagree with the banner's.

`Diagnostics.write` takes a level as its first argument, and `HostRegistryOptions.write` with it, so
neither can be called without one. `EngineHostOptions` gained a required `log`, deliberately not
defaulted to a no-op: every failure in that file is caught and turned into a response, so a host
without a sink is a host whose errors exist only in a banner, and making the caller name the sink is
what keeps that from being the quiet default. Seven test call sites pass `() => undefined` and mean
it.

Wrapping `ipcMain.handle` to witness a throw is the one change that touches every channel. It
re-throws unchanged, so the renderer's error path — audited when the port-close work landed — is
untouched. It found its own bug within a minute of shipping: the first build recursed into itself and
the app started with no window, and the `FATAL` line naming the recursion was in the log before
anybody had opened DevTools, which is the argument for this record in one line.

A picker opened five times against a broken spec writes its warnings five times. That is repetition
and not noise: it is the honest record of five failures, and deduplicating would mean holding state
about what has already been said.
