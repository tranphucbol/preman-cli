# 028: The create dialog asks what before it asks name

Status: Accepted

## Decision

The dialog behind the `+` in the tab row asks three questions in one shape — **type**, then **name**,
then **in** — and commits with a single accent `Create`. Type is a vertical radio list of
`HTTP request` and `gRPC request`, visible without a click and selected before the name is typed.

This reverses the rule the same dialog shipped with, which was recorded as a `Do not simplify them
into a toggle` comment on the `new-request` variant in `ui/Dialog.tsx`: name and destination in the
body, and the protocol answered by which of two submit buttons you pressed — `Create HTTP` or
`Create gRPC`.

A group is the dialog's **secondary action**, on the left of the footer, and it takes the name and
the destination the form already holds. It is not a third row in the type list and not a third
button in the primary group.

The destination list begins with **the workspace root**, which has no catalog row because it is the
directory every node id is relative to. Selecting it turns the secondary action into
`New collection` and disables `Create`, because core would otherwise write a request file where only
collections may sit.

The sidebar's context menu is unchanged. It still offers `New HTTP request`, `New gRPC request` and
`New folder` as three items, and the reasoning under those items still holds: the menu was opened on
a row, so the destination is already answered, and three items cost no more than one.

## Rationale

The two-submit footer was a good answer to a two-answer question. It stopped being one the moment a
folder had to be creatable from the tab row, which is what a `+` beside the tab strip is for — the
sidebar is the only place a folder could be made, and the sidebar is the pane a user working in the
editor has most likely collapsed.

A folder is not a protocol, so it cannot join the footer as a third `Create …`. The alternatives
were:

- **Four buttons.** `Cancel`, `Create folder`, `Create gRPC`, `Create HTTP` across a 384px dialog,
  three of them the same verb with different nouns. That is a toolbar, not a decision, and it makes
  the accent — which `docs/design-system.md` says is a fill exactly once per pane — the answer to
  "which of these three did you mean" rather than "commit this".
- **A second `+`, or a split button.** Two entry points in a 32px row for one idea, and the split
  half is a menu that costs a click before the dialog: the exact cost the original comment was
  avoiding.
- **A closed `Select` for the type.** Compact, and it is what most tools do. It also hides, behind a
  click, the one answer on the form that cannot be changed afterwards.

The last one is what decided the type control. The original comment's real argument was never about
buttons; it was that "the protocol decides which fields the request even has, so it is not a setting
you change later". A decision with that weight should be the first thing on the form and it should
be readable without interacting with it. Two visible rows say what this dialog makes; a collapsed
picker says only what it is about to make.

The group did not join them there, and a fourth alternative is why: a type list reading
`HTTP request / gRPC request / Folder` puts three answers under one label that is only true of two
of them. `Type` is a property of a request. A folder does not have one, and the name and destination
above it mean something slightly different for a group than for a request — which is the shape of a
secondary action, not of a third radio. Left of the footer is where a dialog puts an action that is
adjacent to the question rather than an answer to it, and it costs nothing in the common case: the
primary pair is still where the eye and the Enter key both end up.

The root row exists because the `+` could not otherwise make the first thing in an empty workspace.
It also removes a disabled state: the `+` used to gate on the workspace having at least one
collection, and a `+` that greys out on a fresh workspace teaches nothing about how to ungrey it.
Now it gates on a workspace being open, which is the same gate the sidebar's own header buttons
take, and the dialog handles the one combination the engine will not: a request at the root.

The rest of the form was rebuilt to match the app rather than to match itself. It had grown its own
label language — `text-2xs font-medium tracking-wide uppercase` — beside a `Labelled` in
`ui/Controls.tsx` whose whole doc comment is the form rules, and its destination label was a bare
`<p>` reading `In`, so clicking it did nothing and only an `aria-label` carried the name. Both are
now `Labelled`, which required one small widening: `Select` accepts an `id`, which lands on its
trigger — a `<button>`, and therefore a labelable element.

## Consequences

Enter now means what is on screen. It used to submit `Create HTTP` whatever the user had in mind,
which was defensible only because HTTP is the common case; the form is pre-set to `HTTP request` for
that same reason, so the fast path is unchanged in keystrokes and no longer requires knowing which
branch the key picks.

`Ask` gained a `CreateTarget` — `RequestKind | "folder"` — and lost the assumption that the dialog's
answer is a `RequestKind`. `createAt` in `App.tsx` branches on it into the three engine calls the
sidebar already makes — `create-request`, `create-folder`, and `create-collection` from the sidebar's
header rather than its menu — and only the request arm passes `{ open: true }`, because a new group
has nothing in it to open.

The root's id is a sentinel, `<root>`, and not `null` or `""`. It travels as data on the `Ask` so
that `ui/Dialog.tsx` can compare against it without importing from `renderer/model/`, which keeps
the dialog's promise that it learns nothing about a catalog. Angle brackets because `sanitiseSegment`
strips them, so no node's path can ever spell it. `defaultDestination` now returns a `string` rather
than `string | null`, since the bottom of its fallback chain is a real place.

The type list is markup rather than a shared component, though `panes/SettingsPane.tsx` has a
`Choice` doing the same native-radio trick. The two are different shapes in the design system — a
card in a grid there, a row in a vertical list here — and folding them into one component with a
layout prop would make "which one do I reach for" a judgement call again, which is the failure
`docs/design-system.md` exists to prevent. If a third radio group appears in a third shape, that is
the signal to reconsider.

What this does not do is give the sidebar's own menu a dialog. Creating from a row still opens the
plain name prompt, because the row answered the other two questions before the dialog opened, and a
dialog that re-asks a question the click already answered is slower than the one it replaced.
