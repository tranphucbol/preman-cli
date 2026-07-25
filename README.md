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

Requires Node.js 20+ and Bun to build.

```sh
git clone https://github.com/tranphucbol/preman-cli.git
cd preman-cli
bun install
bun run build
npm link
```

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

| Option | Purpose |
| --- | --- |
| `-d, --dir <path>` | Select a workspace |
| `-e, --env <name>` | Select an environment |
| `--url <target>` | Override the gRPC target or HTTP origin |
| `--var <key=value>` | Override a variable; repeatable |
| `--tls` / `--insecure` | Force TLS or plaintext |
| `--no-save` | Do not write script changes back to the environment |
| `--bail` | Stop a collection run after the first failure |
| `--json` | Print machine-readable output |
| `-v, --verbose` | Show request, response, script, and transport details |

Run `preman --help` for every option.

## Supported

- Unary gRPC using the request's `.proto` file or embedded descriptor
- HTTP requests
- Collections and folders in Postman order
- Postman environments, globals, collection variables, and dynamic variables
- Pre-request, post-response, and gRPC `onMessage` scripts
- Collection- and folder-level scripts and authentication, inherited by descendant requests
- `bearer`, `basic`, and `apikey` authentication for both HTTP and gRPC
- `pm.test`, `pm.expect`, cookies, and `pm.sendRequest`
- Environment writeback and JSON output for CI

Streaming gRPC and request kinds other than gRPC and HTTP are not supported. Unsupported items in
a collection run are reported instead of being executed.

See [the reference](docs/reference.md) for selection rules, variable precedence, protocol behavior,
scripts, assertions, exit codes, and schema resolution.

## Development

```sh
bun run typecheck
bun run test
bun run test:watch
bun run build
```
