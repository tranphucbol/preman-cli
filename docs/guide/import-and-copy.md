# Importing and copying commands

## Importing a pasted command

**Copy as cURL** in a browser's devtools, or a `grpcurl` line from a runbook, becomes a request file:

```sh
pbpaste | preman import --into admin
```

```text
Imported POST Create order -> postman/collections/admin/Create order.request.yaml

  Not imported
    --compressed  preman already negotiates response encoding
```

Every flag is accounted for. The ones `preman` can represent become fields; the ones it cannot are
listed with the reason, so nothing is dropped quietly. `--dry-run` prints the document it would
write and writes nothing.

**Pasting inline needs a `--` fence.** `preman` owns `-d`, `-e`, `-k`, `-n`, `-r` and `-v`, and curl
spells all six differently — unfenced, `curl -d '{"sku":"A-1"}' https://x` hands the body to
`--dir` and nothing reports it. So everything after `--` is the paste, verbatim:

```sh
preman import --into admin -- curl -X POST -H 'content-type: application/json' \
  --data-raw '{"sku":"A-1","qty":2}' https://api.example.test/v1/orders
```

Piping from the clipboard or passing `--from <file>` needs no fence. `--into` picks the collection
or folder, and is required as soon as the workspace has more than one collection; `--name` overrides
the name taken from the URL's last path segment. Chrome's macOS copy (`\`-continued, with `$'…'`
quoting) and its Windows copy (`^`-continued, with `"…"`) are both accepted and produce the same
file.

A `grpcurl` paste is imported the same way. A `-proto` that exists on disk is declared through the
[shared link](protos.md#the-shared-link), so the request runs on the first send:

```sh
preman import --into payment -- grpcurl -plaintext \
  -proto ~/src/refund-core/api/refund/v1/refund.proto \
  -d '{"id":"r-1"}' localhost:9090 refund.v1.RefundService/Get
```

A paste with no `-proto` relies on gRPC server reflection, which `preman` does not do. It is still
imported — the target, metadata, and message are worth keeping — and it says so at import time and
again when the run reaches schema resolution.

The desktop app does the same from the sidebar header's import button, **File ▸ Import from cURL or
grpcurl…**, a group's context menu, or the command palette. The dialog pre-fills itself from the
clipboard when it holds a command, and shows the exact document before anything is written.

The [reference](../reference.md#import) lists what each flag becomes and why the rest are dropped.

## Copying a request as a command

The other direction. `preman copy` prints one request as the command that would send it — `curl`
for an HTTP request, `grpcurl` for a gRPC one, decided by the request's kind rather than by a flag:

```sh
preman copy admin/Profile --env QC | pbcopy
```

```text
curl -H 'Authorization: Bearer eyJhbGci…' -L 'https://api.example.test/profile?tab=main'

  Not in this command
    collection admin http:beforeRequest  not run; a script that sets a header is not in this command
    pm.test assertions                   a command has no test result
    cookie jar                           populated by earlier responses in a run

  In cleartext
    auth      the request's own auth block
    http_url  environment
    token     environment
```

Nothing is sent and no script runs, so the only exit codes are `0` and `1`. Everything the command
cannot carry is named — the scripts that would have run, the `pm.test` assertions that have no
result, the cookie jar, the timeout — and every `{{token}}` that was substituted is listed with the
scope it came from. Nothing is redacted: `preman` has no way to tell a credential from a variable,
so it reports what it resolved and leaves the judgement to you.

A gRPC request comes out as a `grpcurl` with the `-proto` and `-import-path` flags it needs. Those
are paths on this machine, which is warned; a request resolved from an embedded descriptor has no
`.proto` to name at all, so the command is printed with the schema listed as missing and a warning
that it will not run as written.

The app shows the same thing in a panel beside the request, opened with the **`</>`** button in the
request bar, a request's context menu, **File ▸ Copy as cURL or grpcurl**, or the command palette.
It follows your unsaved edits rather than what is on disk, so editing the url rewrites the command
without saving first — a text box lands when you leave it, an editor when you pause. The clipboard
is written when you press Copy and never on open.

The [reference](../reference.md#copy) says what each command carries.
