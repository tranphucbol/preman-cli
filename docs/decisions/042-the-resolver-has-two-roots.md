# 042: The resolver has two roots, and the writer has one

Status: Accepted

## Decision

A spec declared through a shared link whose name equals the workspace's own checkout is read out
of that checkout when the link does not produce the file:

```yaml
localResources:
  specs:
    - /Users/Shared/postman-protos/refund-core/api/acquiring_refund/v1/refund.proto
```

Opened from a clone of `refund-core` on a machine with no links at all, that declaration reads
`<clone>/api/acquiring_refund/v1/refund.proto`. The workspace was found by walking up to
`.postman/`, `repoRootFor` climbs from there to `.git`, and `linkNameForRepo` takes the basename —
which is the name of the link that is missing. The directory the person was being asked to locate
is the directory the engine is standing in.

Four rules make that safe:

- **The checkout is tried first, and only wins when the file is there.** A repo-local workspace
  then resolves identically on every machine regardless of what the shared root holds; a spec
  absent from this checkout, or one that genuinely lives in another repository, falls through to
  the link unchanged.
- **The match is exact.** `linkNameForRepo(repoRootFor(ws.root))` and nothing else. A clone in a
  directory called `refund-core-fix`, or a link called `refund-core-clients`, does not fire it.
- **Nothing is written.** No symlink, no preference, no new key. `resolveSharedPath` is untouched;
  the fallback is a separate `ownCheckoutPath`, and `deriveIncludeDirs` gains a third boundary so
  a spec under the checkout but outside the workspace root climbs to the checkout.
- **The writer keeps one root.** `canonicalSharedPath` takes the checkout as a second boundary and
  still answers a `/Users/Shared/postman-protos` path, so the method picker writes the canonical
  declaration for a proto it read out of the checkout.

`DeclaredSpec.via` says which root answered — `link`, `own-checkout`, or `both` when the checkout
answered and the link held the file as well — `SpecsView.ownCheckout` carries the path, and a link
whose specs all resolved through the checkout is dropped from `unresolvedLinks` while staying
visible as a row and as a `preman protos link` line — with the real path in place of
`<path-to-checkout>`.

## Rationale

**ADR 038's uniformity was about what is written, and this changes only what is read.** 038 chose
one spelling for a declared path and priced the loss: `refund-core`'s 24 relative specs worked on a
fresh clone with no setup, and after conversion a teammate must create one link first. The
mitigation 038 named was that the link is named after the repository they just cloned. This record
observes that if the name is enough for a person to act on, it is enough for the resolver to act
on — the engine already holds the workspace root, the `.git` above it and the basename of that
directory. The file keeps 038's single canonical spelling; the reader gains a second place to look.

**The alternative 038 rejected was a second spelling, and this is not it.** 038 considered "shared
link when the proto is outside the workspace, relative path when it is inside" and refused it
because "where does a declared proto live" would have two answers in the file. That objection is
about the file, and it survives intact here: nothing is written differently, including by the
method picker, which is why `canonicalSharedPath` had to gain the checkout in the same phase as the
fallback. Shipping the fallback without it would have made every method pick in a repo-local
workspace write a `../../pkg/client/…` location, which is precisely the machine dependence 038
removed, reintroduced one request at a time.

**The checkout wins over the link, and that is a deliberate behaviour change.** The other order was
available and is worse: a clone's protos would then depend on machine-wide state the clone cannot
see, so someone editing a `.proto` on a feature branch would keep reading whichever checkout the
link happens to point at. Two clones open at once would read one repository. The escape hatch is
the "only when the file is there" half — a spec deleted on this branch still comes from the link.

**Exactness rather than fuzziness, because ambiguity is an error and a near-miss is a guess.**
`LinkOverride.name` makes name-equals-basename a default rather than an invariant, so a rule that
matched `refund-core-fix` against `refund-core` would be a heuristic wearing an answer's clothes.
The compensation is that the CLI and the pane pre-fill the real path, which turns a renamed clone
into one visible action instead of a silent wrong answer.

**A link that stops being needed does not stop being worth showing.** A workspace that is _not_
inside the repository whose protos it declares still needs `preman protos link`, and a green row
with no name in it is how that link never gets created. So `via` distinguishes the two, the row
says which way it resolved, and `renderLinkWrite` reports `N of M specs now resolve` — where
`0 of M` is the wrong-checkout signal that used to print as success.

**`via` has a third value because the label is for the reader, not for the resolver.** On the
machine the link was made on, the link and the checkout are the same directory, and a two-valued
`via` labelled all 24 rows of the workspace that motivated this record — output that was correct
and told the reader nothing. `both` is that case, named in core where the two `existsSync` calls
already are rather than reconstructed by each front end comparing a link target against a path.
The cost is that a repoint whose target also holds the file is silent in the row as well as in the
resolution; the consequence below is where a reader learns that, and `preman protos` still prints
the link's real target beside the name.

## Consequences

**A deliberate repoint is ignored for a workspace inside a matching clone.** If `refund-core` is
repointed at clone A and the workspace inside clone B is opened, clone B reads its own protos. That
is a real behaviour change for anyone relying on the repoint, accepted for the reason above, and
escapable per file by the fall-through.

**Nothing changes for a standalone multi-repo workspace.** There is no single own checkout, so a
workspace declaring specs from a dozen services still needs one link per repository. That is
untouched by design, and the shapes the shared root already holds — a real directory rather than a
symlink, a link pointing _inside_ a checkout, a link whose name is no repository's directory
name — resolve exactly as they did.

**`repoRootFor` now runs on the catalog path.** `loadResources` computes it once per file rather
than once per spec; it costs one `existsSync` per ancestor level, and the budgets in
`docs/performance.md` were re-read locally because CI sets `PREMAN_SKIP_PERF=1` (ADR 030).

**Two roots means two functions, not one function with two roots.** `resolveSharedPath` and
`canonicalSharedPath` are asserted inverses, and a workspace that declares one file and opens
another is the failure that assertion exists to prevent. The fallback is therefore
`ownCheckoutPath`, called beside `resolveSharedPath` rather than inside it, and the one function
that did gain a root is the writer — where the added case answers with the same canonical prefix
as the old one.

**A worktree works and nothing reads `.git`'s contents.** `repoRootFor` tests for the marker's
existence, which is a directory in a clone and a file in a worktree. Recording a repository's
identity — a committed name-to-remote map — was considered and left out: an SSH and an HTTPS remote
are different strings for the same repository, a fork is a different remote entirely, and
`.postman/` belongs to Postman.
