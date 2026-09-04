# 044: A command is built from the request, not from the send

Status: Accepted

## Decision

One request becomes a `curl` or `grpcurl` command — the reverse of ADR 043. `preman copy
admin/Profile` prints it; the app shows it in an aside beside the editor, live on what is being
typed. `packages/core/src/command/` renders the words, `planCommand` assembles them, and
`copySelection` is the counterpart of `runSelection` that the CLI and the engine both call.

Four rules shape it:

- **The command is built from the request as it stands, saved or not — never from a run.** Nothing
  is sent, no script executes, and the exit codes are `0` and `1` only. The CLI reads the file
  because it has no editor to be out of step with; the app sends the draft, so the command tracks
  the request being edited rather than the last version written to disk.
- **The dialect is decided by the request's kind, never by a flag.** An `http-request` renders
  `curl` and a `grpc-request` renders `grpcurl`. There is no `--format`, because there is no
  choice: `CommandFormat` is the same union `preman import` sniffs, read in the other direction.
- **Every `{{token}}` is resolved, and every resolution is named.** The plan carries `revealed`:
  one entry per variable that was substituted, with the scope it came from, plus one for a
  credential from an `auth` block naming which block. Core has no concept of a secret, so nothing
  is redacted — it is reported.
- **Everything the command cannot carry is named too.** `unexpressed` holds one entry per script
  that will not run, per `pm.test` that has no result, per run option that is not a request
  field — the timeout, the cookie jar, the iteration data — each with the clause that explains it.
  A `grpcurl` for a descriptor-resolved method says the command will not run as written.

## Rationale

**Reading the request is the only thing that works before a send.** The complement — copying
the bytes that actually went out — needs a run to have happened, and the two most common reasons
to want a command are handing one to a colleague and reproducing a failure in a terminal, neither
of which is downstream of a successful send in this app. `SentRequest`
(`packages/core/src/api/events.ts`) was the tempting source and is not sufficient: it carries the
headers and the body but not the cert paths, not the TLS decision and not the proto path, so a
`grpcurl` built from it would be missing the three flags that decide whether it runs. Widening it
is its own decision; see the cost below.

**The app plans from the draft because the aside is open while the request is being typed.** A
panel pinned beside a live editor that showed the last-saved version would be confidently wrong in
the exact moment it is most used — change the url, watch the command not change. So `plan-command`
carries a `RequestDraft`, which is the same either-or the save path already makes: the projected
document when the field editors are in play, the raw bytes when the YAML tab is. The host parses
the bytes and `parseRequestDocument` validates them, so a half-typed document is refused as a
sentence rather than thrown as a parser error, and core never learns that an editor exists — it is
handed a document and does not ask where it came from. The price is that the aside re-plans on a
debounce, and that a draft naming a `$kind` the schemas reject shows a refusal where a command was.

The draft the aside sees is the tab's, which is not the same as the caret's. A `Field` commits on
blur (`ui/Controls.tsx`), a `CodeEditor` on a 300ms idle, so editing the url rewrites the command
when focus leaves the box, while editing the body or the YAML rewrites it as you stop typing. This
is worth stating because "live" oversells it: the aside is exactly as current as the Save button
and the unsaved dot, which is the useful guarantee — the command always matches what a save would
write. Making it track each keystroke would mean a second read path that disagrees with both.

**Not running the scripts is a deliberate refusal, not a shortcut.** A pre-request script can sign
a body, set a header from a previous response, or write a variable, and running one to build a
command would mean the act of copying had side effects — a `pm.environment.set` would write the
environment file of someone who pressed Copy to read what a request looks like. `resolveGrpcCall`
therefore resolves in one pass rather than the two ADR 039 gives the runner, because the second
pass exists only to see what a script changed. The scripts are named in `unexpressed` instead, so
the reader knows exactly which line of the command is missing.

