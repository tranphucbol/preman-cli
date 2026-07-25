# Plan: `$kind: http-request` support

Status: in progress.

Adds first-class HTTP request support to preman alongside unary gRPC. Driven by a real
workspace: `admin-tool-backend` (53 `http-request` files, 0 gRPC, Go/Gin backend).

## Decisions

| #  | Decision |
| -- | -------- |
| 1  | `.postman/resources.yaml` becomes optional; a directory containing `postman/collections` is a valid workspace |
| 2  | queryParams: the URL query string is authoritative. Append only keys absent from it, skip `disabled: true`, accept both map and array shapes |
| 3  | Exit codes: network failure/timeout → `2`, non-2xx → `3`, failed `pm.test` → `4`. `return_code` stays a gRPC-only concept |
| 4  | Cookie jar: in-memory, one per run (shared across a group), keyed by `(name, domain, path)`, host+path matching, `Secure`/`SameSite` ignored, `HttpOnly` visible to scripts |
| 5  | `RunOutcome` becomes a discriminated union on `protocol` |
| 6  | `--url` replaces the origin only and keeps path+query; `--tls`/`--insecure` force `https`/`http` |
| 7  | An unresolvable origin is a `CliError` (exit 1) with actionable details, never a guess |
| 8  | Auth: `noauth`, `bearer`, `basic`, `apikey`; unknown type → `CliError`. An explicit `authorization` header wins over the `auth:` block, with a warning |
| 9  | Body sent verbatim (no JSON round-trip); `content-type` derived from `body.type` only when no explicit header; a body is sent on GET |
| 10 | `pm.response` for HTTP: `json()`, `text()`, `code`, `status`, `headers`, `responseTime`, `responseSize`; new chai `.header(k[,v])`; no `messages`/`pm.message` |
| 11 | Redirects followed, max 5, final URL reported |
| 12 | `pm.sendRequest` supported → the script pipeline becomes async end-to-end; callback and `await` forms; shares the jar; reported under `sideRequests`; own `--timeout` per call, capped at 10 per script |

### Two consequences worth naming

**`fetch` cannot be used.** Decision 9 (body on GET) rules it out — `fetch` and
`undici.request` both throw on a GET with a body. Combined with manual redirect control,
raw `Set-Cookie` lists and exact header casing, the implementation uses `node:http` /
`node:https` directly. No new dependency; more code (redirect loop, gzip/deflate/br via
`node:zlib`, socket deadline).

**The async sandbox weakens the timeout guarantee.** `vm`'s `timeout` option only bounds
*synchronous* execution, so it stops applying once a script awaits. Replaced by an outer
`Promise.race` deadline. Wrapping user code in an async IIFE also shifts stack line
numbers, so `runInContext` gets `lineOffset: -1`. Side benefit: a top-level `return` in a
script becomes legal, matching Postman.

### Two defaults chosen without asking

1. **Verbose redaction.** `-v` would otherwise print JWTs and session cookies. Values of
   `authorization`, `cookie`, `set-cookie` and `x-csrf-token` are shown as the first 8
   characters plus `…`.
2. **`pm.cookies` exists for gRPC runs** (always empty) rather than being absent, so a
   script shared between protocols does not throw.

---

## Phase 0 — Workspace discovery

`src/workspace/discover.ts`

- `Workspace.resourcesPath` → `string | undefined`.
- `findWorkspace()` walks up as today; a directory qualifies if it has
  `.postman/resources.yaml` (path set) **or** `postman/collections` (path `undefined`).
  Prefer the former when both exist, so the existing fixture is unaffected.
- `requireWorkspace()` details → `looked for .postman/resources.yaml or postman/collections`.

`src/workspace/resources.ts`

- `loadResources()` returns `{ workspaceId: undefined, specs: [], includeDirs: [] }` when
  `resourcesPath` is undefined or the file is absent, instead of throwing ENOENT.

`environments.ts` already tolerates missing directories.

## Phase 1 — Async script pipeline

`src/scripts/sandbox.ts`

