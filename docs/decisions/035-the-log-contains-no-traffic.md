# 035: The log contains no traffic

Status: Accepted, amended by 036

## Decision

The desktop app writes one log file, `preman.log` in `app.getPath("logs")`, and the main process is
the only writer. The engine host and the renderer reach it by talking to main, which is already true
of everything else they cannot do themselves.

What may go in it: process lifecycle, host spawns, exits and respawns, crash reasons, the path of a
Node diagnostic report, and whatever the engine host wrote to its own stdout and stderr.

What may not go in it, ever: a URL, a header, a request or response body, a variable name or value,
or any file system path other than a workspace root. _(036 amends the last clause: the file may name
any path the app was already showing the user in a banner. The rest of the sentence stands.)_

There is no opt-in and no verbosity level. The file is always written and always at the same
detail, bounded by one size cap and one rename: at `LOG_MAX_BYTES` the file becomes `preman.log.1`,
overwriting the previous one, and a new file starts. Two files exist at most, and nothing older
than the second one is ever retained.

## Rationale

A log that a user has to enable is a log that does not exist at the moment it is needed. The first
report of a bug is the only one with the evidence in it, and a verbosity flag turns every report
into a request to reproduce it again with the flag on. So the file is unconditional, and the way it
is kept affordable is by bounding what goes in rather than by asking whether to write it.

The line about traffic is the reason this is a record rather than a comment. The engine resolves
`{{token}}` before it sends and holds the response body afterwards (013, 025), so it is the one
process in the app that has the cleartext of every credential the workspace has ever interpolated:
bearer tokens, basic auth, signing keys, the contents of an `--ssl-key`. A log that recorded a
request would therefore be a credential file with a different name, sitting in a directory the user
does not know exists, written unconditionally by an app they never enabled logging in. There is no
redaction rule that survives that: a header allowlist misses the token somebody put in a query
string, a query-string scrubber misses the one in a JSON body, and every rule is one workspace away
from being wrong. Not writing it is the only version that is right for every workspace.

The bound is a size cap and one rename rather than a date-stamped rotation with a retention policy,
because the failure this file exists for is the last few minutes before something went wrong, and
two files hold that. Anything more is an archive nobody reads and a directory that grows.

Synchronous writes, for the same reason `store.ts` is synchronous: the line worth having is the last
one before a crash, and a buffered writer loses precisely that one.

## Consequences

A user debugging a request has the console drawer (024) and not the log. That is the intended split:
the drawer is in front of a person who is looking at it, scoped to the run they just made, and gone
when the app closes. The log is a file on disk with no audience and no lifetime, so it gets the
facts that are safe to leave lying around and nothing else.

Anyone tempted to add a line about a request to help debug a transport problem is reversing this
record, not extending it. The transport facts that are safe — that a host started, that it exited
with a code, that it wrote a stack trace — are already in it.

The directory is `logs`, not `userData`. Forgetting a workspace, or deleting app data to fix a
corrupt state file, does not take the evidence with it. The reverse is also true and is the cost: a
user who deletes app data has not deleted the log, and the reveal button in the Settings pane's
Diagnostics section is the app's only admission that the file is there.

The pane points at the directory and never renders a line from the file. A pane that showed the log
would have to decide what to redact, and this record already decided that by not writing it.

The file is bounded, so a long-lived install cannot fill a disk, and equally cannot answer a question
about last Tuesday. That is a deliberate trade and not an oversight.
