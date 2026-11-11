# The desktop app

`@preman/desktop` puts a window in front of the same engine: it opens a workspace, edits requests
and environments, and runs them. The CLI and the app read and write the same files, so a request
created in the window runs from the terminal, and a file changed by either one appears in the other
on its next read. [Install](install.md#the-desktop-app) covers getting it onto a Mac.

## Workspaces

The app can create an empty workspace, named from the workspace dropdown, the File menu or the
command palette, always under `~/.local/share/preman/workspace`; `Open workspace…` remains the way
to a workspace that already exists anywhere else.

Window bounds, open tabs, and unsaved drafts live in Electron's `userData`, never in the workspace,
so `git status` stays clean while the app is open
([ADR 010](../decisions/010-explicit-save-and-app-state.md)).

## Requests, folders and collections

A new request comes from either end of the window. The sidebar's context menu on a collection or a
folder offers **New HTTP request**, **New gRPC request** and **New folder**, which put one inside it;
the `+` in the tab row, beside the environment picker, asks the same three as one form — the
protocol, a name, and which collection or folder it goes in, with **New folder** beside its
**Create**. That form's destination list starts at the workspace root, which is where a collection
lives, so the first one can be made from there too.

The context menu on a request itself offers **Duplicate**, which copies the file — comments, scripts
and examples included — to `Foo copy` directly below the original and opens it. Duplicate copies
what is on disk, so save an edited tab first.

A collection or a folder is a document too — **Edit collection** or **Edit folder** on its context
menu opens its `.resources/definition.yaml` as a tab, with an **Auth** tab of its own and a **YAML**
one. There is no Send: a group is not an exchange, and running one is still **Run…**. A group that
has no definition file yet opens empty, and saving writes it
([ADR 049](../decisions/049-a-group-is-a-document-you-can-open.md)).

## Environments

An environment is made from the last row of the environment picker itself — **New environment…**,
below the values and a rule — or from the command palette. It is created empty and becomes the
active one, so the next `{{token}}` you write has somewhere to be set. A name another environment
already holds is refused rather than resolved to `Foo (2)`: an environment is reached by name, by
the picker and by `-e` alike, so two files answering to one name would be one of them silently
ignored. The picker is present in every workspace, including one with no environments yet.

## Auth

The **Auth** sub-tab picks a type — **No Auth**, **Bearer Token**, **Basic Auth** or **API Key** —
and then asks for exactly the credentials that type sends, so a `{{token}}` goes in a field named
Token rather than a row you had to know to add. Its first option, **Inherit from parent**, removes
the request's own `auth:` block, which is how the format spells inheritance; the pane then names the
collection or folder your token is coming from and which type it is, and that name is a button that
opens it. A type preman cannot send says so in the pane instead of at the send. Credentials the file
carries that the chosen type does not read are kept and shown below, because nothing here deletes
something you wrote without saying so.

The block also wins over a header you wrote by hand, the way Postman's does. If a request declares
`bearer` auth and also carries an `Authorization` header, the block is what goes on the wire — so
the **Headers** sub-tab says which header is being replaced and what it said, above the list, before
you send. This is the direction Postman takes; the header that used to quietly beat a correct token
is the reason it changed ([ADR 050](../decisions/050-the-auth-block-wins-over-an-authored-header.md)).

## Bodies

A raw HTTP body and a gRPC message can be re-indented from the **Beautify** glyph at the right of
their toolbar. It rewrites whitespace and nothing else, so a bare `{{token}}`, `1e3`, `1.0` and a
twenty-digit id all survive byte for byte — a body is bytes that go on the wire, and a formatter that
reserialises them sends a different request. `Cmd+Z` reverts it, and a body it cannot read says so
rather than being quietly changed. The response pane's pretty-print toggle is the same gesture on the
other half of the app; that one does reserialise, because a response has already been sent
([ADR 031](../decisions/031-an-authored-body-is-re-indented-not-reserialised.md)).

## Responses

The response header counts up from the moment **Send** is clicked, so the wait is visible rather
than inferred, and settles on the transport duration once the exchange finishes — the number the
Timeline tab, the console and `--report` all agree on. The Timeline shows the wall-clock wait beside
it, which is where the difference between the two goes.

A `text/event-stream` response is read as it arrives. The Body tab becomes a list of events, newest
first, each with the time it landed and expandable to its full data; the header states how many have
arrived and how many bytes, and says whether the stream is still open. Nothing about it waits for the
stream to close, which is the point — a completion stream is worth watching, not worth waiting for.
**Cancel** closes the socket and keeps every event that had already arrived; a stream the server or
the network cut short instead says so above the list. `preman run` does not stream: it buffers, so
`--timeout-request` stays a hard ceiling in CI
([ADR 052](../decisions/052-a-stream-is-a-response-in-parts.md)).

The console drawer logs every call the app makes, not only what the scripts said: each request
appears where it happened, with the logs and `pm.sendRequest` calls it caused indented under it, and
expands to show what was sent and what came back.