- `runScript(): Promise<ScriptRunResult>`. User code wrapped as `(async () => {…})()`,
  executed with `runInContext(wrapped, ctx, { timeout, lineOffset: -1, filename })`, then
  raced against an outer deadline rejecting with
  `CliError('script "<event>" timed out after Nms')`.
- The `ASYNC_TEST_MESSAGE` guard is kept — async `pm.test` bodies still fail. Orthogonal
  to `sendRequest`.
- Add `setTimeout` / `clearTimeout` to the sandbox globals, bounded by the outer deadline.
- `ScriptRunResult` gains `sideRequests: SideRequestRecord[]`.

Callers: `runner.ts`'s `runScripts` awaits; every direct `runScript(...)` in
`test/sandbox.test.ts` gains `await`. This phase lands green before any HTTP code exists.

## Phase 2 — Schemas and the `src/http/` module

`src/workspace/schemas.ts`

- `httpRequestSchema`: `$kind: z.literal("http-request")`, `url: z.string()`, `method`
  defaulting to `"GET"`, `name` **optional** (52 of 53 real files omit it, so
  `readRequestHeader`'s filename fallback is authoritative), plus `headers`, `queryParams`,
  `body {type?, content?}`, `auth {type, credentials?}`, `settings`, `scripts`, `order`,
  `description`, `.passthrough()`.
- `headers` and `queryParams` are `z.union([record, array])`; normalisation and validation
  live in `src/http/` so failures read as `CliError` details rather than a zod dump.

| File | Responsibility |
| ---- | -------------- |
| `src/http/target.ts` | `resolveHttpUrl({ rawUrl, override, tlsOverride })`. Rejects empty and path-only URLs (`/api/v1/login` from an empty `admin_http_url`) with exit 1 and "set `admin_http_url` … or pass `--url <origin>`". Scheme-sniffs before prefixing `http://` so a leading `/` can never become a hostname. `--url` replaces protocol/host/port only; a path in `--url` is ignored with a warning |
| `src/http/headers.ts` | Normalise map-or-array → `Array<{key,value}>`, drop `disabled`, case-insensitive lookup helper |
| `src/http/query.ts` | Normalise map-or-array; `mergeQuery(url, params)` appends only keys `url.searchParams` lacks |
| `src/http/auth.ts` | `SUPPORTED_AUTH_TYPES`; applies bearer/basic/apikey (header or query per `credentials.in`); skips with a warning when an explicit `authorization` header exists; otherwise `CliError` listing the supported types |
| `src/http/cookies.ts` | `class CookieJar` — `storeFrom(url, setCookieHeaders)`, `headerFor(url)` (RFC 6265 §5.4 path-length ordering), `get`/`has`/`toObject`. `max-age<=0` or a past `Expires` deletes the `(name,domain,path)` entry, which is what makes the double `Set-Cookie` for `admin_csrf_token` correct rather than accidental |
| `src/http/invoke.ts` | `invokeHttp()` over `node:http`/`node:https`. Never rejects. Manual redirect loop (max 5, RFC 7231 method rewriting, jar fed on every hop, chain recorded), abort + socket deadline, gzip/deflate/br decoding, charset from `content-type`. `ok = 200..299`; unreachable → `statusCode: 0` |
| `src/http/request.ts` | `buildHttpRequest()` — interpolate → normalise → merge query → apply auth → default `content-type` → attach `Cookie` from the jar unless explicit. Validates the method against an `HTTP_METHODS` set |

## Phase 3 — Runner

`src/runner.ts`

- `export const HTTP_KIND = "http-request"`; `RUNNABLE_KINDS = new Set([GRPC_KIND, HTTP_KIND])`
  replaces the `kind !== GRPC_KIND` skip in `runGroup`.
- `parseRequest(entry)` → `{ protocol: "grpc", request } | { protocol: "http", request }`.
  Unknown kinds keep the existing error; details become
  `supported kinds: grpc-request, http-request`.
- `RunOutcome` = `GrpcRunOutcome | HttpRunOutcome` over
  `BaseRunOutcome { entry, protocol, warnings, consoleLines, tests, sideRequests, savedVars, savedTo, exitCode }`.
  `GrpcRunOutcome` keeps every current field name and type so existing render and JSON
  assertions survive.
- `runRequest` stays the public dispatcher; `runGrpcRequest` / `runHttpRequest` share the
  store setup, the `runScripts` helper and writeback.
- HTTP exit: `statusCode === 0` → `TRANSPORT`, `!ok` → `BUSINESS`, `failedTests > 0` →
  `TEST`, else `OK`.
- **Deliberate deviation from the gRPC branch:** HTTP `afterResponse` scripts run even on
  non-2xx, because there *is* a response to assert on
  (`pm.response.to.have.status(401)` must work). Skipped only when `statusCode === 0`.
- `RunOptions` gains `jar?: CookieJar`. `runGroup` creates one jar for the whole group,
  which is what makes `Login Dev` → `Refresh Token` work; a single `runRequest` creates a
  fresh one.

## Phase 4 — The `pm` surface

`src/scripts/sandbox.ts`

- `ScriptResponseInfo` splits into `GrpcScriptResponse | HttpScriptResponse`;
  `ScriptRequestInfo` gains `method`/`headers` and `methodPath` becomes optional.
- `makeResponse` dispatches on protocol. HTTP: `code`, `status` (reason phrase),
  `responseTime`, `responseSize`, `headers` (`HeaderList`), `text()`, `json()` (throws a
  Postman-like error on invalid JSON), plus the non-enumerable `to`. No `messages`, and
  `pm.message` is absent.
- `pm.cookies` = `{ get, has, toObject }` over the run's jar.
- `pm.sendRequest(req, cb?)` — accepts a URL string or
  `{ url, method, header|headers, body: {mode, raw}|string, auth }`; returns a promise and
  invokes the callback; reuses `invokeHttp` and the shared jar; `MAX_SIDE_REQUESTS = 10`
  then `CliError`; each call bounded by `--timeout`; network errors reach the callback or
  reject so the script decides.

`src/scripts/expect.ts`

- `Assertion.addMethod("header", (key, value?))` through the existing `assertHeader` helper.
- `.status(...)`: string comparison stops force-upper-casing for HTTP targets; error
  wording becomes "a gRPC or HTTP response".
- `.metadata()` / `.trailer()` against an HTTP target get a message saying HTTP responses
  have headers, not metadata.
- `ResponseLike.messages` becomes optional.

## Phase 5 — Output

`src/output/render.ts` switches on `outcome.protocol`.

- HTTP header line `<path>  →  <METHOD> <pathname>`, then
  `target <origin> [tls|plaintext] (<source>)`.
- `statusLabel` → `✓ 200 OK 123ms` / `✗ 401 Unauthorized`.
- Verbose adds request headers, sent body, response headers, the redirect chain,
  `Set-Cookie`s and `sideRequests`.
- Body printed via `colorizeJson` when JSON, raw text otherwise.
- `toJsonReport` adds `protocol` to both; gRPC keys unchanged; HTTP adds `method`, `url`,
  `finalUrl`, `statusCode`, `requestHeaders`, `responseHeaders`, `cookies`, `redirects`,
  `sideRequests`.
- `itemLabel` switches on protocol. `toGroupJsonReport`'s shape is unchanged.

`src/cli.ts` — help text only: `--url` gains the HTTP meaning, `--descriptor` is marked
gRPC-only, exit 2 becomes "transport failure (no response)", exit 3 becomes "gRPC
return_code not OK, or HTTP status not 2xx". No new flags.

`src/commands/run.ts` and `list.ts` need no changes. `README.md` is updated.

## Phase 6 — Fixtures and tests

Per `AGENTS.md` the `payment` collection stays at exactly 5 requests so no existing list or
group assertion moves.

- Convert `Legacy Http.request.yaml` into a runnable request against a new in-process
  `node:http` server (`startHttpServer()` in `test/helpers.ts`), pointed at `{{http_url}}`
  in `LOCAL.environment.yaml`. This also covers a mixed gRPC + HTTP group run for free.
- Add a second fixture workspace `test/fixtures/http-ws/` for the HTTP matrix (auth
  variants, cookies, queryParams shapes, redirects, gzip, `sendRequest`). It deliberately
  omits `.postman/`, which doubles as the Phase 0 discovery test.

Existing tests touched: `e2e.test.ts` "http unsupported" rewritten as a real run; the
"Legacy Http is skipped" comment; every `runScript` call in `sandbox.test.ts` gains
`await`. `groups.test.ts` and `workspace.test.ts` pass unchanged — `targetLabel` keeps
annotating `(http-request)`, which now signals protocol.

New `test/http.test.ts` covers header/query normalisation, cookie path matching and the
double-`Set-Cookie` case, auth application, and URL resolution.

New e2e cases: `givenHttpRequest_whenNon2xx_thenExitsBusiness`,
`givenUnreachableHost_whenRun_thenExitsTransport`,
`givenExplicitAuthorizationHeader_whenAuthBlockPresent_thenHeaderWinsWithWarning`,
`givenQueryParamsDuplicatingUrl_whenRun_thenParamSentOnce`,
`givenGetWithBody_whenRun_thenBodySentVerbatim`,
`givenSetCookieResponse_whenLaterRequestInGroup_thenCookieSent`,
`givenHttpOnlyCookie_whenScriptReadsPmCookies_thenValueVisible`,
`givenCookieDeletedAtLegacyPath_whenSetAtRealPath_thenRealValueKept`,
`givenRedirectLoop_whenRun_thenStopsAtMaxRedirects`,
`givenAfterResponseScript_whenNon2xx_thenScriptStillRuns`,
`givenPmSendRequest_whenScriptLogsIn_thenMainRequestInheritsCookie`,
`givenTooManySendRequests_whenScriptLoops_thenCliError`,
`givenEmptyBaseUrl_whenRun_thenActionableCliError`,
`givenUrlOverride_whenRun_thenOriginReplacedPathKept`,
`givenWorkspaceWithoutDotPostman_whenRun_thenDiscovered`,
`givenUnknownAuthType_whenRun_thenCliError`,
`givenGzippedResponse_whenRun_thenBodyDecoded`.

Every phase ends with `bun run typecheck` and `bun run test` both green.

---

## Deviations taken while implementing

**1. `ScriptRunResult.sideRequests` landed in Phase 4, not Phase 1.** Phase 1 only had to make
`runScript` async. Adding the field there would have shipped an always-empty array with no
producer, so it arrived with `pm.sendRequest`, which is the only thing that fills it.

**2. The shared `payment` fixture keeps an unsupported kind instead of a runnable HTTP
request, and there is no mixed gRPC + HTTP group run.** `--url` is protocol-agnostic and every
gRPC group test in `test/e2e.test.ts` passes `--url target()` (the in-process gRPC authority).
An `http-request` inside `payment` would therefore have its origin rewritten onto the gRPC
port, sending HTTP/1.1 into an http2-only server and stalling each group test on Node's
`unknownProtocolTimeout`. Inferring "this override is for gRPC only" from a bare `host:port` is
impossible, so `Legacy Http.request.yaml` became `$kind: websocket-request`
(`url: wss://example.invalid/socket`), which keeps the group `skipped` path covered and leaves
the collection at exactly five requests. All HTTP behaviour is covered instead by
`test/fixtures/http-ws/` — a workspace no test points `--url` at, where the runtime port is
injected with `--var http_url=<origin>`.

**3. `test/fixtures/http-ws/` requests use `pm.variables.get`, not `pm.environment.get`.**
`--var` writes to the *local* scope, so `pm.environment.get("http_url")` reads the empty value
from the environment file. `pm.variables` reads every scope and is the idiomatic Postman call.

---

## Known issue in the driving workspace, out of scope

`Authentication/Refresh Token.request.yaml` will still return 401 after all of the above.
The server reads the CSRF token from the JSON body field `csrf_token`
(`auth_controller.go:213`) and the refresh token from the `admin_refresh_token` cookie,
while the request file sends `{"refresh_token": "{{refresh_token}}"}` with an
`X-CSRF-Token` header. That is a one-line workspace edit, not a preman change.
