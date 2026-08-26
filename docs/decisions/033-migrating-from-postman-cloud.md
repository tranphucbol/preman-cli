# 033: Migration reads Postman's own private API, with Postman's own token

Status: Accepted

## Decision

`preman migrate` copies a Postman **cloud** workspace onto disk in the filesystem format the rest of
preman already reads. It does so by calling the RPC proxy Postman Desktop itself calls —
`POST https://bifrost-https-v4.gw.postman.com/ws/proxy`, body `{service, method, path}` — and it
authenticates by borrowing that window's own `x-access-token`, harvested over the Chrome DevTools
Protocol from the running app. There is no API key, no login, and no stored credential.

`packages/core/src/postman/` is four layers with one direction of dependency:

- `session.ts` reads `<appData>/Postman/DevToolsActivePort`, attaches to the `desktop.postman.com`
  page, and reads `access_token` out of its `localStorage` over CDP's `DOMStorage` domain. The team
  id comes free from the `teamId` query parameter already in that page's URL.
- `proxy.ts` turns a `PostmanSession` into a `ProxyClient` — `(call: ProxyCall) => Promise<unknown>`.
- `fetch.ts` walks the workspace with that client and returns a `PostmanWorkspaceSource`, which holds
  every detail Postman gave it as raw `unknown`.
- `convert.ts` is pure: `planWorkspace(source) => FilePlan`, a list of `{relativePath, contents}`
  strings plus the counts and the skipped items. `write.ts` is the only part that touches disk.

`api/migrate.ts` is the seam both front ends call: `listCloudWorkspaces` and
`migrateCloudWorkspace`. The CLI is `preman migrate --list | --workspace <id|name> --out <dir>
[--dry-run]`; the app is `File ▸ Migrate from Postman…` and a palette command, which asks Electron
for the destination and then opens what was written.

The destination must be empty. A workspace already on disk is never merged into.

## Rationale

**The public API cannot see gRPC, so it was never a candidate.** Postman's documented v9 API returns
collections in schema v2.1, and every gRPC request in a cloud workspace lives under
`dependencies.extensibleCollections` — a shape v2.1 has no representation for and the public endpoint
does not return. A migration built on the documented API would silently drop exactly the requests
that are preman's reason to exist: the free Postman CLI refuses gRPC collection runs, which is the
first paragraph of the README. Half a migration that omits the gRPC is not a smaller feature, it is
the wrong one.

**Borrowing the desktop token was chosen over asking for an API key, and it is the weakest part of
this record.** An API key would be documented, stable and stored — and would reach only the API that
cannot see gRPC. The internal proxy accepts the desktop session token and nothing else we can obtain,
so the choice was between an undocumented transport and no gRPC. What the harvest costs is honest and
should be read as the price: it depends on Postman Desktop running with remote debugging reachable
(`DevToolsActivePort` present in its app data), on a page whose URL contains `desktop.postman.com`,
and on `access_token` being in that page's `localStorage`. Any of those can change in a Postman
release, without notice, and the feature breaks. It breaks loudly — `EXIT.CLI` with "Postman Desktop
does not appear to be running" and an instruction to open and sign in — which is the mitigation, not
a fix.

**The token is read out of the page, not off the wire, and the first attempt at the second was
wrong.** This originally watched `Network.requestWillBeSent` for the first `x-access-token` header,
which reads better than a storage lookup: it takes only what Postman itself was already sending.
Against a real Postman 12.25.1 it never returns. An idle window sends nothing but New Relic
telemetry, so the harvest sat for its whole timeout and failed on a signed-in app with a valid
session — a feature that works only while the user happens to be clicking is not a feature.
`DOMStorage.getDOMStorageItems` is the narrowest replacement: a read-only CDP domain, one key, no
script executed in Postman's page — which `Runtime.evaluate` would have been, and which is a
different and much larger thing to be doing inside somebody else's application.

The alternative still rejected outright is reading the credential out of Postman's files on disk.
Reading a running window's `localStorage` and reading its at-rest storage are not the same act: the
first requires the app running with debugging reachable and a signed-in session in front of the
person who typed the command, and stops working the moment they quit. The second is a durable
dependency on another vendor's on-disk format that works whether or not a human is present.

**One migration, one token.** `MigrateArgs.workspace` takes an id **or** a name, a deliberate
deviation from the plan's `workspaceId`, so that resolving "Work" to a uuid happens inside core on the
session it already holds rather than forcing the caller to list first and migrate second with two
harvests. Two workspaces named "Work" is the normal case, not the corner one — a team workspace and a
personal one — so the resolution is ambiguity-as-error, per the repository's rule: zero matches lists
the available names, more than one lists the candidate ids, and neither guesses.

