# 038: A proto is declared through a shared link

Status: Accepted

## Decision

A `.proto` is added to a workspace from a file dialog, and the path written to
`localResources.specs` always runs through a symlink farm at `/Users/Shared/postman-protos`:

```yaml
localResources:
  specs:
    - /Users/Shared/postman-protos/zas-spec/api/zas/admin/admin.proto
```

The link is named after the repository the file was found in — nearest ancestor holding `.git` —
and points at that checkout's **root**. One link per repository, however many of its protos are
declared. Adding a proto that is already reachable through an existing link creates nothing.

Every workspace gets the same treatment, including one that lives inside the repository whose protos
it declares. There is no in-workspace-so-leave-it-relative case.

`packages/core/src/api/specs.ts` is the seam: `describeSpecs`, `collectProtoFiles`, `planSpecs`,
`planSpecConversion`, `applySpecPlan`, `removeSpec`, `linkCheckout`. Nothing is written until a plan
is applied, and a plan carries what it would link, what it would declare, and — before any link
exists — whether each proto actually loads. The app is a `Protos` pane; the terminal is
`preman protos` and `preman protos link <name> <dir>`.

`deriveIncludeDirs` gained a second stopping boundary: a spec under the shared root climbs to its
link and stops there, rather than stopping at its own directory the moment it leaves the workspace.

The machine may move where it resolves the root, through a preference and
`PREMAN_SHARED_PROTO_ROOT`. It may not move what is written: the declared path always carries the
canonical `/Users/Shared/postman-protos` prefix.

## Rationale

**The workspace could not declare a proto at all, and the file that had to be hand-edited is the one
nobody reads.** The method picker has always read `localResources.specs` and written
`schema.location` for you. Getting a `.proto` _into_ that list was a text editor and a relative path
counted by hand. So the honest description of the gap is not "there is no file browser" — it is that
the one file which decides whether any gRPC request in the workspace can resolve a method was the
only one the app would not touch.

**A path to another checkout is a path to _this machine's_ checkout, and the driving workspace proves
it.** `preman-ws` declares 32 specs by absolute path. Thirteen of them are under `/Users/phuctt4/`,
a home directory that does not exist on the machine that opened it. That workspace is committed and
shared, and it is correct on exactly one laptop. Every alternative to a shared root reproduces this:
an absolute path names a person's disk, and a relative path out of the workspace (`../../../zas-spec`)
names their directory layout instead. The shared root is the only spelling that is the same string on
every machine and still resolves to wherever each person keeps their code — which is what makes the
one-per-repository link the whole setup cost, and makes it a cost the app can then walk you through.

**The link points at the repository root because that is what reproduces the include roots the protos
already have.** A narrower target has to guess, and real repositories disagree about what to guess:
`acquiring-core` roots its imports at `api/proto`, `refund-core` at `api`, and
`pkg/client/pe/asset-exchange-v2.proto` imports a sibling and needs neither. Linking the checkout
means the ancestor climb inside the link is the same climb it would perform inside the checkout, so
the include dirs a spec gets through the link are _identical_ to the ones it gets without one. That
equality is not just tidiness — it is what lets `planSpecs` load-check a proto against the include
dirs it will end up with, before the link that would give it them exists.

**`deriveIncludeDirs` was broken for every spec outside the workspace, and the shared root would have
made that universal.** The climb stopped at `dir === root || relative(root, dir).startsWith("..")`,
which for a spec outside the root is the first iteration — so it contributed its own directory and
nothing else. `zas-spec/api/zas/admin/admin.proto` imports `"zas/common.proto"` and has therefore
never loaded in `preman-ws`; it sits in the warnings list, and the app said nothing about why. The
existing repository-local workspaces only work because their specs are _inside_ the root, where the
climb reaches `api/` and the repo root. Move those onto a shared link without touching this function
and all 35 of `acquiring-core`'s specs drop to own-directory-only. So the boundary change is not an
improvement bundled in beside the feature; it is the half of the feature that makes the other half
not a regression. It also fixes the `zas-spec` case, which was there before any of this.

