# 043: Importing a pasted command, behind a fence

Status: Accepted

## Decision

A `curl` or `grpcurl` command pasted from a browser's devtools, a colleague, or a runbook becomes a
request file. `packages/core/src/import/` splits the text into words, parses one command, and
proposes a document; `planImport` returns that document without writing it, and `applyImportPlan`
writes it. The CLI is `preman import`, the app is a dialog, and both call the same two functions.

Four rules shape it:

- **The pasted text arrives behind a `--` fence, or not at all.** `preman import curl --into acme
-- curl -k -H 'accept: text/plain' https://x`. Inline text with no fence is refused by name, and
  the refusal says what to do instead. `--from <file>` and standard input need no fence.
- **Planning and writing are two calls.** `preman import --dry-run` prints the document it would
  write; the dialog shows it in a read-only editor beside the name and destination it will use. The
  same plan is then handed back to be applied, rather than the text being parsed a second time.
- **Every flag is accounted for.** A flag preman can represent becomes a request field. A flag it
  cannot is reported by name with the clause that explains it — `--compressed`, "handled per
  response, not per request"; `-cacert`, "TLS is a run option, not a request field". A flag neither
  table knows about becomes a warning. Nothing is silently ignored.
- **The written file is indistinguishable from a migrated one.** `shape()`, `HTTP_KEY_ORDER`,
  `GRPC_KEY_ORDER` and `YAML_OPTIONS` in `packages/core/src/postman/convert.ts` are the same
  functions `preman migrate` writes through, exported rather than reimplemented.

## Rationale

**The fence is not a style preference; `parseArgs` and curl want the same letters.** Every short
option preman defines — `-d`, `-e`, `-k`, `-n`, `-r`, `-v`, `-h` — is also a curl option, and three
of the collisions take a value on both sides. `preman import curl -d '{"id":1}' https://x` parses
as `--dir '{"id":1}'`: the body is consumed as a workspace path and the URL becomes a positional,
and `parseArgs` reports nothing, because from its side nothing went wrong. The long flags collide
too: curl's `--json <data>`, `--url <url>` and `--insecure` are all preman options with different
meanings. There is no option-name budget that fixes this, and a heuristic that inspected the
positionals and guessed would be guessing about a body. So the fence is load-bearing, and its
absence is the only evidence available that the paste did not arrive whole — `argv.includes("--")`
is checked in `main.ts` because `parseArgs`'s own output cannot distinguish the two cases.

**The two-call split exists because the interesting failure is a correct import of the wrong
thing.** A pasted command is somebody else's artifact; the flags that were dropped and the name
that was proposed are the parts worth seeing before a file exists. One call that wrote and then
reported would make `--dry-run` a second code path, and would give the dialog nothing to render but
a result. The plan is therefore the unit that crosses the process boundary in the app, which
constrains it: `ImportPlan` holds only structured-cloneable data, and the renderer never parses the
paste itself — it displays what the engine decided. The alternative, sending the text down twice,
would let the second parse disagree with the document the user approved.

**A dialog, and not a fifth entry in `stores/overlay.ts`.** The import UI was first built as an
overlay pane, because that is where the variable manager, the proto manager, the runner and settings
live and it needed the same full width. It is the wrong shelf. Those four are places you work — the
variable manager stays open while a response is read, and settings has to leave the sidebar visible
because that is what a density preset changes — whereas an import is a question with one answer,
after which the thing to look at is the new tab. The dialog also buys the one thing the feature
depends on: it arrives with the paste box focused and nothing else on screen competing for
`Cmd+V`, which an overlay sharing the window with a tab strip and a sidebar cannot promise. The cost
is that it is window state in `App.tsx` rather than store state, so the four entry points hand it a
callback instead of reading a store — the same shape `MigratePane` already has, for a different
reason.

