# Protos

A gRPC request finds its method through the `.proto` files the workspace declares in
`.postman/resources.yaml`. In the app, **Protos** in the command palette — or the link button beside
a gRPC request's method picker — browses for them.

## The shared link

Every declared path runs through a symlink farm at `/Users/Shared/postman-protos`, one link per
repository, named after it:

```yaml
localResources:
  specs:
    - /Users/Shared/postman-protos/zas-spec/api/zas/admin/admin.proto
    - /Users/Shared/postman-protos/acquiring-core/api/proto/admin.proto
```

That path is the same string on every machine, which an absolute path to your home directory is
not. What differs per machine is one symlink per repository, and both front ends tell you which ones
are missing by name. On a fresh checkout:

```sh
preman protos                                    # what is declared, and which links are absent
preman protos link zas-spec ~/repos/zas-spec     # one link covers every proto in that repository
```

In the app the same repair is a **Locate…** button beside each missing link. Adding a proto stages a
plan first: it names the link it would create, shows the path it would write, and loads each `.proto`
so an unresolvable `import` surfaces before anything is written. Nothing reaches disk until you
apply it.

The link points at the checkout's root, so imports resolve exactly as they do inside the repository.
A workspace whose specs are still plain relative or absolute paths keeps working; **Move onto
links…** converts them in one reviewed step. See
[ADR 038](../decisions/038-a-proto-is-declared-through-a-shared-link.md).

## A workspace inside its own repository

A workspace that lives _inside_ the repository whose protos it declares needs no link at all. If the
missing link is named after the checkout the workspace itself is in — the directory holding the
`.git` above `.postman/` — those specs are read straight out of that checkout, so a fresh clone
resolves its own protos with nothing set up.

The link name stays on screen, labelled as coming from the workspace's own checkout, because anyone
whose workspace is _not_ in that repository still needs it — the label appears only where it is
news, so a machine whose link already points at that same checkout reads exactly as it did before.
Every other case is unchanged: a spec from another repository, or one absent from this checkout,
still comes through the link, and a clone in a differently-named directory still has to be located
by hand — with the path pre-filled rather than guessed. See
[ADR 042](../decisions/042-the-resolver-has-two-roots.md).

## Moving the shared root

Set `PREMAN_SHARED_PROTO_ROOT`, or the field in the app's settings, if `/Users/Shared` is not
writable on your machine. Only where this machine _looks_ moves — what the workspace records is
always the default, so the file stays portable.
