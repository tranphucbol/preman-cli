# 049: A group is a document you can open, and auth is one editor

Status: Accepted

## Decision

Two rules, and the second is why the first was needed.

**A collection or a folder opens as a tab.** `Edit collection` / `Edit folder` on the sidebar's
context menu calls the same `openNode` a request click calls; `useTabsStore.open` already took any
`DocumentKind` and `readNode` already resolved a group to its `.resources/definition.yaml`.
`App.tsx`'s `EditorPane` forks on `tab.kind !== "request"` and renders `GroupEditor` — two
sub-tabs, Auth and YAML — above no response pane and behind no Send button. A group whose
definition file does not exist opens empty, and the first save creates it: `editDefinitionFile`
seeds `$kind` and `writeFileAtomic` already made the directory.

**The Auth pane names the credentials of the scheme it is showing, and there is one of it.**
`AuthPane` is exported from `RequestEditor.tsx` and imported by `GroupEditor.tsx`. The type is a
`Select` over `AUTH_SCHEMES`, whose first option — `Inherit from parent` — is the absence of the
`auth:` key, and whose credential rows come from `CREDENTIAL_FIELDS`, a table that names `token`,
`username`/`password`, and `key`/`value`/`in` because `renderAuth` reads exactly those. Credentials
are read from a map or an array and written back in the shape they were found in. On the inherit
arm the pane says which ancestor supplies the auth and which scheme it is, and the ancestor is a
button that opens it.

## Rationale

The Auth tab existed, was reachable, and could not author auth. Its comment explained why: it
would not "pretend to know the shape of nine auth schemes", so it showed the type as free text and
one row per credential key the file already had. Both halves of that failed in the same direction.

There are four schemes, not nine — `SUPPORTED_AUTH_TYPES` — and `renderAuth` reads a fixed key per
scheme. Declining to name them meant a request with `type: bearer` and no credentials showed an
empty list under the words "add them on the YAML tab", so the only way to author auth in this app
was to stop using it. And the reader rejected an array, which is the shape ADR 033's migration
writes: `lookup` in core reads both, deliberately, with a comment saying map-only reading "would
authenticate hand-written files and silently drop the token from migrated ones". The window did
exactly that — the request authenticated on the wire and showed nothing on screen.

The free-text type was worse than lax. `oauth2` was accepted by the editor and threw at send,
which is the one class of error this repository has otherwise refused to defer.

Then the hint: "Empty means inherit from the folder. Core resolves the chain." True, and
unfalsifiable from the window. Nothing said which folder, or what it would send, and there was no
way to reach that folder to find out, because a group was the one document the app could read and
not open. So the request pane's honest answer required the group editor; that is the whole reason
this ADR has two halves rather than one.

Rejected:

- **A dedicated `auth` message on the protocol.** Nothing needed it. `read-node` / `write-node`
  and `FieldEdit` already served four document kinds; the missing work was entirely in the
  renderer, and inventing a message would have made auth the one field with a private channel.
- **A read-only inherited-auth strip on the request, and no group editor.** Cheaper, and it makes
  the request pane a dead end with a longer explanation on it. If the app can tell you a folder
  supplies your token, it can let you change it.
- **Opening a group on click, like a request.** A click on a group already means expand or
  collapse, and that is the gesture people use to navigate. The menu item costs one more click to
  the thing almost nobody does, and costs nothing to the thing everyone does.
- **A separate `GroupAuthPane`.** Two editors for one file format, and the second would be the one
  that quietly stopped matching. That a folder and a request carry the same `auth:` block is not a
  coincidence to be reimplemented; it is the fact `resolveAuth` walks.
- **Masking credential values.** A `{{token}}` reference is the common case and is not a secret;
  masking would hide the variable name, which is the part worth reading. The plain value is
  already in a file the user can open.
- **Keeping the free-text type and validating it.** The same list, spelled twice, in the place
  where an error message replaces a working control.

## Consequences

`resolveSubTab` fixes a bug the group tab would otherwise have been the first to hit. `SUB_TABS` is
one union across every document kind, and the old fallback for a remembered sub-tab the document
lacks was `DEFAULT_SUB_TAB`, which is `body`. HTTP and gRPC both have a body, so the fallback had
never been wrong; a group has neither `body` nor a trigger for it, and would have opened onto an
empty pane. The fallback is now the first entry of the list actually in use, which is `params` for
a request and `auth` for a group.

`Breadcrumb`, the conflict and orphan banners, the sub-tab content wrapper, `Notice` and
`LoadFailure` moved to `panes/DocumentChrome.tsx`. None of them ever knew what kind of document
they sat above, and the second editor is what made that visible.

`CatalogNode` gains an optional `auth`, carrying the type only and never the credentials, because
the catalog is broadcast to the window on every refresh and ADR 013 keeps payloads out of it. That
is enough for the inherit arm to name the scheme, and a test asserts `inheritedAuth` agrees with
core's `resolveAuth` for every request in both fixture workspaces — the one place this duplication
could drift.

gRPC still has no Auth tab. `applyGrpcAuth` still runs, so gRPC auth remains editable only as YAML,
and that trade is now less defensible than it was: the reason given for it was the cost of a
credentials editor, and the credentials editor now exists. It was left out because widening the
gRPC sub-tab list was not asked for, not because the argument still holds.

The sub-tab list is per-editor and the union is global, so a fifth kind of document costs a list
and a fork, and `SubTab` keeps growing. The alternative — a per-kind union — was not worth the
generics for two editors.

`sendActiveTab` now checks `tab.kind`. The send shortcut fires with a collection active and
`sendNode` would have answered a keystroke with a transport error; running a collection is `Run…`,
which is a different verb and stays on the menu.

What this does not solve: choosing `Inherit from parent` deletes the `auth:` block, because the
absence of the key is the only spelling of inheritance the format has. There is no undo. The
confirm dialog is the whole mitigation, and it is only shown when credentials would be lost.