**The converter is pure because that is the only part worth testing exhaustively.** `planWorkspace`
takes fixtures and returns strings, so eleven tests cover collision suffixing, ordering, key
stripping and every `$kind`, with no network and no temp directory. The transport is then testable
against an in-process `/ws/proxy` that serves the same fixtures and records what was asked. The split
also means the piece most likely to break — the transport, for reasons outside this repository — is
the piece with the least logic in it.

**Details stay `unknown` until the converter validates them.** `fetch.ts` deliberately does not model
a Postman request; it hands the raw object to `convert.ts`, which parses it with `grpcRequestSchema`
and `httpRequestSchema` — the very schemas the runner will read the written file back through. A
migration that writes a file the runner cannot load is the failure mode worth designing against, and
validating against the runner's own schema at write time is the only check that actually rules it out.
Envelope unwrapping (`{data:…}`, `{collection:…}`) is a function rather than a zod union, because a
union cannot narrow through a `.passthrough()` index signature.

**The walk is one read per node, and it costs 822 reads on the driving workspace.** Postman's v3
model gives a parent only `{id, $kind}` for each child — no name, at any depth — so a tree cannot be
labelled without reading every node. There is an endpoint that looks like the answer,
`/v3/collections/{id}/items/`, and it was built on first: it names the top two levels and returns
bare stubs below them, so it would have had to be supplemented by exactly this walk anyway. It is no
longer called. Each read must also declare what it is reading, in an `x-entity-type` header equal to
the item's own `$kind`; the wrong value is a 404 for an id that exists and no value at all is a 400.
Postman's model has no folders — a nested group is itself a `collection`, and `folder` is not even an
accepted entity type — so `fetch.ts` sends `collection` and reports `folder`, because "41
collections, 93 folders" is what a person recognises.

**The concurrency ceiling is a semaphore around the client, not a bounded `map` in the walk.** The
first version bounded each level to eight, which multiplies: a recursive bounded map fans out to the
product of its depth, and this tree nests four deep, so a workspace with 93 nested groups could have
had hundreds of sockets open against an undocumented proxy — the exact thing the bound existed to
prevent. `gated()` wraps the `ProxyClient` once in `fetchCloudWorkspace`, which leaves the walk free
to say `Promise.all` and mean it.

**Progress is counted in collections, because that is the only denominator that never moves.** A
migration cannot know its own size: the walk above learns a node's children from that node's own
detail, so at read 412 of 822 the 822 does not exist yet. A bar driven by calls-discovered-so-far
would slide backwards every time a folder opened, which is the one thing a progress indicator must
never do. What the first reply settles, and settles permanently, is the number of collections and the
number of environments — each collection is an independent subtree that resolves as a unit — so
`12 of 41` is true, monotonic and never revised. It is also coarse, one collection being possibly a
hundred requests, so a raw count of completed reads rides beside it; that number has no ceiling and
is never drawn as a proportion. `MigrateArgs.onProgress` is a plain callback rather than the
`RunEventSink` shape beside it, because that interface exists to own a `runId` so two concurrent runs
cannot interleave, and there is only ever one migration.

**Core reports about a hundred times, so neither front end throttles.** Every phase change, every
collection, and every twenty-fifth read — around a hundred reports over forty seconds, rather than
the 822 a report-per-read would be. The rate is decided once, where the walk is, instead of by a
coalescer in the terminal and a different one in the window: two throttles is two places for the
last report to be the one dropped, and the last report is the one that says it finished.

**A skipped request is named, not counted.** Websockets, socket.io and GraphQL-over-WS have no
runner, so they are not written — and every one of them appears in the report by its path
(`Adapter/Legacy/Legacy Socket`) rather than as "1 skipped". The number tells you nothing; the path
tells you what to keep in Postman.

**The empty-destination rule is a refusal and not a merge.** Merging means deciding what to do with a
request that exists in both places, and there is no answer to that which is not either data loss or a
three-way diff. `applyPlan` throws synchronously before it writes anything, tolerating only
`.DS_Store`, `Thumbs.db` and `.localized`, so a `--out` pointed at a directory Finder has looked at
still works.

**The window loads the migration lazily, and that was measured.** A static
`import { migrateCloudWorkspace } from "@preman/core/api/migrate.js"` in `main/main.ts` takes
`dist/main/main.js` from 31.35 kB to 409.89 kB — zod is most of it. `await import(...)` returns it to
32.90 kB and puts the subtree in a 141 kB chunk nothing static reaches. This is decision 029's
argument applied to the other process: main boots before it knows whether anyone will migrate, and a
one-off command should not be in the boot path.

## Consequences

**This feature will break, and the failure is a Postman release note nobody sends.** Three things can
break it independently: the CDP surface (a Postman build without a reachable `DevToolsActivePort`, or
an Electron version that changes it), the page URL, and the proxy's own paths. `proxy.ts` carries
advice for `invalidServiceError`, `invalidPathError` and `instanceNotFoundError` for exactly that
reason. Anyone debugging it should start at `session.ts` and confirm a token is obtained at all, since
a transport error and an authentication error look nothing alike and only one of them is ours.

