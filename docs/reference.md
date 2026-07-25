# preman reference

This document covers the behavior omitted from the [README](../README.md).

## Workspace discovery

`preman` starts at the current directory and searches upward for either
`.postman/resources.yaml` or a `postman/collections` directory. Pass `-d, --dir <path>` to use
another workspace.

Postman Local View creates two directories:

- `.postman/` contains workspace metadata such as `resources.yaml`.
- `postman/` contains collections, environments, globals, and specifications.

## Commands and options

```text
preman list
preman run [<collection/request>]
preman run <collection|folder>
preman env show
preman env set <key> <value>
```

| Option | Behavior |
| --- | --- |
| `-d, --dir <path>` | Select a workspace instead of searching upward from the current directory. |
| `-e, --env <name>` | Load an environment. It is selected automatically when exactly one exists. |
| `--url <target>` | Override the target with `host:port` for gRPC or an origin for HTTP. |
| `--tls` | Force TLS, or HTTPS for HTTP requests. |
| `--insecure` | Force plaintext, or HTTP for HTTP requests. |
| `--timeout <ms>` | Set the call deadline. The default is `30000`. |
| `--var <key=value>` | Set a local variable at the highest precedence. Repeatable. |
| `--no-save` | Do not write script-modified variables back to the environment file. |
| `--descriptor` | For gRPC, use the embedded descriptor instead of the `.proto` file. |
| `--bail` | Stop a collection or folder run at the first failure. |
| `--json` | Emit machine-readable output. |
| `-v, --verbose` | Show request bodies, logs, headers, metadata, trailers, and full group reports. |

Test results and failed assertions are printed without `--verbose`.

## Selecting requests

A request selector is matched case-insensitively in four tiers. Matching stops at the first tier
with a result:

1. Exact path, such as `payment/Long Chau`
2. Exact request name, such as `Long Chau`
3. Path suffix, such as `nested/Deep Echo`
4. Substring

Ambiguous selectors fail and list their candidates. `preman` never chooses one silently.

When the selector is omitted in an interactive terminal, `preman` opens a searchable picker. In a
non-interactive shell it prints the candidates and exits with code `1`.

Collection and folder matching is exact by path or plain name. Fuzzy substring matching applies
only to requests, so a partial name cannot unexpectedly start a group run.

## Collection and folder runs

Requests run in Postman `order`: root requests first, followed by each folder's contents.

```text
$ preman run payment
payment  5 requests

✓ payment/Ping              OK / OK 3ms 1/1 tests
✓ payment/Echo              OK / OK 2ms 2/2 tests
- payment/Legacy Socket     skipped: websocket-request is not supported yet
✗ payment/Descriptor Only   UNIMPLEMENTED 3ms
✓ payment/nested/Deep Echo  OK / OK 4ms

5 requests · 3 ok · 1 failed · 1 skipped · 25ms
```

The group shares one variable store and one in-memory cookie jar. A variable or cookie created by
one request is available to later requests. Environment writeback happens once after the group
finishes.

An unsupported request kind is skipped and does not fail the run. A request that should be
supported but cannot be prepared, such as one with a missing schema or unresolved variable, is an
error. `--bail` stops after the first non-successful request; skipped requests do not trigger it.

With `--json`, a group emits an object containing `group`, `items`, `bailed`, `savedVars`, and
`exitCode`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Usage, configuration, request preparation, or script error |
| `2` | A gRPC status other than `OK`, or an HTTP request that received no response |
| `3` | A gRPC response whose `return_code` is not `OK`, or a non-2xx HTTP response |
| `4` | The call and payload succeeded, but a `pm.test` assertion failed |

A collection run returns its worst result in this order: `1`, `2`, `3`, `4`, `0`.

Codes `3` and `4` separate a business rejection from an assertion failure, which is useful in CI.

## gRPC

Only unary gRPC methods are supported. Streaming methods are rejected before invocation and name
the unsupported method.

### Schema resolution

The request's `schema.location` `.proto` file is preferred. Include directories are derived from
the specifications listed in `.postman/resources.yaml`, allowing root-relative imports such as:

```proto
import "asset/asset-exchange-v2-common.proto";
```

If the file is missing or cannot be loaded, `preman` falls back to the base64 `methodDescriptor`
stored in the request and prints a warning. The descriptor is a snapshot from when the request was
saved and may be stale or contain only one method. `--descriptor` forces this path.

### Target resolution

The target is selected in this order:

1. `--url`
2. The interpolated request `url`
3. `localhost:<grpc.port>` from `config/application-local.yml`
4. `localhost:9090`

TLS is inferred from a `grpcs` or `https` scheme, port `443`, or a `.zalopay.vn` hostname. Use
`--tls` or `--insecure` to override the inference.

## HTTP

