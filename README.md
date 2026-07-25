# preman

A CLI that runs the requests stored in a **Postman filesystem-format workspace** — the
`.postman/` + `postman/` folders Postman writes when a collection is synced to a git repo.

Point it at a repo, pick a request, get a response — unary gRPC or HTTP. No Postman app, no
`protoc`, no hand-maintained `grpcurl` or `curl` incantations.

```
$ preman run "Long Chau" -d ~/repos/asset-exchange-v2
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

## Why

The workspace already contains everything needed to make the call and to check the answer:
the target URL, the message body, the variable definitions, the scripts on both sides of the
call, and a pointer to the `.proto` file. `preman` is the missing piece that reads it, dials,
and runs your `pm.test` assertions.

## Install

Requires Node 18+ (Bun is used for development, not at runtime).

```sh
bun install
bun run build          # produces ./dist/preman.js
npm link               # optional: puts `preman` on your PATH
```

Or run straight from source during development:

```sh
bun run src/cli.ts list
```

## Usage

```
preman list
preman run [<collection/request>]   run one request
preman run <collection|folder>      run every request in it, in order
preman env show
preman env set <key> <value>
```

| option | meaning |
| --- | --- |
| `-d, --dir <path>` | workspace to use (default: search upwards from cwd for `.postman/resources.yaml`, or a `postman/collections` folder) |
| `-e, --env <name>` | environment to load; auto-selected when the workspace has exactly one |
| `--url <target>` | override the target: `host:port` for gRPC, an origin for HTTP (the request's own path and query are kept) |
| `--tls` / `--insecure` | force TLS on or off (`https`/`http` for HTTP requests), overriding the heuristic |
| `--timeout <ms>` | call deadline (default `30000`) |
| `--var <k=v>` | set a variable at the highest precedence; repeatable |
| `--no-save` | do not write script-modified variables back to the environment file |
| `--descriptor` | gRPC only: use the request's embedded descriptor instead of the on-disk `.proto` |
| `--bail` | in a collection run, stop at the first request that does not fully succeed |
| `--json` | machine-readable output |
| `-v, --verbose` | show request body, script logs, headers, metadata and trailers |

Test results and failed assertions are always printed, with or without `-v`.

### Selecting a request

The selector is matched case-insensitively in four tiers, stopping at the first that hits:
exact path (`payment/Long Chau`), exact name (`Long Chau`), path suffix (`nested/Deep Echo`),
then substring. An ambiguous selector is an error listing the candidates — `preman` never
guesses which request you meant.

Omit the selector entirely and, if stdin/stdout are a TTY, you get a searchable picker.
In a non-interactive shell the candidate list is printed and the command exits `1`.

### Running a whole collection

Name a collection or a folder instead of a request and every request inside it runs, in
Postman `order`, root requests first and then each folder's contents:

```
$ preman run payment
payment  5 requests

✓ payment/Ping              OK / OK 3ms 1/1 tests
✓ payment/Echo              OK / OK 2ms 2/2 tests
- payment/Legacy Socket     skipped: websocket-request is not supported yet
✗ payment/Descriptor Only   UNIMPLEMENTED 3ms
✓ payment/nested/Deep Echo  OK / OK 4ms