**The descriptor Postman's cloud returns is usually truncated, so the `.proto` path is the part that
matters.** The plan for this feature assumed gRPC would arrive descriptor-only: a base64
`methodDescriptor`, 11 kB on one YAML line, which is why every file is serialised with
`lineWidth: 0`. Measured against a real workspace, that assumption is wrong. Of 188 gRPC requests,
**184 came back with a `methodDescriptor` of exactly 300 characters, and not one of those 184
decodes** — the outer length prefix declares 1681 bytes and 222 follow. The four that were not 300
characters long (196, 388, 2188, 4236) all decode. There is no knob to ask for more: every query
variant on the item path (`?populate=true`, `?fields=`, `?full=true`) is refused by the proxy's
allowlist, and the `sync` service does not serve items at all. So 98% of migrated gRPC requests
cannot run on their descriptor, and the only thing that makes them run is the `.proto`.

Which Postman does record, and which the first version of this migration threw away.
`schema: {source: "file", location: "<absolute path>"}` is on 125 of those 188 requests; the other 63
say `{source: "api", apiId, versionId}`, which addresses Postman's servers and has no local
counterpart. The file-sourced ones are kept — reduced to `source` and `location`, the path left
absolute exactly as Postman recorded it — and every distinct location is also written to
`localResources.specs`, because `deriveIncludeDirs` reads its import roots from `specs` alone and a
`schema.location` without one finds the file and then fails to resolve its imports. `resolveMethod`
already prefers a `.proto` over a descriptor, so nothing in the runner changed. The `api`-sourced
pointer is dropped: keeping it would promise a file that is not there.

This is not a descriptor being regenerated, so 006 is untouched: the truncated value is still carried
verbatim, and what was added is the path Postman was already holding. It is the authoring machine's
path, and it stays that way — of 32 distinct locations in the measured workspace, 17 exist on the
machine that ran the migration, and 28 of the 188 requests resolve from a live `.proto` as a result.
`grpc/schema.ts` names the `.proto` it looked for when a descriptor fails to decode, because "index
out of range: 225 + 10 > 225" on its own tells nobody to go and fetch a file.

**Rewriting those paths to point inside the workspace was built, measured, and rejected.** Most of
the 17 files that do exist still fail on their first `import "pkg/other.proto"`: `deriveIncludeDirs`
climbs a spec's ancestors and stops the moment it leaves the workspace root, which for a spec outside
the root is immediately, so the spec's own directory is the only include root it contributes and a
repository that imports by path from its proto root never resolves. Symlinking each checkout to
`.postman/protos/<repo>` and rewriting `schema.location` through the link fixes exactly that — the
unchanged climb then walks the linked tree — and it was implemented and measured: **28 requests
resolving from a live `.proto` became 82**, with ten repositories linked.

It was still rejected, deliberately. The migrated file should say what Postman said. A rewritten
`schema.location` is a path the user never wrote, pointing through a symlink to a checkout on one
machine, in a file whose whole purpose is to be committed and read by someone else; the workspace
stops being a faithful copy of the cloud and starts being a machine-local derivative of it. The cost
is known and accepted: a `.proto` whose imports are rooted above its own directory needs that root
added to `localResources.specs` by hand, and a workspace migrated on one machine needs its absolute
paths adjusted on another. That is a visible, editable line in a YAML file, which a link farm under
`.postman/` is not.

**The written workspace is not byte-identical to what Postman Local View would have produced.**
Collection `variables`, which core does not read, are written through; identity keys (`id`,
`parentId`, `owner`, `revision`, timestamps, `__objectPoolBusterKey`) are stripped, because a uuid
from someone else's cloud in a checked-in file is noise that will outlive its meaning.
`.postman/resources.yaml` gets the workspace id, and the `specs` list when
anything points at a `.proto`. A name Postman allows and a
filesystem does not is resolved with Postman's own ` (2)` convention, and the display `name` inside
the file keeps the original spelling — so two requests called `Login` become two files and one name
each, and the sidebar reads the way Postman did.

**It widened the request format: `auth.credentials` is a list as well as a map.** Postman's model
stores credentials as `[{key: "token", value: …}]`, and that is the only shape a cloud workspace
holds, so every migrated request carries it — while `workspace/schemas.ts` accepted a map alone and
`auth/credentials.ts` looked up by key. Migration is what surfaced it, but the bug is older and wider
than migration: any workspace whose files came out of Postman rather than out of a text editor would
have opened, displayed and edited fine and then sent unauthenticated. Both shapes are now read, which
is the same argument headers and metadata already carried a comment about.