HTTP requests use the same selectors, variables, scripts, cookie jar, output, and exit codes as
gRPC requests.

### Target and URL

The interpolated request URL must contain an origin. An empty or path-only URL is an error that
names unresolved variables and suggests `--url <origin>`.

For HTTP, `--url` replaces only the scheme, host, and port. The request's path and query remain
unchanged. A path supplied in `--url` is ignored with a warning.

### Headers and query parameters

`headers` and `queryParams` accept either a YAML map or Postman's array of
`{key, value, disabled}` entries. Disabled entries are dropped. A header whose interpolated value
is empty is treated as unset.

When a query key exists in both the URL and `queryParams`, the URL value wins and a warning names
the skipped key.

### Authentication

Supported authentication types are:

- `noauth`
- `bearer`
- `basic`
- `apikey`, in a header or query parameter

An explicit `authorization` header takes precedence over the `auth` block and produces a warning.
Unsupported authentication types are errors.

### Bodies, cookies, redirects, and compression

The request body is sent verbatim. It is not parsed and serialized again, and a body on `GET` is
not discarded. `content-type` is inferred from `body.type` only when the request does not provide
one.

Each run has an in-memory cookie jar. Collection runs share it across requests, and
`pm.sendRequest` uses the same jar. Domain and path matching follow RFC 6265. `HttpOnly` cookies are
visible through `pm.cookies`; `Secure` and `SameSite` are recorded but not enforced.

Redirects are followed for up to five hops. `authorization` and `cookie` are removed when the
origin changes. Reaching the limit produces a warning. `--verbose` prints the redirect chain.

`gzip`, `deflate`, and Brotli responses are decoded before scripts receive them.

## Variables

Variable precedence, from lowest to highest, is:

1. Globals
2. Collection variables
3. Environment variables
4. Local variables from `--var` and script writes

`{{name}}` tokens are expanded recursively with cycle detection. Unresolved tokens are errors and
name the missing variables instead of being sent on the wire.

Supported dynamic variables are:

- `$guid`
- `$randomUUID`
- `$timestamp`
- `$isoTimestamp`
- `$randomInt`

Each occurrence is evaluated independently.

## Scripts

Scripts run in a `node:vm` sandbox in this order:

| Request event type | When it runs |
| --- | --- |
| `beforeInvoke`, `prerequest`, `pre-request` | Before the request |
| `onMessage` | Once for the unary gRPC response message |
| `afterResponse`, `test`, `postResponse`, `post-response` | After the response |

The sandbox provides `pm.environment`, `pm.globals`, `pm.collectionVariables`, `pm.variables`,
`pm.info`, `pm.request`, `pm.expect`, `pm.test`, `pm.cookies`, `pm.sendRequest`, and the legacy
`postman.setEnvironmentVariable` family.

Post-response scripts also receive `pm.response`. For gRPC it contains `code`, `status`, `message`,
`responseTime`, `responseSize`, `metadata`, `headers`, `trailers`, and `messages`; `pm.message`
contains the first received message. For HTTP it contains `code`, `status`, `message`,
`responseTime`, `responseSize`, `headers`, `text()`, and `json()`.

```js
const message = pm.response.messages.idx(0);
const body = typeof message.data === "string" ? JSON.parse(message.data) : message.data;

pm.test("Transaction status is TRANS_PROCESSING", function () {
  pm.expect(body.transaction.status).to.equal("TRANS_PROCESSING");
});
```

`pm.sendRequest(request[, callback])` makes an extra HTTP request. Callback and `await` forms are
supported. Script `console` output is shown with `--verbose`. The sandbox does not expose
`process`, `require`, or `fetch`. A five-second deadline bounds the complete script, including
asynchronous work.

Post-response scripts are skipped when a request receives no response. For gRPC, that means a
transport failure. For HTTP, any received status, including `401`, still runs the script.

## Tests

`pm.expect` uses Chai 5 plus Postman-style response assertions.

```js
pm.response.to.have.status(0);
pm.response.to.have.metadata("content-type", "application/grpc");
pm.response.to.have.trailer("grpc-status-details-bin");
pm.response.messages.to.include({ return_code: "OK" });
```

```js
pm.response.to.have.status(200);
pm.response.to.have.header("content-type", "application/json");

const body = pm.response.json();
pm.test("logged in", () => pm.expect(body.data.token).to.be.a("string"));
```

A failed assertion does not abort the rest of the script. All tests run, and later variable writes
still take effect. Test callbacks must be synchronous; callback-style and `async` tests fail
explicitly. `pm.test.skip` and `pm.test.todo` record skipped tests.

## Environment writeback

Variables changed by scripts are written back after post-response scripts finish. The YAML edit
preserves comments, key order, and quoting. Collection runs write once after the group completes.
Use `--no-save` to disable writeback.
