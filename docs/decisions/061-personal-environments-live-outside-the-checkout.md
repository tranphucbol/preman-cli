# 061: Personal environments live outside the checkout, collection variables inside it

Status: Accepted

## Decision

An environment is either shared, in `postman/environments/` as before, or personal, in
`$XDG_CONFIG_HOME/preman/workspaces/<folder>-<hash8>/environments/` (`~/.config` when the variable is
unset). `<hash8>` is the first 8 hex characters of the SHA-256 of the workspace's absolute path; the
folder name is there only so a person browsing the directory can tell which is which. Both kinds use
the same file format and go through the same listing, selection, writeback and editor. Names are
unique across both: creating a taken name is refused, and a name that matches one of each is an
ambiguity error listing both files, never a silent preference.

Inside the desktop engine a personal environment's node id is `~personal/<file>`, which
`resolveWithinRoot` maps to the config directory before its usual refusal of anything outside the
root. The host watches the personal directory alongside the workspace.

Collection variables are read from the `variables:` block of the collection's own
`.resources/definition.yaml`, the shape Postman's Local View writes, and fill the `collection` scope
the store has always had and nothing filled. Folders have none, as in Postman. They are editable from
the collection's Variables tab and the Variables pane. A script's `pm.collectionVariables.set` lasts
for the run and is never written back.

## Rationale

Creating an environment for one's own token or local port meant creating a file in someone else's
repository, which then shows up in `git status` or is committed by accident. Three placements were
weighed.

**A gitignored directory inside the workspace** (`postman/environments/.personal/`) keeps everything
in one tree, but only works if every repository adds the ignore rule, and preman would be editing
`.gitignore` in repositories it does not own to make it so.

**An override layer** — a personal file that shadows keys of a shared environment — answers "my token
for the team's QC environment" more precisely, but adds a sixth scope, a merge rule, and a second
answer to "which file did this value come from" in every pane that shows one. Whole personal
environments answer the common case with no new scope.

**The user's config directory**, chosen, needs nothing from the repository. Keying it by absolute
path rather than by remote or repository name means it needs no git either, at the cost below.

Collection variables were already a scope in the store, exposed to scripts, and written by the
Postman importer into the definition. Reading them was the missing half. Writing script changes back
was declined: the definition is a committed, shared file, and a run that rewrites it on every token
refresh would produce exactly the noise personal environments exist to avoid.

## Consequences

Moving or re-cloning a checkout orphans its personal environments: the hash changes and the old
directory is never read again or cleaned up. Two checkouts of the same repository do not share them.

Personal environments are invisible to anyone else, by design, so a request that only resolves in one
person's personal environment works for them and fails for a teammate with a clear unresolved-token
error.

Collection variable edits from a script are lost at the end of a run, which differs from Postman,
where a collection run may persist them to the cloud collection.
