# 045: preman ships the google common protos

Status: Accepted

## Decision

The googleapis common protos are vendored into the repository at
`packages/core/vendor/google-protos/` and appended, last, to the include dirs every proto is
loaded with:

```
includeDirsFor(spec) = [ spec's own tree, the workspace pool, <bundled google root> ]
```

`bundledProtoRoot()` finds the tree relative to `import.meta.url`, which is the package root in a
source run and a sibling of the entry file in a bundle. A Vite plugin, `vendorProtos()`, copies it
beside `dist/preman.js` and `dist/engine/entry.js`.

Three rules bound it:

- **Last, never first.** A repository that ships its own `google/api/annotations.proto` keeps
  answering for it, because the version it compiles against is the one its generated code expects.
  Last place also makes this inert for every workspace that already loads: it is reached only after
  each real include dir has failed.
- **`google/protobuf/*` is excluded, and the exclusion is asserted.** protobufjs answers those from
  its own bundled `common` map before `resolvePath` is called at all, and `@grpc/proto-loader`
  registers four more on top. A copy in the vendored tree would be unreachable weight.
- **It is not in `Resources.includeDirs`.** That list describes the workspace and is printed by
  `preman protos`; this root belongs to preman and is identical everywhere.

The set is the import closure of what `proto-google-common-protos` publishes — 59 files, fetched
verbatim from googleapis, Apache-2.0, with the LICENSE and NOTICE travelling with them.

## Rationale

**The include dirs are ancestors, and no ancestor of a service's proto is ever a `google/` root.**
A spec that says `import "google/api/annotations.proto"` needs that path under some include dir.
ADRs 038 and 042 settled what those dirs are: the spec's own directory and its ancestors, stopped
at the workspace, the checkout or the shared link. That walk climbs, so it can reach a repository's
own tree and never a sibling one. The failure is not a diagnostic: `@grpc/proto-loader` warns to
`process` and then falls back to resolving relative to the importer, so the workspace that drove
this record reported `ENOENT … /zas-spec/api/zas/google/api/annotations.proto` — a path assembled
from the importer's directory and the import string, which was never going to exist.

**The copies already on the machine are build output, not an input.** Maven writes the same set
into `<repo>/target/protoc-dependencies/<md5>/google/`. That directory is gitignored, named after a
hash of the dependency set, and absent until the service has been built once. Pointing include dirs
at it would make whether a request runs depend on whether someone had run `mvn` — and on a hash
nothing in preman can compute.

**The alternatives were cheaper and each left a hole.** protobufjs ships a `google/` directory in
its own package, which needs no vendoring at all; it holds `api/annotations.proto` and
`api/http.proto` and nothing else, so the 23 workspace imports of `google/api/httpbody.proto` and
the 5 of `google/rpc/code.proto` would still fail, and reaching into a transitive dependency's
internal layout to fix half a problem is a worse dependency than a file. Registering the protos
through `protobuf.common()` was tried and does not work: `Root#load` checks that map against the
_already-resolved_ absolute path, so only the `google/protobuf/` prefix ever reaches it, and making
it reach further means monkey-patching `resolvePath`. A user-configured extra include dir was the
honest alternative and was rejected on the same ground ADR 038 rejected per-machine spec paths:
every user of every workspace would perform the same setup to make the same imports resolve.

**Closed rather than curated, because the next import is not predictable.** Vendoring only the six
files in use today reopens this the moment something imports `google/type/money.proto`. The set is
therefore closed under `import`: fetch the published list, then fetch whatever it imports, until
nothing is missing. Re-vendoring is the same loop.

## Consequences

**`google/api/service.proto` is vendored and does not load.** It imports both
`google/protobuf/api.proto` and `google/protobuf/type.proto`, whose bundled copies both declare
`Option`, so protobufjs throws `duplicate name 'Option' in Namespace .google.protobuf`. This
reproduces with no vendored file present, so it is upstream's and not ours; it is kept because
dropping it would move the failure from that file to whichever file imports it. Nothing in any
observed workspace imports it.

**A repo that vendors an old `google/api` gets its old one, silently.** That is the intended
reading of "last, never first" and it is also the trap: two workspaces on one machine can resolve
the same import to different files, and neither says so. The listing does not mention the bundled
root, so the fallback is invisible when it fires. The counter-argument — print it — was rejected
because it would add a row to every `preman protos` listing to describe a directory the reader
cannot change.

**59 files, and a re-fetch is a diff.** The directory is in `.prettierignore`, so the copies stay
byte-for-byte upstream and a re-vendor reads as a change rather than a reflow. Apache-2.0 asks that
the LICENSE and NOTICE travel with the copies, so `vendorProtos()` emits every file in the tree and
not only the `.proto`s.

**Three builds now emit an asset, and one of them need not.** `packages/core/dist/core.js` is a
build-proof that is never executed; it carries the plugin anyway, because a bundle of core that
cannot find its own protos would compile and still be wrong. A build that drops the plugin does not
crash — `bundledProtoRoot()` returns `undefined` and the include dirs are what they were before
this record.
