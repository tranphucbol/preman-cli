# 005: Writes go through the YAML Document API, atomically

Status: Accepted

## Decision

Every write to a workspace file goes through `yaml`'s `parseDocument` Document API, mutating the
parsed document in place. `YAML.stringify` on a plain object is never used to produce a file that
already existed. Writes are atomic: write a temp file in the same directory, then `rename`.

## Rationale

These files are committed. They sit in someone's repository next to their service code, they are
reviewed in merge requests, and they carry comments explaining why a header is set the way it is.
A client that reformats a file on every save turns every one-field edit into an unreviewable diff,
and the team stops using the client.

The Document API keeps comments attached to keys, key order, and block-scalar style. Round-tripping
a file that was not edited produces the same bytes.

`rename` is atomic within a filesystem, so a crash or a full disk mid-write leaves the original
file intact rather than a truncated one. The temp file goes in the same directory because `rename`
across filesystems is not atomic.

## Consequences

**Comment preservation is not total, and this was chosen without asking.** `parseDocument` keeps
comments attached to keys that survive the edit. Deleting a key drops the comments attached to it.
A structural rewrite — moving a request between collections — does not attempt to preserve
intra-file formatting beyond what the Document API gives for free.

Mutation code is more verbose than object-and-stringify would be, because it navigates and edits
nodes rather than replacing values.

New files, which have no formatting to preserve, are written from a template and are the one place
a plain serialise is acceptable.
