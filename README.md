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

## Desktop app

`@preman/desktop` puts a window in front of the same engine: it opens a workspace, edits requests
and environments, and runs them. The CLI and the app read and write the same files, so a request
created in the window runs from the terminal, and a file changed by either one appears in the other
on its next read.

It can also create an empty workspace, named from the workspace dropdown, the File menu or the
command palette, always under `~/.local/share/preman/workspace`; `Open workspace…` remains the way
to a workspace that already exists anywhere else.

```sh
bun run desktop          # build the app and launch it
bun run desktop:package  # build, then wrap it into packages/desktop/release
```

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