**Widening the climb exposed a second bug, and a spec now resolves against its own tree first.**
Include dirs were pooled: one list built from every declared spec, and every spec loaded against all
of it. proto-loader takes the first include dir that answers, so with a wide enough pool one
repository's proto answers another's import. `bank-wrapper.proto` does a bare `import "common.proto"`
and takes `Ping` from its sibling; converted, it got some other checkout's `common.proto` and failed
with `no such type: Ping`, losing nine methods. The comment on `deriveIncludeDirs` had claimed
over-inclusion was harmless, which is what let this sit. `Resources` now exposes `includeDirsFor(spec)`
— the spec's own climb ahead of the pooled list — and the pool stays behind it so a workspace that
genuinely declares a proto importing from a separately-declared repository still resolves. Measured
on `preman-ws`: pooled loaded 14 of 32 specs, own-first 15; end to end the conversion goes from 55
methods and 21 warnings to 74 and 17, losing none. Pooling was survivable only while the pool was one
directory per spec, so this is the boundary change's bill, not an unrelated find.

**The boundary is passed in, not inferred from the filesystem, and inferring it was tried first.**
The first implementation stopped the climb at the nearest ancestor that is a symlink, which needs no
argument and no knowledge of `/Users/Shared` anywhere in core. It is wrong on macOS: `/var` is itself
a symlink, so a spec in a temp directory climbed to `/`. Symlinked home directories and `/tmp` are
the same hazard. A boundary that a filesystem detail can move is not a boundary, so core owns
`DEFAULT_SHARED_PROTO_ROOT` and takes the resolved root as a parameter. Core owning the constant also
means the CLI and the window cannot disagree about it, which a front-end-supplied path would have
allowed.

**Uniform beats correct-per-case here, and the cost is real.** The alternative — shared link when the
proto is outside the workspace, plain relative path when it is inside — is strictly better for
`refund-core`, whose 24 relative specs work today on a fresh clone with no setup at all. It was
proposed and rejected in favour of one rule. What it buys is that "where does a declared proto live"
has one answer, in the pane, in the CLI output, and in the file; what it costs is that a
repository-local workspace stops being self-contained, and a teammate cloning `refund-core` must
create one link before its protos resolve. That is a genuine regression for that workspace and it is
accepted knowingly. The mitigation is the thing that makes it bearable: the link is _named after the
repository they just cloned_, and both front ends say so by name.

**Which is why the repair path is half the feature and not a follow-up.** A design that makes every
spec depend on machine-local state is only defensible if the machine missing that state is told
exactly what to do. So `SpecsView` carries `unresolvedLinks`, both front ends group the specs by the
link that reaches them rather than listing them flat, and the pane offers `Locate <name>…` against a
directory picker. Thirty failing specs is not thirty problems; it is three links, and the display
that says "thirty" is the one that makes people give up. `preman protos` prints a copy-pasteable
`preman protos link <name> <path>` per missing link, and `protos link` deliberately does not require
a workspace, because the machine that needs to run it is usually one where nothing loads yet.

**This reverses a rejection in 033, and only part of one.** Decision 033 built symlink-rewriting for
the migrator, measured it — 28 requests resolving from a live `.proto` became 82, with ten
repositories linked — and rejected it anyway, on the grounds that a migrated file should say what
Postman said, and that a rewritten `schema.location` pointing through a link farm under `.postman/`
turns a faithful copy of a cloud workspace into a machine-local derivative of it. That argument is
untouched and still holds. Migration still writes Postman's paths verbatim. What changed is who is
asking: this is a person choosing a file and confirming a reviewed plan, in a pane that names the
link it is about to create, not a migrator silently rewriting 188 requests nobody has looked at yet.
033 also left the consequence in plain sight — "a workspace migrated on one machine needs its
absolute paths adjusted on another" — and named `deriveIncludeDirs` stopping at the workspace root as
the reason most of the existing files still failed. This record is the tool for that adjustment.