**And it put a length limit on filenames, which is a filesystem's rule and not Postman's.** A cloud
workspace holds requests named after a URL with its query string, and 255 bytes is the per-component
limit on APFS, ext4 and NTFS alike — bytes, so a Vietnamese name reaches it in two thirds of the
characters. `sanitiseSegment` now truncates on a character boundary, reserving room for the longest
suffix preman writes, a ` (100)` collision marker, and `writeFileAtomic`'s `.preman-tmp` — which is
why `paths.ts` imports that constant, and which is what the first real migration actually failed on,
having already truncated the name. Truncation rather than refusal follows the function's existing
contract: the segment was always lossy and the `name` inside the file was always the authoritative
one. Two names that truncate to the same prefix are told apart by the collision suffix.

**Every one of the corrections above came from running it, not from reading it.** The fixtures this
was built against were hand-shaped from a description of the API, and they were wrong in five
separate ways — the wrong service for `/workspaces`, an unpopulated `?populate=true`, a missing
`x-entity-type`, a second error vocabulary keyed `code` instead of `name`, and a token harvest that
could not fire. The suite was green for all five. `test/support/postman-cloud.ts` now refuses a call
whose service or entity type does not match what the real proxy binds, because a fake that answers
anything is a fake that certifies anything.

**There is now a second reason for `resolveCollisionWith`.** `workspace/paths.ts` grew a
predicate-taking form of `resolveCollision`, because the converter resolves collisions against files
it has planned and not yet written; the `existsSync` form is a two-line wrapper over it. That is the
first place in the repository where a naming rule is applied to a plan rather than to a directory.

**The workspace list carries no counts, and it was going to.** A row reading "41 collections, 225
gRPC requests" is the useful version, and Postman's `/workspaces` does not carry it: getting it means
a `/workspace/{id}?populate=true` per row, forty round trips to decorate a list someone is about to
pick one item from. The list shows a name and an id, and the counts appear in the report afterwards.

**The desktop dialog is not in `stores/overlay.ts`.** Every overlay there is dismissed when an engine
port arrives, and a successful migration's own port arrives while its report is still on screen — the
report would close itself at the moment it had something to say. `MigratePane` therefore holds its own
`open` state in `App.tsx`, which is a duplication of the overlay pattern accepted on purpose.

**It made the main process the second one to externalise `yaml`, for a reason no bundle size shows.**
Main had never touched YAML before this, so `SHELL_EXTERNALS` inlined it — and `yaml` ships a CJS
`dist/` whose logger, composer and parser each `require("process")`. Rolldown turns that into its
`__require` shim, which in an ESM Electron main process throws "Calling `require` for \"process\" in
an environment that doesn't expose the `require` function" on the first click of **Migrate from
Postman…**. It is a runtime failure that every static check in this repository passes: typecheck,
lint, and the whole suite are green, and `bun run build` reports a healthy 376 kB chunk. Externalising
it fixes it and takes the chunk to 141 kB as a side effect. ADR 029 already named this hole — a
bundle check has to read `dist/` and nothing does — and this is the first time it cost something. The
next module main reaches for is the next chance to find it by clicking.

**The progress bar is the app's first, and it cost a rule that had never been checked.**
`ui/Progress.tsx` is drawn in `MigratePane` and nowhere else — a collection run states `12 of 41` as
text in `RunnerPane`'s summary, where the run list beside it already is the progress and `--bail`
would park a bar at 30% with no way to say why. Two things came out of writing it. The indeterminate
half reuses `.inflight-bar`, the sweep the response pane already draws, with its thickness lifted
into `--inflight-thickness` rather than copied at another height; `app.css` has two keyframe
animations and that is the number it should have. And the determinate fill was first written as an
animated `width`, which `docs/design-system.md` has ruled out for as long as it has existed, on the
grounds that decision 17's budgets are blocking-time medians and a width tween is layout every frame.
Nothing caught it, because the rule was prose. It is now `scaleX` from `origin-left`, and
`test/renderer/motion.test.ts` scans every renderer source for a transition naming `width`, `top`,
`left` or `all`. A documented rule that nothing asserts is a rule the next person breaks, and this
time the next person was the one who had just read it.

**Progress crosses to the renderer on a push channel, not on the `invoke` that started it.** That
promise settles once, at the end, and a migration is a hundred reports over the better part of a
minute; `CHANNELS.migrateProgress` mirrors `onMigrate` exactly. A report arriving outside the working
stage is dropped rather than stored, because the only migration that can have sent one is the one
whose report — or whose failure — the user is already reading.

**No test covers the token harvest against a real Postman.** Both of its failure paths are tested
against a fixture app-data directory; the success path is not, because it requires a signed-in desktop
app. That is an untested code path in shipped software, and the reason it is acceptable is that its
failure is total and immediate rather than subtle — it either returns a token or it raises with
instructions.
