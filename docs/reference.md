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

Requests run in Postman `order`. At every level of the tree, requests and subfolders are one
sorted list: they interleave by `order`, entries without an `order` come last, and ties are broken
by name. A folder's `order` lives in its `.resources/definition.yaml`.

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

A group also stops early when an *inherited* script throws, even without `--bail`, because a shared
precondition is broken and rerunning the same failing login for every remaining request only
produces noise. The summary says which script aborted the run:

```text
aborted: folder ZAS script "http:beforeRequest" failed: login returned 500
```

With `--json`, a group emits an object containing `group`, `items`, `bailed`, `bailReason`,
`savedVars`, and `exitCode`. `bailReason` is `"bail-flag"`, `"inherited-script"`, or `null`.

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

### Authentication

gRPC uses the same `auth` block and the same supported types as HTTP, rendered into call metadata.
`bearer` and `basic` become an `authorization` entry; `apikey` becomes an entry named after its key.
Metadata keys are lowercased, since gRPC treats them case-insensitively.

gRPC has no query string, so `apikey` with `in: query` is skipped with a warning. An `authorization`
entry written directly in the request's `metadata` wins over the `auth` block and produces a
warning, mirroring the HTTP header rule.

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

Authentication is inherited, following Postman v2.1. A request with no `auth` key inherits from the
nearest ancestor that declares one; a request that must be unauthenticated writes
`auth: {type: noauth}` explicitly. Inherited authentication produces a warning naming its origin,
because silent authentication is how a stale token turns into an unexplained `401`.

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

### Collection and folder scripts

A collection or folder declares scripts in its `.resources/definition.yaml`, and every descendant
request inherits them — including when that request is run on its own, not as part of a group.

Above the request level the event type must be prefixed with the protocol it applies to, because a
group usually holds both gRPC and HTTP requests:

| Group event type | Equivalent request event |
| --- | --- |
| `grpc:beforeInvoke` | `beforeInvoke` |
| `grpc:onMessage` | `onMessage` |
| `grpc:afterResponse` | `afterResponse` |
| `http:beforeRequest` | `prerequest` |
| `http:afterResponse` | `afterResponse` |

A prefix that names the other protocol is skipped silently — that is the point of the prefix. An
*unprefixed* type at group level is skipped with a warning, since it cannot be attributed to either
protocol. Request-level types stay unprefixed, and additionally tolerate a prefix.

Within each stage, scripts run outermost first: collection, then each folder from outermost to
innermost, then the request. The chain is not unwound on the way back out.

A throw from an inherited script aborts the whole group, as described in
[collection and folder runs](#collection-and-folder-runs). A throw from a request-level script fails
only that request. A failing `pm.test` never aborts anything, at any level — it is a result, not an
error.

Console lines, test results, and warnings from an inherited script carry their origin, in
`--verbose` and in `--json`:

```text
script log [folder ZAS]: logged in as admin
✓ token is present [collection Admin]
```

Request-level output is untagged.

### Sandbox

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
