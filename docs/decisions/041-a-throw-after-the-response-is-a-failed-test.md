# 041: A throw after the response is a failed test

Status: Accepted

## Decision

When a request's own post-response script throws — `afterResponse`, `test`, `onMessage`, whichever
alias the file spells — the runner records one failed test named `script "<rawType>"`, carrying the
throw's message, and lets the request finish. The response is reported, the environment writeback
runs, and the exit code falls out of the ladder that was already there: `countTests(...).failed > 0`
is exit 4, the same as any other failing assertion.

The rest of that phase is skipped. The scripts of one phase build on each other — a library
rehydrated by the first is read by the second — so running the remainder would report cascades of
the same failure.

Two throws still propagate, unchanged. A **pre-request** throw ends the request with no outcome,
because there is nothing to report but the failure. An **inherited** throw propagates from either
side of the call: a broken shared precondition is not this request's result to report, and decision
6 stops the whole group on it. `PremanError.abortsGroup` is what tells the two apart, which is a
second job for a flag that already meant exactly this.

The sink collects logs, tests and side requests **as the script emits them**, through the observer,
rather than from the value `runScript` returns. That is the mechanism the rest of this depends on: a
script that throws never returns its result, and the assertions it managed first are precisely what
explains the failure.

## Rationale

This came from a workspace where an `afterResponse` script read `body.amount` from a
`CreateOrderResponse` that has no `amount` field, computed `Number(undefined)`, and threw on the
`Number.isSafeInteger` check. Every run, regardless of what the server said. What the CLI printed
was one red line:

```
error: script "afterResponse" failed: order amount must be a non-negative safe integer
```

and nothing else. No response body, no status, no metadata, no `saved ...` line. `-v` was ignored
and `--reporter json --reporter-json-export` wrote no file, because the throw had left `runSelection`
before any reporter existed. The user's own reading of it was the right one: _the test should fail,
not the whole request — the response is still there._

It was there, and it had been for some time. `events.body()` fires before the post-response scripts
run; the invoke had returned; the outcome was three assignments away. The throw discarded a
completed call in order to report a bug in the code that inspected it.

The writeback is the part that did real damage. `persist()` was called at exactly one point on each
protocol path, after the scripts, with no `finally` — so a throw skipped it entirely. A script that
threw on its last line after setting four environment variables saved none of them, and the next run
started from the same stale values, which is how a script that has never once worked can look like a
flaky one. `runGroup` did not have this problem, because it persists the shared store at the end of
the run whatever happened to any item, so the same broken script wrote its variables in a collection
run and lost them in a single-request run. That asymmetry was not designed; it was the shape of where
the two `persist()` calls happened to sit.

**A failed test rather than a new outcome status,** because the ladder, `statusOf`, and every
reporter already know what a failed test is. Exit 4 exists, `ItemStatus` has `test`, the CLI renders
`✗ <name>` with the message indented under it, and JUnit emits a `<failure>`. A sixth status would
have had to be taught to all of them to say something none of them needed to hear — the run has one
assertion about the response that did not hold, and the reason it did not hold is that the code
asserting it threw.

**The observer rather than a return value.** The first attempt changed `runScript` to return a
failure instead of throwing. `test/sandbox.test.ts` pins the throwing contract in six places, and
more to the point the throw is _correct_ for the pre-request case and for an inherited script — it
is the only thing that ends a request that must not be sent. Widening the return type would have
made every caller re-derive "and now stop" from a field. The sandbox already announced every log and
every assertion to an observer as it happened, and already did so on the path that later throws; the
only thing missing was a listener that kept them. `scriptSink` now always passes one and wraps the
caller's, so the one announcement point the sandbox guarantees stays the one announcement point.

**Not caught in `runRequest`.** The catch there is protocol-agnostic and holds none of what an
outcome needs — the response, the resolved target, the timings, the metadata. Synthesising an
outcome at that level would mean inventing half of it. The recording therefore happens where the
response already is, inside the sink, and the two protocol paths continue into the code they were
always going to run.

## Consequences

**A script that throws after the response now exits 4 where it exited 1.** Anyone matching on 1 to
mean "the script blew up" gets 4 instead. Exit 1 is usage and config, which this never was, so the
old code was the wrong answer — but it was the answer for as long as post-response scripts have
existed, and a CI job that special-cases it will read this differently the day it upgrades.

**A partially-mutated environment is now persisted.** Before, a throw on the last line of a script
saved nothing; now it saves everything set before the throw. This is the cost of the fix and it is
worth stating plainly, because "the run failed" and "the workspace is unchanged" are no longer the
same sentence. It is the behaviour a group run has always had, it is the behaviour a script that
fails an assertion on its fourth variable has always had, and a stale saved value causes quieter
damage than a value that never saves — but a script that throws halfway is now capable of leaving
the environment in a state no successful run would produce.

**JUnit gains a testcase nobody wrote.** `script "afterResponse"` appears in the report alongside the
authored assertions, and a suite's test count grows by one on the runs where it fails. The name is
deliberately shaped like a phase and not like a sentence, so it reads as machinery rather than as an
assertion someone forgot about; it can still collide with a `pm.test` a user has literally named
`script "afterResponse"`, and if that ever happens the two are indistinguishable in the report.

**The failed-test message is the throw's message, with `script "<phase>" failed: ` stripped.** The
sandbox wraps a throw in that prefix for the one-line CLI error path, and the recorded test already
names the phase in its own name, so the prefix would otherwise be printed twice on one screen. An
error whose shape the stripper does not recognise is kept whole.

**In a group run the item's status moves from `error` to `test`.** The group no longer has an item
it could not run; it has an item that ran and failed an assertion. `--bail` treats it as a failure
either way, so the only visible change is the word, and the fact that the item now carries the
response it always had.

**A throw and a failed `pm.expect` are no longer distinguishable by exit code.** They are still
distinguishable by name — one is `script "<phase>"` and the other is whatever the author called it —
and the distinction is real: a throw means the script is broken, an assertion failure means the
script works and the response is wrong. Anyone who needs to tell them apart programmatically reads
`tests[].name` out of the JSON report, which is a worse affordance than a distinct exit code and a
better one than the single red line this replaces.
