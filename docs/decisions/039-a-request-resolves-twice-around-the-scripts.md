# 039: A request resolves twice, around the scripts

Status: Accepted

## Decision

A request is interpolated once before the pre-request scripts and once again after them. The first
pass is what `pm.request` shows a script; the second pass is what goes on the wire.

`vars/template.ts` is the new seam. A `Template` holds the authored source, the label an error would
carry, the value the scripts were handed, and the dynamic samples the first pass drew.
`Template.send(current, store)` asks one question — is this still the string I resolved? If it is,
the script did not touch the field and the authored source is resolved again against the store the
scripts have since written to. If it is not, the script assigned it, so what the script wrote is
interpolated on its own, strictly, with fresh samples. `resolveList` and `resolveListAgain` do the
same for a header or metadata list, keyed by the lower-cased name.

`runner.ts` builds four templates for a gRPC request — method path, url, metadata, message body —
and re-resolves all four in a `1b.` step immediately after `sink.run(PRE_SCRIPT_TYPES)`.
`buildLiveHttpRequest` returns a `resolveAgain()` closure over the same three lists it can honestly
redo — headers, the raw body, urlencoded fields — and `runHttpRequest` calls it in the same place.

`interpolate` gains a positional `DynamicSamples` array. A `{{$guid}}` resolved in the first pass
keeps its value in the second, so a script that reads `pm.request.body.raw` and a server that
receives it see the same guid. The array is positional rather than keyed by name because two
`{{$guid}}` in one body are deliberately two different guids, and that is the behaviour 025 already
described in the Preview pane's footer.

## Rationale

`beforeInvoke` scripts that mint a value and then reference it from the body are the ordinary case,
not an exotic one: a timestamp, a nonce, an idempotency key. Every one of them was silently broken.
A script would `pm.environment.set("app_time", Date.now())`, the body would go out carrying the
`app_time` from the environment file, and — because the run writes the environment back — the value
the script computed would arrive on the wire one send late. So the first send of a session failed
against a server that validates the timestamp, and the second succeeded, which is the worst shape a
bug can have: it looks like a flaky server.

Nothing in the codebase claimed the old order. 025 is about _where_ a token is resolved and says
nothing about _when_; no test asserted that `pm.request` holds an already-substituted value inside a
pre-request script. The fixtures that mutate `pm.request.body.raw` do so by parsing and
re-stringifying it outright, and are insensitive to the order either way.

The real alternative was Postman's own order: do not resolve anything until the scripts have run.
That is one pass rather than two, needs no `Template`, and is what the reference implementation
does. It was refused on the size of the restructure rather than on principle.
`buildLiveHttpRequest` resolves the url and the request's own query params and then hands the
result to `applyAuth`, which appends the auth block's params to the same `Url` and its headers to
the same list; the url a script sees is that merged object, and there is no longer an authored
string underneath it to re-resolve. A form-data body is materialised from disk in the same function.
Deferring all of it means unpicking the merge, the auth application and the multipart build, and
`freezeRequest` with them — a change to the whole request-building path to fix an ordering bug. Two
passes buys the fix at the cost of one, and leaves that restructure available.

Resolving twice is only safe because the second pass can tell an untouched field from an assigned
one, and only cheap because `interpolate` is a string walk over text the editor already holds.
Comparing against `#resolved` rather than a dirty flag is deliberate: `LiveBody` has a `changed`
getter, but a script that writes back the same string it read has not changed anything, and one that
assigns a field it never read has, whether or not it went through a setter.

## Consequences

Three fields are still resolved once, before the scripts, and a script cannot influence them: the
HTTP url, a structured body (form-data, file, graphql), and the auth block. `BuiltLiveHttpRequest`
says so in a comment at the declaration rather than leaving the next reader to infer it from what
`resolveAgain` happens to touch. A script that needs to affect a url still has `pm.request.url` and
`pm.variables.replaceIn`, which is what it had before this record.

A duplicated header or metadata key is resolved once. `resolveList` registers a template only for
names the file uses exactly once, because after a script has reordered or inserted into the list
there is no honest way to match the second `X-Trace` back to the second authored one. The gRPC and
HTTP paths agree on this, and a duplicated key still sends what it sent yesterday.

A value a script assigns is now interpolated. Before this record, `pm.request.body.raw = "{{a}}"`
sent two braces and a letter; it now sends the value of `a`, or fails the run if there is no such
variable. That is the same rule the authored body has always been under and is why the strictness is
the same too, but it is a behaviour change for a script deliberately emitting literal braces — which
`pm.variables.replaceIn` never protected either.

The url and the method path resolve _strictly_ on the first pass while the body and the lists resolve
leniently, and the asymmetry has a reason: the strict pass names an undefined variable at the point
the user can see which field it was in, and the url is consumed to pick a target before the second
pass could rescue it. A body with an undefined name gets no error from the first pass because a
script is very often about to define it; if it does not, the second pass is strict and the error
arrives with the same label it always had, one step later.

The gRPC url is re-resolved only when the scripts left `liveRequest.url` exactly as built, and the
result is `Url.parse`d rather than assigned, which means a script that mutates the url object piece
by piece keeps its edit and loses the re-resolution. That is the same "the script wrote it, so it is
theirs" rule the body follows, expressed on an object that has no single string to compare.

`docs/performance.md` gets no new row. The second pass is a walk over strings bounded by the body
size the editor already holds, on the send path rather than a render path, and the budgets that
could see it are the ones the suite already asserts.