**The query string stays in the URL.** Splitting `?page=2&sort=desc` into `queryParams` would mean
removing it from the URL text and re-adding it through `URLSearchParams`, which re-encodes: a `+`
becomes `%2B`, a literal `|` or `[` becomes escaped, and the request sent afterwards is no longer
the request that was pasted. `mergeQuery` (`packages/core/src/http/query.ts:10`) is built for the
opposite direction — it treats the URL as authoritative and skips a duplicate — so the round trip
it would need is not one it makes. The one exception is `-G`, where curl was explicitly told to
turn body pairs into query parameters: those pairs were never URL text, so there is nothing to
preserve and they are written as `queryParams`.

**A pasted credential is written where it was pasted.** A `Bearer` token in a devtools copy is a
header, and it becomes a header. Hoisting it into an environment variable was considered and
refused on three counts: the workspace may have no environment or a dozen, so the destination would
be a guess; an environment file is as committable as a request file, so the secret would move
rather than be protected; and a variable named after the request it came from is a name nobody
chose. Leaving it visible in the document the dialog shows is the honest version — the user can see
exactly what is about to be on disk, and move it themselves.

**A grpcurl with no `-proto` is imported anyway, and will not run.** Such a command relies on
server reflection, which preman does not do. The alternative was to refuse the paste, and it throws
away the target, the metadata and the message body to save the user from a request that names its
own problem: with no `-proto` there is no `schema`, so the run fails at schema resolution and says
which method it could not find. The plan warns at import time in the same words. This is the case
ADR 006's rule keeps honest — no `methodDescriptor` is invented to paper over it, and none is
invented in the `-proto` case either, where `schema: {source: "file", location}` is the whole
mechanism.

**A `-proto` on disk is declared through 038's link, by reusing `planSpecs`.** An imported gRPC
request is exactly the case 038 was written for — a person naming one file and confirming a named
plan — so `applyImportPlan` applies the spec plan before it writes the request, and the request runs
on the first send. A `-proto` that is not on this machine is named in `schema.location` verbatim,
`plan.specs` is null, and the warning points at `preman protos link`.

## Consequences

**The fence is a papercut with no cure, and it is the first thing anyone will hit.** Pasting into
the app's dialog needs no fence and is the better path; the CLI's help, the refusal message and
`docs/reference.md` all state the rule, and standard input (`pbpaste | preman import --into acme`)
avoids it entirely. It is still a rule the terminal has to teach, and the reason it cannot be
relaxed is written above rather than only in `main.ts`.

**Only one command per paste.** `;`, `&&`, `||`, `|` and `&` split the text, a second command is
refused with the count, and a trailing `| jq .` is reported as ignored. The protocol's single
`nodeId` is the reason the app cannot do better, and a paste of five curls is a real thing people
have; it is out of scope rather than solved.

**Two shell dialects, and no shell.** `$(…)` and backticks are refused rather than evaluated, which
means a paste whose URL was built by a subshell cannot be imported at all. What is supported is what
a copy button produces: `'…'`, `"…"`, ANSI-C `$'…'` for Chrome on macOS, and `^`-continued
double-quoted lines for Chrome on Windows — the two fixtures are asserted to produce byte-identical
documents, because that equality is the only claim that the Windows path is finished.

**`preman import` writes into a group, never at the workspace root.** A request file needs a
collection, so a workspace with none is refused with that sentence, `--into` is required as soon as
there is more than one collection, and the app's destination list omits the root row that
`groupDestinations` offers everywhere else.

**The engine host reaches import through a dynamic import.** `api/import.ts` statically imports
`api/specs.js` for `planSpecs`, so a static import in `host.ts` would pull the proto loader into
every workspace open and undo ADR 029 for a feature most sessions never use. Applying an import
also drops the host's proto cache, for the same reason `writeSpecs` does.

**The exit codes are `0` and `1` only, and `--name` is applied at write time.** An import either
produced a file or refused; there is no transport. The name a user types travels with the apply call
rather than re-planning, which is why `applyImportPlan` takes an optional `name` and rewrites one
line of the document instead of the document being regenerated around it.