5 requests · 3 ok · 1 failed · 1 skipped · 25ms
```

Group matching is exact — a collection or folder path, or its plain name. The fuzzy
substring tier stays request-only, so `preman run pay` still means "the request whose path
contains pay", never a surprise fan-out across a whole collection.

The whole group shares one variable store, exactly like Postman's collection runner: a
`trans_id` computed by the first request's script is visible to every request after it. The
environment writeback happens once, at the end, rather than once per request.

A request that cannot run at all is reported rather than aborting the batch:

- an unsupported `$kind` is **skipped** and does not fail the run
- a request that should have run but broke before the wire (missing schema, unresolvable
  variable) is an **error**

The run's exit code is the worst outcome it saw, in this order: error (`1`) > transport
(`2`) > business (`3`) > failed test (`4`) > success (`0`). Add `--bail` to stop at the first
failure instead of running everything; skips never trip it, a failed assertion does. `-v`
prints each request's full report instead of the compact table, and `--json` emits
`{group, items[], bailed, savedVars, exitCode, ...}`.

### HTTP requests

`$kind: http-request` files run through the same pipeline — same selector, same variables, same
scripts, same exit codes — with these protocol rules:

- **`headers` and `queryParams`** are accepted both as a YAML map (`X-CSRF-Token: "{{token}}"`)
  and as a Postman array of `{key, value, disabled}`. Disabled entries are dropped, and a
  header whose value interpolates to empty is treated as unset rather than sent blank.
- **The URL's own query string wins.** A `queryParams` key already present in the `url` is not
  appended a second time, and the run warns which keys it skipped — Postman workspaces
  routinely carry both copies.
- **`auth`** supports `noauth`, `bearer`, `basic` and `apikey` (header or query). An explicit
  `authorization` header beats the `auth` block, with a warning, so the file always wins over
  the metadata. Anything else is a hard error listing the supported types.
- **The body is sent verbatim.** No JSON round-trip, so formatting and key order survive.
  `content-type` is derived from `body.type` only when the author set no header of their own,
  and a body on a `GET` is sent rather than silently dropped, matching Postman.
- **Cookies.** Each run gets an in-memory jar, shared across a collection run, so a login's
  `Set-Cookie` authenticates every request after it. Path and domain matching follow RFC 6265
  (including the delete-then-set pairs real servers emit); `HttpOnly` cookies are visible to
  `pm.cookies` on purpose, and `Secure`/`SameSite` are recorded but not enforced.
- **Redirects** are followed up to five hops, with `authorization` and `cookie` stripped when
  the origin changes; `-v` prints the chain, and hitting the cap is a warning, not a crash.
- **Compressed responses** (`gzip`, `deflate`, `br`) are decoded before scripts see them.

### Exit codes

| code | meaning |
| --- | --- |
| `0` | success |
| `1` | usage or configuration error |
| `2` | transport failure: a gRPC status other than `OK`, or no HTTP response at all |
| `3` | a response arrived but `return_code` is not `OK` (gRPC), or the HTTP status is not 2xx |
| `4` | call and payload were fine, but a `pm.test` assertion failed |

Codes `3` and `4` are the useful ones in CI: a transport-level `OK` that carries a business
failure is not a passing test, and neither is a response your own assertions reject. They are
kept apart so a pipeline can tell "the service said no" from "the service said something we
did not expect". A collection run reports the worst outcome it saw, in that same order.

## How it resolves things

**Schema.** The request's `schema.location` `.proto` is preferred, loaded with include dirs
derived from the specs listed in `.postman/resources.yaml`, so root-relative imports like
`import "asset/asset-exchange-v2-common.proto"` resolve exactly as they do for the server
build. If that file is missing or fails to load, `preman` falls back to the base64
`methodDescriptor` embedded in the request and warns — that descriptor is a snapshot from
whenever the request was last saved in Postman and may be stale or contain only the one
method that was invoked. `--descriptor` forces the fallback path.

**gRPC target.** `--url` wins, then the request's own `url` (after variable interpolation),
then `localhost:<grpc.port>` read from `config/application-local.yml`, then `localhost:9090`.
TLS is inferred from a `grpcs`/`https` scheme, port `443`, or a `.zalopay.vn` host; use
`--tls`/`--insecure` to override.

**HTTP target.** The origin comes from the interpolated `url` and is never guessed: a `url`
that is empty or path-only after interpolation — the usual symptom of an unset
`{{admin_http_url}}` — is a hard exit-`1` error that names the variable to set or tells you to
pass `--url <origin>`. `--url` replaces only the scheme, host and port; the request's own path
and query are kept, so `--url localhost:3000` retargets every request in a collection without
rewriting a single file. A path in `--url` is ignored with a warning.

**Variables.** Four scopes, lowest precedence first: globals, collection, environment, local
(`--var` and script writes). Tokens are `{{name}}`, expanded recursively with cycle
detection. Supported dynamic variables: `$guid`, `$randomUUID`, `$timestamp`,
`$isoTimestamp`, `$randomInt` — each occurrence is evaluated independently, so two
`{{$guid}}` tokens in one body produce two different UUIDs. Anything unresolved is a hard
error naming the offending tokens rather than a request sent with `{{trans_id}}` on the wire.

**Scripts.** Scripts run in a `node:vm` sandbox with a `pm` shim. Three event types are
executed, in this order:

| `type` in the request YAML | when |
| --- | --- |
| `beforeInvoke`, `prerequest`, `pre-request` | before the call |
| `onMessage` | gRPC only: once per received message (once, for a unary call) |
| `afterResponse`, `test`, `postResponse`, `post-response` | after the call |

Every script gets `pm.environment`, `pm.globals`, `pm.collectionVariables`, `pm.variables`,
`pm.info`, `pm.request`, `pm.expect`, `pm.test`, `pm.cookies`, `pm.sendRequest`, and the legacy
`postman.setEnvironmentVariable` family. Post-call scripts additionally get `pm.response`,
whose shape follows the protocol:

- gRPC: `code`, `status`, `message`, `responseTime`, `responseSize`, `metadata`, `headers`
  (an alias of `metadata`), `trailers`, `messages` — plus `pm.message`, the first received
  message.
- HTTP: `code` (the status), `status` (the reason phrase), `message`, `responseTime`,
  `responseSize`, `headers`, `text()` and `json()`. There is no `messages` and no
  `pm.message`, because an HTTP response is one body rather than a message stream.

`pm.cookies.get(name)` reads the run's cookie jar, and `pm.sendRequest(req[, cb])` fires an
extra HTTP call that shares that jar — both the callback and the `await` form work. The gRPC
`pm.message` idiom is unchanged:

```js
const message = pm.response.messages.idx(0);
const body = typeof message.data === "string" ? JSON.parse(message.data) : message.data;

