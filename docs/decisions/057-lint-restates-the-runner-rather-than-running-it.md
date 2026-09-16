# 057: Lint restates the runner rather than running it

Status: Accepted

## Decision

`preman lint` walks every request in a workspace and reports the fields preman will not honour,
using rules written a second time in `packages/core/src/api/lint.ts` rather than reusing the
run-time checks that already know the same facts.

Findings are graded. An `error` means the request cannot do what it says: no body is sent, a file
is named that is not there, an auth type throws before the socket opens. A `warning` means the
request runs, but something the author wrote is being dropped — `body.content` beside
`body.formdata`, a header the auth block replaces. Errors exit `1`; warnings exit `0` unless
`--strict`, which is what CI passes.

The rules read only the files. Nothing here resolves a `{{token}}`.

## Rationale

preman already has a warnings channel. `buildBody` returns `{ wire, warnings }`, `applyAuth`
returns warnings beside its header, and `runner.ts` concatenates them into the outcome. It is
accurate, it is maintained, and it is the obvious thing to reuse.

It is also unreachable without a request going out. That is fatal for a review tool twice over:
learning that a field is ignored should not cost a call to a real server, and for a mutating
request — the create that clones repositories and starts a process — it is not a question you can
afford to ask. The workspace that prompted this had a `POST /instances` whose multipart parts were
written under `body.content` instead of `body.formdata`. Every layer accepted it: the schema is
`.passthrough()`, so it parsed; the desktop grid reads `body.formdata`, so it painted nothing; and
`buildBody` returns at the formdata branch before it reaches the `body.content ignored` warning
the urlencoded branch would have raised. The file was valid, the UI was blank, and a CLI run would
have POSTed with no body and no `Content-Type` at all. Nothing in the system was willing to say so
without first sending the request that must not be sent.

Extracting the checks into something both the runner and the linter call was the alternative, and
it is the one that keeps them honest by construction. It was rejected for now because the run-time
warnings are produced _while_ building bytes — `multipartBody` discovers a missing `src` on the
way to reading the file — so the shared thing would have to be the body builder itself, run in a
mode that produces no bytes. That is a larger change to the hottest path in core than a review
tool justifies, and it would put a `dryRun` branch in code whose correctness is the product.

So the rules are restated, and the duplication is the price. It is paid down by naming each rule
(`body-parts-missing`, `auth-header-replaced`) and pinning it in `test/lint.test.ts` to the branch
it mirrors, so a rule that drifts from its twin fails a test rather than quietly lying.

Variables are excluded on the same evidence. A `{{instance_id}}` unresolved at rest is normal: the
workspace that motivated this sets it from an `afterResponse` script on the create and reads it in
five later requests. A linter that flagged it would be wrong five times to be right once, and a
linter that is wrong is one people turn off.

## Consequences

Two places now encode what `body.type: formdata` reads. A change to `buildBody`'s dispatch that is
not mirrored here makes the linter wrong, and the only thing catching that is a test fixture and a
reviewer who remembers this file exists.

The grading is a judgement, not a derivation. `kind-unsupported` is a warning because one
websocket request should not fail a workspace; `grpc-schema-descriptor-only` is a warning because
`grpc/schema.ts` falls back to the embedded descriptor rather than throwing. Each of those is a
separate decision about someone else's code, and each can be wrong on its own.

`SpecsView.unresolvedLinks` is deliberately not read. It is machine-wide, so a link this workspace
never touches would otherwise fail its lint; a link it does touch already surfaces as
`spec-absent`.

`--strict` exists because the useful findings are mostly warnings. A team that wants the Paparazzi
bug caught in CI wants the ignored-field warnings to be fatal there and advisory locally, and one
exit code cannot be both.
