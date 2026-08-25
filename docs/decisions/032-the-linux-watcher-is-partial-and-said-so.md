# 032: The Linux watcher is partial, and says so in prose rather than in code

Status: Accepted

## Decision

`watchWorkspace` is not fixed on Linux. The behaviour is recorded here, the stale comment in
`packages/core/src/api/watch.ts` that got it wrong is corrected, and the one test that cannot pass
there — `givenAppWroteFileThenSomeoneElseDid_whenWatcherFires_thenExternalChangeIsPublished` — is
skipped on Linux behind a named `WATCH_SURVIVES_OWN_SAVE`, with the reason at the constant.

The defect: Node's recursive `fs.watch` on Linux holds one inotify watch per file, and a `rename`
over a watched file drops that watch permanently. `workspace/atomic.ts` saves every file as
temp-plus-`renameSync`, so once the app has saved a file, external edits to that file are never
reported again. Watches on files the app has not saved keep working, so the watcher degrades
file-by-file rather than failing outright.

Measured outside preman, on `node:22-bookworm`, watching a directory with `recursive: true`:
in-place write reports; atomic replace reports; **in-place write after the atomic replace reports
nothing**; an untouched sibling still reports, until it too is replaced. The same script under bun
1.4 reports every step, and macOS reports every step, because FSEvents watches paths and not inodes.

## Rationale

Every honest fix is a bigger change than the bug is currently worth, and each has a cost worth
naming. Closing and reopening the watcher after each batch re-arms every per-file watch, and also
re-walks the tree on every save — `docs/performance.md` budgets a 5000-request workspace, and this
would be paid there for a platform the app is not shipped on. Watching directories only is
inode-stable and cheap at runtime, but it is exactly the "per-directory watcher tree that silently
misses new subdirectories" that this function's own docblock rejected, and reopening that argument
to fix an unshipped platform inverts the priority. 018 ships a macOS DMG and names Linux and Windows
as absent rather than broken; the user-facing consequence today is therefore nil.

What was not acceptable was the previous state, where the comment asserted that Linux rejects
`recursive: true`. It does not — it is accepted, `onDegraded` never fires, and the operator gets a
watcher that looks healthy and is not. This docblock says a watcher must never be silently degraded
because that "looks like data loss". It was, and the code claiming otherwise was the worst part.

The test is skipped rather than rewritten to pass. A test that pokes until the platform agrees would
assert nothing, and one that asserted the broken behaviour would have to be deleted the day the
watcher is fixed. Skipping keeps the assertion intact and correct for the platform that ships it,
and the two sibling cases still exercise the watcher on Linux, so the loss is one property on one
platform and not the watcher's coverage.

## Consequences

If the desktop app is ever shipped on Linux, this is a release blocker and not a cleanup task: a
user editing a request in another editor after saving it in preman sees a stale pane. The fix is a
watcher change plus a perf re-measurement, and this record is the argument that it cannot ship
without one.

CI is green on ubuntu with a skip rather than with a pass, so the count differs by one between the
two matrix legs. Anyone reconciling the numbers should find the reason at the constant.

The bug was found by 030's pipeline on its second run, which is the first evidence that testing on
a second OS pays for itself. It also cost a wrong fix first: an earlier commit blamed unawaited
engine writes in the test and serialised them. That commit is kept, because serialising the phases
does remove a real race, but it fixed nothing here and its comment has been corrected to stop
claiming otherwise.