**`revealed` names rather than redacts, because core cannot tell.** There is no secret type in
`packages/core/`, and there is no honest way to invent one: `token`, `api_key` and `password` are
names, not evidence, and a rule keyed on them would both miss `x-signature` and redact a variable
called `token_endpoint`. Every alternative considered required core to judge a value it has no
information about. Naming what was substituted, and where it came from, gives the reader the one
thing they need to decide for themselves before pasting into a chat window — and the inherited
case, an `Authorization` from a collection's `auth` block that the request never mentions, is the
entry nobody would have gone looking for, which is why it sorts first in the pane.

**`copySelection` mirrors `runSelection` so there is one answer to "which environment".** Choosing
an environment, layering `--ssl-*` over `.postman/preman.yaml`, adopting the sole environment when
none was named — all of that is behaviour, and a second implementation of it in the CLI or the
engine host would eventually be the copy that adopted a different one. `api/selection.ts` was
extracted out of `api/run.ts` for this, and `workspace/request-file.ts` out of `runner.ts`, so the
copy path reads a request and picks a target without loading a transport: ADR 029's rule is that
the engine host must not pull `@grpc/grpc-js` in to answer a question, and this feature asks a
question that never sends.

**A group is refused with its count, not copied as a script.** A shell script that ran five
requests in order would have to invent an ordering, an error policy, and a way to thread a variable
from one response into the next — which is `preman run`, badly. The refusal names the group, the
count and the request paths, so the next step is one selector away.

## Consequences

**A command copied from a script-built request is wrong until the Console entry point exists.**
This is the cost that cannot be argued away. A request whose `Authorization` is set by a
pre-request script copies to a command with no `Authorization`, and `unexpressed` says so in
words — but the words are a caveat beside a command that looks complete. The fix is the
out-of-scope item: `Copy as cURL` on a logged call in `ConsoleDrawer`, where ADR 024 already puts
the repeat of the response pane. Until then, the honest position is that this copies the request as
written, and says which parts of it are not written down. Planning from the draft narrows this
without closing it: what the aside shows now tracks the request being edited, but a script is still
a thing that runs at send time and this never sends.

**Two renderers now know what a request is.** `resolveGrpcCall` duplicates the resolution
`runner.ts` does, knowingly: collapsing them touches the one function ADR 039 is about, under a
feature that does not send. `renderCurl` avoids the same duplication on the HTTP side by taking
`BuiltHttpRequest` from `buildHttpRequest`, which had no production caller before this.

**Two types grew a field so a command could name a file.** `TlsCertOptions` gained `paths`, and
`ResolvedMethod` gained `protoPath`. Both are the same shape of problem: the resolver knew which
file it opened and threw the path away, because nothing before this needed to print it. Parsing
either back out of a display string would have made that string load-bearing.

**The command names paths that exist on this machine.** `-proto`, `-import-path`, `--cacert` and
`--cert` are absolute local paths, and a `grpcurl` sent to a colleague will not run on theirs. This
is warned rather than solved — ADR 038's shared root means the _declaration_ is portable, but a
tool that is not preman needs a real file.

**There is no unresolved rendering mode.** `finaliseHttpRequest` raises on a url that is not a url,
so `{{base_url}}` cannot pass through the same builder, and a second builder would be a second
truth about what a request is. Copying without an environment therefore fails the way a run
without one fails, and says the same thing.

**The clipboard is written only on a press.** The aside plans as the request changes and copies on
click; the CLI prints to stdout and documents `| pbcopy` rather than shelling out to one of three
platform clipboards. Both halves of that are so opening the aside to read what a request would send
cannot put a bearer token on the clipboard.

**The aside is mounted only while it is open.** It sits in a horizontal `Group` that holds no
persisted layout, because a stored two-panel split cannot be restored onto a group that usually has
one panel. The alternative — a collapsible panel kept alive at zero width, which is how the console
works — would re-plan on every keystroke into a pane nobody is looking at, and every plan resolves
a proto and walks the ancestor chain. The cost is that its width resets between openings, which is
the smaller of the two.
