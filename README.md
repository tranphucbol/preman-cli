# preman

Run requests from a Postman Local View workspace, including unary gRPC, from the terminal.

`preman` is a small alternative runner for Postman's filesystem format. It is not a replacement
for the full Postman CLI.

## Why

[Local View and Native Git](https://learning.postman.com/docs/use/native-git/overview/) keep
collections, environments, specs, and tests in the same Git repository as the application code.
Postman Desktop remains a good place to edit them.

The free Postman CLI can run HTTP collections, but
[gRPC collection runs require a paid plan](https://learning.postman.com/docs/postman-cli/postman-cli-run-collection/):

```text
$ postman collection run postman/collections/payment
Error: This collection contains gRPC requests. Please upgrade your plan to run collections with gRPC protocol support.
Visit https://www.postman.com/pricing/ for more details.
```

`preman` reads the checked-in `.postman/` and `postman/` files directly, then runs those requests
locally without the paid Postman runner.

## Quick Start

Requires Node.js 20+ to install and Bun plus Node.js 20.19+ to build.

```sh
git clone https://github.com/tranphucbol/preman-cli.git
cd preman-cli
bun install
bun run build
cd packages/cli && npm link
```

The built `packages/cli/dist/preman.js` resolves runtime dependencies from `node_modules`; it is not
a standalone file. Keep it with the installed package, or install through npm so those dependencies
are present.

From a repository connected to Postman Local View:

```sh
preman list
preman run "payment/Long Chau"
```

```text
payment/Long Chau  →  pe.aev2.ExchangeService.Exchange
target localhost:9095 [plaintext] (request url) · schema proto-file

✓ OK / OK 563ms
{
  "return_code": "OK",
  "transaction": { ... }
}

✓ Transaction status is TRANS_PROCESSING
1 test · 1 passed
```

`preman` searches upward from the current directory for `.postman/resources.yaml` or a
`postman/collections` directory. Use `-d <path>` to point it at another repository.

## Usage

```text
preman list
preman run [<collection/request>]   run one request
preman run <collection|folder>      run every request in order
preman env show
preman env set <key> <value>
preman protos                       list the declared .proto files, grouped by shared link
preman protos link <name> <dir>     point a shared link at a checkout on this machine
preman migrate --list               list the Postman cloud workspaces in reach
preman migrate --workspace <id|name> --out <dir>
```

Common options:

| Option                           | Purpose                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `-d, --dir <path>`               | Select a workspace                                                             |
| `-e, --env <name>`               | Select an environment                                                          |
| `--url <target>`                 | Override the gRPC target or HTTP origin                                        |
| `--var <key=value>`              | Override a variable; repeatable                                                |
| `--tls` / `--plaintext`          | Force TLS or cleartext                                                         |
| `--ssl-extra-ca-certs <path>`    | Trust an extra CA on top of the public roots                                   |
| `--ssl-client-cert <path>`       | Client certificate for mutual TLS                                              |
| `--ssl-client-key <path>`        | Private key for that certificate                                               |
| `--ssl-client-passphrase <text>` | Passphrase for an encrypted key                                                |
| `-k, --insecure`                 | Skip server certificate verification                                           |
| `--working-dir <path>`           | Resolve request file paths from this directory; defaults to the workspace root |
| `--insecure-file-read`           | Allow request files outside the working directory                              |
| `-n, --iteration-count <n>`      | Run a collection or folder multiple times                                      |
| `--iteration-data <path>`        | Load iteration rows from a JSON or CSV file                                    |
| `--delay-request <ms>`           | Wait between collection requests                                               |
| `--timeout <ms>`                 | Set the whole-run budget when used with `--timeout-request`; `0` is unbounded  |
| `--timeout-request <ms>`         | Set each request deadline; defaults to `30000`                                 |
| `--timeout-script <ms>`          | Set each script deadline; defaults to `5000`                                   |
| `--no-save`                      | Do not write script changes back to the environment                            |
| `--bail`                         | Stop a collection run after the first failure                                  |
| `-r, --reporter <name>`          | Select `cli`, `json`, or `junit`; repeat or comma-separate                     |
| `--reporter-json-export <path>`  | Write the JSON report to a file                                                |
| `--reporter-junit-export <path>` | Write the JUnit report to a file                                               |
| `--json`                         | Alias for `--reporter json`                                                    |
| `--repoint`                      | `protos link` only: move a link that already points elsewhere                  |
| `-v, --verbose`                  | Show request, response, script, and transport details                          |

Run `preman --help` for every option.

## Supported

- Unary gRPC using the request's `.proto` file or embedded descriptor
- HTTP requests, including multipart form-data uploads, structured `urlencoded`, binary, and GraphQL bodies
- Collections and folders in Postman order
- Repeated collection runs with JSON or CSV iteration data
- Postman environments, globals, collection variables, and the [dynamic variable set](docs/reference.md#variables)
- Pre-request, post-response, and gRPC `onMessage` scripts
- Collection- and folder-level scripts and authentication, inherited by descendant requests
- `bearer`, `basic`, and `apikey` authentication for both HTTP and gRPC
- `pm.test`, `pm.expect`, cookies, `pm.sendRequest`, mutable `pm.request`, and sandbox `require()`
- Postman's common script libraries, including Lodash, CryptoJS, Moment, Cheerio, XML2JS, and UUID
- Private certificate authorities and mutual TLS, from flags or `.postman/preman.yaml`
- Declaring `.proto` files from a file browser, through a shared link that resolves on any machine
- Migrating a Postman cloud workspace onto disk, gRPC included
- Environment writeback and JSON output for CI
- JUnit reports for GitLab, Jenkins, and other CI test-report consumers

Print the normal report while writing JUnit XML for the CI test tab:

```sh
preman run payment -r cli,junit --reporter-junit-export junit.xml
```

Streaming gRPC and request kinds other than gRPC and HTTP are not supported. Unsupported items in
a collection run are reported instead of being executed.

See [the reference](docs/reference.md) for selection rules, variable precedence, protocol behavior,
scripts, assertions, exit codes, and schema resolution.

## Protos

A gRPC request finds its method through the `.proto` files the workspace declares in
`.postman/resources.yaml`. In the app, **Protos** in the command palette — or the link button beside
a gRPC request's method picker — browses for them.

Every declared path runs through a symlink farm at `/Users/Shared/postman-protos`, one link per
repository, named after it:

```yaml
localResources:
  specs:
    - /Users/Shared/postman-protos/zas-spec/api/zas/admin/admin.proto
    - /Users/Shared/postman-protos/acquiring-core/api/proto/admin.proto
```

That path is the same string on every machine, which an absolute path to your home directory is
not. What differs per machine is one symlink per repository, and both front ends tell you which ones
are missing by name. On a fresh checkout:

```sh
preman protos                                    # what is declared, and which links are absent
preman protos link zas-spec ~/repos/zas-spec     # one link covers every proto in that repository
```

In the app the same repair is a **Locate…** button beside each missing link. Adding a proto stages a
plan first: it names the link it would create, shows the path it would write, and loads each `.proto`
so an unresolvable `import` surfaces before anything is written. Nothing reaches disk until you
apply it.

The link points at the checkout's root, so imports resolve exactly as they do inside the repository.
A workspace whose specs are still plain relative or absolute paths keeps working; **Move onto
links…** converts them in one reviewed step.

Set `PREMAN_SHARED_PROTO_ROOT`, or the field in the app's settings, if `/Users/Shared` is not
writable on your machine. Only where this machine _looks_ moves — what the workspace records is
always the default, so the file stays portable.

## Migrating from Postman cloud

If the collections are still in a Postman cloud workspace rather than in Git, `preman migrate` copies
one onto disk in the same format Local View writes:

```sh
preman migrate --list
preman migrate --workspace "Payment Core" --out ./payment-core
```

```text
Migrated 2 collections, 1 folder, 1 environment into ./payment-core
  1 gRPC request
  2 HTTP requests
  1 skipped (websocket-request)
      Adapter/Legacy/Legacy Socket
```

**Postman Desktop must be running and signed in.** `preman` borrows that window's own session, so
there is no API key to create and no password to type. `--workspace` takes an id or a name; two
workspaces sharing a name are reported with their ids rather than guessed between. `--dry-run` prints
every file that would be written and writes none. The destination must be empty — an existing
workspace is never merged into.

A large workspace takes the better part of a minute, so it draws a bar while it works:

```text
  reading collections   █████░░░░░░░░░░░░░░░  29%  12/41  327 reads
```

It is on standard error, so the report and `--json` still pipe cleanly, and it comes back down before
anything is printed. The proportion counts collections rather than requests, because Postman reveals
what is inside a collection only as it is read — the total number of calls is genuinely unknown until
the end, and a bar that revised its own denominator would slide backwards.

This reads Postman's private API, which is the only one that can see gRPC requests; the documented
one returns schema v2.1 and omits them entirely. It is undocumented, so a Postman update can break
it without notice.

**A migrated gRPC request needs its `.proto` on disk.** Postman's cloud copy of the embedded
descriptor is truncated — 184 of 188 requests in the workspace this was measured against came back cut
to 300 characters, and a truncated descriptor does not decode. Where Postman recorded the path to the
`.proto` it was built from, the migration keeps that path exactly as recorded and lists it in
`.postman/resources.yaml`, so on the machine that authored the request it runs against the live file,
which is the better source anyway. Where it did not, or where the file is not on this machine, the
request is still written and says which `.proto` it wants when you run it. Request kinds `preman`
cannot run, websockets among them, are skipped and named one line each, so it is clear what stayed
behind.

The desktop app does the same thing from **File ▸ Migrate from Postman…**, or the command palette: it
lists the workspaces, asks where to put the one you pick, and opens it when it is written.

## Desktop app

`@preman/desktop` puts a window in front of the same engine: it opens a workspace, edits requests
and environments, and runs them. The CLI and the app read and write the same files, so a request
created in the window runs from the terminal, and a file changed by either one appears in the other
on its next read.

Every release carries a macOS **arm64** DMG on
[the releases page](https://github.com/tranphucbol/preman-cli/releases). It is ad-hoc signed rather
than notarized, because a Developer ID belongs to whoever ships the build and not to this repository
([ADR 018](docs/decisions/018-what-goes-in-the-packaged-bundle.md)). macOS quarantines anything a
browser downloaded, and Gatekeeper reports a quarantined ad-hoc-signed app as
`"preman" is damaged and can't be opened` rather than as merely unsigned — so drag `preman.app` to
`/Applications`, then clear the attribute the download added:

```sh
xattr -dr com.apple.quarantine /Applications/preman.app
```

Nothing inside the app changes; only that attribute is removed. There is no Intel or universal
build, so an Intel Mac has nothing to run yet
([ADR 030](docs/decisions/030-ci-asserts-everything-but-the-clock.md)).

It can also create an empty workspace, named from the workspace dropdown, the File menu or the
command palette, always under `~/.local/share/preman/workspace`; `Open workspace…` remains the way
to a workspace that already exists anywhere else.

A new request comes from either end of the window. The sidebar's context menu on a collection or a
folder offers **New HTTP request**, **New gRPC request** and **New folder**, which put one inside it;
the `+` in the tab row, beside the environment picker, asks the same three as one form — the
protocol, a name, and which collection or folder it goes in, with **New folder** beside its
**Create**. That form's destination list starts at the workspace root, which is where a collection
lives, so the first one can be made from there too. The context menu on a request itself offers
**Duplicate**, which copies the file —
comments, scripts and examples included — to `Foo copy` directly below the original and opens it.
Duplicate copies what is on disk, so save an edited tab first.

An environment is made from the last row of the environment picker itself — **New environment…**,
below the values and a rule — or from the command palette. It is created empty and becomes the
active one, so the next `{{token}}` you write has somewhere to be set. A name another environment
already holds is refused rather than resolved to `Foo (2)`: an environment is reached by name, by
the picker and by `-e` alike, so two files answering to one name would be one of them silently
ignored. The picker is present in every workspace, including one with no environments yet.

A raw HTTP body and a gRPC message can be re-indented from the **Beautify** glyph at the right of
their toolbar. It rewrites whitespace and nothing else, so a bare `{{token}}`, `1e3`, `1.0` and a
twenty-digit id all survive byte for byte — a body is bytes that go on the wire, and a formatter that
reserialises them sends a different request. `Cmd+Z` reverts it, and a body it cannot read says so
rather than being quietly changed. The response pane's pretty-print toggle is the same gesture on the
other half of the app; that one does reserialise, because a response has already been sent.

```sh
bun run desktop          # build the app and launch it
bun run desktop:inspect  # the same, with the main process's inspector on 127.0.0.1:9229
bun run desktop:package  # build, then wrap it into packages/desktop/release
```

The app writes one log — `preman.log` in Electron's `logs` directory, which **Settings ▸
Diagnostics** will reveal for you — holding process lifecycle, host spawns, exits and crash reasons,
every failure the engine turned into an error you saw, and everything the engine wrote to its own
output. Each line is timestamped and carries one of `INFO`, `WARN`, `ERROR` or `FATAL`:

```
2026-08-31T20:36:35.613Z INFO  preman starting: 43.4.1 (electron 43.4.1, chrome 150.0.7871.224, node 24.18.1)
2026-08-31T20:36:35.644Z INFO  preman-engine-acquiring-core: engine host started for /Users/you/repos/acquiring-core
2026-08-31T20:36:45.283Z WARN  preman-engine-acquiring-core: proto not loaded: cannot read /Users/you/repos/acquiring-core/api/proto/refund.proto: ENOENT
```

There is nothing to turn on and nothing to filter, and it holds no traffic at all: no URL, no
header, no body, no variable. The engine resolves `{{token}}` before it sends, so a log that
recorded a request would be a credential file with a different name; the console drawer is where you
look at a request. It does name files inside your workspace, which means your home directory is in
it — worth a glance before you attach one to a bug report. See
[ADR 035](docs/decisions/035-the-log-contains-no-traffic.md) and
[ADR 036](docs/decisions/036-the-log-says-how-bad-it-was.md).

To debug the engine, set `PREMAN_INSPECT=1` (or `brk`, to stop before it reads the workspace) and
the host forks with an inspector on an ephemeral port — one host per open workspace, so the port
cannot be fixed. The `Debugger listening on ws://…` line it prints is forwarded to the terminal
along with everything else the host says; `.vscode/launch.json`'s **engine** configuration asks for
that URL, and **preman** attaches to both processes at once.

The console drawer logs every call the app makes, not only what the scripts said: each request
appears where it happened, with the logs and `pm.sendRequest` calls it caused indented under it, and
expands to show what was sent and what came back.

Window bounds, open tabs, and unsaved drafts live in Electron's `userData`, never in the workspace,
so `git status` stays clean while the app is open. Packaging targets are configured for macOS in
`packages/desktop/electron-builder.yml`.

The window holds no engine: it talks to a separate process over a message port. See
[the engine protocol](docs/reference.md#engine-protocol) for that contract.

## Development

```sh
bun run typecheck
bun run typecheck:core
bun run test
bun run test:watch
bun run build
bun run lint
bun run lint:fix
bun run format
bun run format:check
```

The performance budgets in `test/perf.test.ts` run with the normal suite. The ones that need a real
window launch Electron five times, so they are gated and want a built app:

```sh
bun run build && PREMAN_PERF=1 bunx vitest run test/renderer/perf.app.test.ts
```

[`docs/performance.md`](docs/performance.md) is the budget itself, and what each number counts.
[`docs/decisions/`](docs/decisions/README.md) is why the app is shaped the way it is — three
processes, a synchronous core, an editor that never reformats your files.