**Nothing is written before it is reviewed, and a conflict is never resolved by guessing.** A link
name is a repository name, so two checkouts of the same repository collide, and the existing link is
load-bearing for every _other_ workspace that names it — including ones not open. `writeSharedLink`
therefore refuses to repoint unless asked, naming both targets; the pane offers `Use <name>-2` or
`Repoint` and disables Apply until one is picked; the CLI needs `--repoint`. The single exception is
the `Locate…`/`Repoint…` button in the pane's own links section, which repoints without asking again,
because the target it would replace is on screen in the same row.

**Removing a spec never removes a link.** The link is machine-wide and shared across workspaces;
deleting it because one workspace stopped naming it breaks another one, later, somewhere else.

**The override moves where the machine looks and never what the workspace records.** A locked-down
laptop may have no writable `/Users/Shared`, so `PREMAN_SHARED_PROTO_ROOT` and a preference beside it
exist. If that value were written into `resources.yaml`, the override would destroy the portability
the shared root exists for — so `resolveSharedPath` swaps the canonical prefix for the local one on
the way in, and `declaredSharedPath` writes the canonical one on the way out. The preference lives in
the global `Preferences` bag per 022 rather than in the workspace, for the same reason.

**The method picker writes the canonical path too, and a relative one would have been a slow leak.**
The picker holds a resolved spec path and has to put a `schema.location` in a request. It used to
write the path relative to the request's own directory, which was right while every proto lived
inside the workspace. Against a linked proto that arithmetic counts `../` segments off how deep this
particular checkout happens to sit — so the same choice, made by two people who cloned to different
directories, writes two different files, and the request only resolves for whoever picked it. That is
precisely the machine dependence the shared root removes, reintroduced one request at a time and
invisibly, because the path it produces is not wrong on the machine that produced it. `listMethods`
now asks `canonicalSharedPath` first and falls back to the relative path only for a proto that is not
on a link; `resolveMethod` runs a location through `resolveSharedPath` so an overridden root reads it
back. The two functions are inverses, and `test/workspace.test.ts` asserts the round trip: if they
ever stop being inverses a workspace declares one file and opens another.

## Consequences

**A repository-local workspace is no longer self-contained, and that is the price of the rule.** A
fresh clone of `refund-core` resolves its 24 existing relative specs and would not resolve a
twenty-fifth added through this feature until `refund-core` is linked. The two spellings coexist in
one file until someone runs the conversion, which is the mixed state the uniform rule was chosen to
avoid and does not, by itself, prevent. `planSpecConversion` exists so that the file can be made
uniform in one reviewed step; it is offered and never automatic, because it rewrites a committed
file.

**Every engine host restarts when the shared root preference moves.** A host reads the root from its
environment at fork, so `savePreferences` calls `closeAll()` and the settings pane re-opens the
current workspace. Changing the field is therefore not free, which is why it commits on blur rather
than per keystroke — a half-typed path would re-open every workspace against nowhere.

**`ProtoCache` is dropped on every spec or link write.** It keys by path and mtime, and neither moves
when a symlink is repointed underneath it, so the cache cannot notice on its own. The engine host
splits `readSpecs` from `writeSpecs` for exactly this: a plan is a read and keeps the cache, an apply
throws it away.

**The load check runs against a `.proto` the user is looking at, and can still be wrong later.**
`planSpecs` loads each staged file with `deriveIncludeDirs` over the checkout, which is the same set
it will have through the link — but a proto that imports across repositories will pass the check and
fail once the other repository is not linked. It reports as a load warning at that point, in the same
list, which is where such a thing belongs.

**`/Users/Shared` is macOS-shaped, and the app is macOS-shipped.** The constant is a path with a
platform baked into it, in a package whose CI runs on Linux. Only the tests exercise it there, and
they set the environment override; nothing in core requires the default to exist. A Windows or Linux
build would need a second default, and the mechanism — the override, the canonical-write rule, the
climb boundary — would not have to change to get one.

**The pane's derivations live in `renderer/model/protos.ts`, not in the pane.** `test/renderer/` has
no `.tsx` in it and does not render panes, so the list of links a workspace needs — which the engine
never sends, and which has to be derived from the spec rows — is a pure function with thirteen tests
around it. `linkStates` deliberately derives from `view.specs` rather than `view.links`: the shared
root is machine-wide, and listing what is in it would show a person every repository they have ever
linked from any workspace.