pm.test("Transaction status is TRANS_PROCESSING", function () {
  pm.expect(body.transaction.status).to.equal("TRANS_PROCESSING");
});
```

`console` output is captured and shown under `-v`. There is no `process`, `require` or
`fetch` inside the sandbox. Scripts may `await` — that is what makes `pm.sendRequest` usable —
and the 5s deadline bounds the whole script, asynchronous work included.

**Tests.** `pm.expect` is [chai](https://www.chaijs.com/) 5, plus the assertions Postman
documents. For gRPC:

```js
pm.response.to.have.status(0);                        // or "OK", case-insensitive
pm.response.to.have.metadata("content-type", "application/grpc");
pm.response.to.have.trailer("grpc-status-details-bin");
pm.response.messages.to.include({ return_code: "OK" });   // deep-partial match
```

For HTTP:

```js
pm.response.to.have.status(200);                      // or "Not Found", case-insensitive
pm.response.to.have.header("content-type", "application/json");

const body = pm.response.json();                      // pm.response.text() for the raw body
pm.test("logged in", () => pm.expect(body.data.token).to.be.a("string"));
```

Test results are always printed, not just under `-v`. Three deliberate rules:

- **A failing assertion does not abort the script.** Every `pm.test` in the file runs, so one
  run tells you everything that is wrong, and any `pm.environment.set` after the failure
  still happens.
- **Tests must be synchronous.** `pm.test("x", function (done) { ... })` and `async`
  callbacks fail loudly with "async tests are not supported" instead of silently passing
  before the assertion ever ran. `pm.test.skip` and `pm.test.todo` record a skip.
- **Post-call scripts are skipped when the call never landed.** On a transport failure there
  is no response to assert against, so running the script would only turn a clear
  `UNAVAILABLE` (exit `2`) into a `TypeError` (exit `1`). `preman` skips them and says so in
  the warnings. This is a deviation from Postman, which runs the script anyway. For HTTP,
  "never landed" means exactly that — no response at all. Any status that produced one, `401`
  included, runs `afterResponse`, so the error body stays assertable.

**Writeback.** Variables a script changed are written back to the environment YAML using a
document-preserving edit, so comments, key order and quoting survive. Post-call scripts count
too — the write happens after they run, so a `trans_id` captured from a response is persisted.
`--no-save` skips it.

## Scope

`preman` handles **unary gRPC** and **HTTP** requests. Any other `$kind` — a
`websocket-request`, say — produces a clear "not supported yet" error listing the kinds that
do work, rather than a confusing failure. Streaming gRPC methods are rejected up front with
the method name, since there is no sensible single-shot semantics for them.

## Development

```sh
bun run typecheck
bun run test          # 199 tests
bun run test:watch
bun run build
```

The test suite includes an end-to-end layer that boots a real in-process `@grpc/grpc-js`
server from a fixture `.proto` and asserts the exact bytes that reach the wire, every exit
code path, the environment writeback, and the `pm.test` reporting — including the verbatim
`afterResponse` script from the real workspace. The HTTP suites do the same against an
in-process `node:http` server: cookie replay across a collection run, the query-param dedupe,
a `401` whose script still runs, a body on `GET`, gzip, the redirect cap and `pm.sendRequest`
are all asserted from what actually reached the server.
