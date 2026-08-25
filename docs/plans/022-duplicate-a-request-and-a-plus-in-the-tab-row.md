# Plan: duplicate a request, and put a new-request button in the tab row

Status: done. See the deviations section. Written against `d20e1df` with the work of
`docs/decisions/027-the-app-reports-its-own-phases.md` in the working tree but not committed — that
change adds 91 lines to `packages/desktop/src/engine/protocol.ts`, 16 to `host.ts` and 10 to
`panes/Sidebar.tsx`, and every line number below is the post-027 tree. Note that tree does not
typecheck at the time of writing: `test/support/big-workspace.ts:180-210` calls a 3-argument
function with 2. That is 027's to finish, and phase 0 here cannot be called green until it is.

## The issue

Two small gaps, both about the same thing: getting a new request file into the workspace costs more
clicks than it should, and there is no way at all to start from one that already works.

**There is no duplicate.** A request that has a URL, three headers, an auth block and a `pm.test`
is the most valuable thing in the workspace, and the only way to get a second one like it is to
create an empty request and retype the lot — or to leave the app, copy the file in Finder, and rename
it. The sidebar's context menu offers Send, Run…, New request, New folder, Rename, Reveal in Finder
and Delete (`packages/desktop/src/renderer/panes/Sidebar.tsx:645-693`) and nothing between them
produces a copy.

**Creating a request means going back to the tree.** The only entry point is the sidebar context
menu on a collection or folder (`Sidebar.tsx:671-676`), which means: leave the editor you were
typing in, find the folder in the tree, right-click it, pick the protocol, name it. Every other
tabbed tool in the category has a `+` in the tab row for this, and the tab row is where you already
are.

## Why nothing happens today

| #   | Cause |
| --- | ----- |
| 1   | `MutateOp` (`packages/desktop/src/engine/protocol.ts:70-78`) has eight operations and none of them copies anything. `applyMutation` (`packages/desktop/src/engine/host.ts:325-365`) is exhaustive over that union, so there is no seam a duplicate could arrive through. |
| 2   | `packages/core/src/api/mutate.ts` can create a request from a skeleton (`createRequestFile`, `:215-223`, via `skeletonFor`, `:179-185`) but has no operation that reads an existing document and writes it somewhere else. |
| 3   | `TabBar` (`packages/desktop/src/renderer/App.tsx:478-487`) draws the tab strip and the environment picker and nothing else. `TabStrip` itself returns `null` when no request is open (`packages/desktop/src/renderer/panes/TabStrip.tsx:41`), so there is not even an always-present surface in it to hang a button on. |
| 4   | Creating a request needs a `parentId` and the `+` has none. The sidebar gets it from the row that was right-clicked (`Sidebar.tsx:671`); a button in the tab row has no such row. |

Adjacent facts that shape the design:

**A tab is a file, and there is no such thing as an untitled request.** `Tab.nodeId`
(`packages/desktop/src/renderer/stores/tabs.ts:49`) is a catalog node id, which is a path relative
to the workspace root (`packages/core/src/api/catalog.ts:51-52`). Every tab in the app is something
that exists on disk. A `+` that opened a blank scratch tab would be a second kind of tab, with its
own answers for where it saves, whether it can run, and what happens to it on quit — a feature the
size of decision 010, not a button.

**The tree deliberately refuses a protocol picker.** `Sidebar.tsx:666-670` reads: "Two items rather
than one item and a picker. The protocol decides which fields the request even has, so it is not a
setting you change later, and a dialog that asks for a name and a protocol is two questions where
one item answers both." Anything the `+` does has to survive that sentence or change it.

**`createRequestFile` lets the display name and the filename diverge, on purpose.** `requestPathFor`
resolves a collision to `Foo (2).request.yaml` (`packages/core/src/workspace/paths.ts:68-85`) while
`skeletonFor` writes the unsuffixed name into the file (`mutate.ts:221`), and
`test/mutate.test.ts:167-173` asserts exactly that, commented "The display name is not suffixed:
only the filename had to be unique." So creating "Ping" twice gives two nodes both named `Ping`.
That is a considered position for a name the user typed twice, and it is the wrong one for a button
that generates the name itself — see decision 3.

**`orderBetween` already exists and is already the answer to "directly below this one".**
`packages/desktop/src/renderer/model/order.ts:86-103` returns a value strictly between two sibling
orders, or `null` when the gap is exhausted, and the module's own doc comment (`:8-15`) states the
strategy: prefer the gap, renumber only as a fallback, refuse rather than guess. Nothing new needs
inventing for placement.

**`applyPlan` does not report what it created.** `packages/desktop/src/renderer/actions.ts:160-166`
loops `mutate` and returns a `Failure` or `null`, dropping every `nodeId`. Only the single-op
`mutate` helper can open what it made (`actions.ts:132-137`). A duplicate that needs a renumber
first is therefore two calls, not one plan.

**Both icons already exist.** `AddIcon` is `Plus` (`packages/desktop/src/renderer/ui/icons.ts:42`),
already the add-row affordance in `KeyValueGrid.tsx:235` and `VariablesPane.tsx:359`; `CopyIcon` is
`Copy` (`icons.ts:23`) and is currently unused.

## Decisions

| #   | Decision |
| --- | -------- |
| 1   | **Duplicate is a new `MutateOp`, `{ op: "duplicate"; targetId; order? }`, backed by `duplicateRequestFile` in core.** Not a renderer-side read-then-create: the file's comments, scripts and examples are the reason to duplicate it at all, and only the engine may read and write workspace files. |
| 2   | **The copy is the bytes on disk, and a dirty tab is not warned about.** Duplicate is a file operation and says so. Under decision 010 a draft is not the request yet, so there is nothing else it could honestly copy — and a modal explaining that on every duplicate would be a tax on the common case, where nothing is dirty. |
| 3   | **The copy is named `Foo copy`, then `Foo copy 2`, `Foo copy 3` — and the display name inside the file matches the filename.** This deviates from `createRequestFile`'s divergence (see the adjacent fact above) deliberately: a second duplicate is one click made twice, not a name typed twice, and two nodes both reading `Foo copy` would collide in the one place the app cannot afford it — the tab strip, whose whole job is telling open requests apart (`TabStrip.tsx:4-6`) — and would make a CLI selector against that name ambiguous (`packages/core/src/api/select.ts:19-21`). |
| 4   | **No dialog. Duplicate happens on the click.** The name is generated, the destination is the original's own folder, and both are visible in the tree a frame later. A prompt would ask a question whose answer is already correct. |
| 5   | **The copy lands directly below the original, using `orderBetween`, renumbering only when the gap is exhausted.** The mechanism `model/order.ts` already documents, reached from a new pure planner rather than from the click handler. |
| 6   | **The copy opens and takes focus**, via the `{ open: true }` path `create-request` already uses (`App.tsx:656`). You duplicated it to change something. |
| 7   | **Requests only. Duplicating a folder or a collection is refused with a `usage` error naming the target.** A recursive directory copy has its own story about nested collisions and about one click writing hundreds of files, and it is not this plan's. The menu item is simply absent on a group, so the error is a guard, not a path a user reaches. |
| 8   | **The `+` is pinned in `TabBar`, left of the environment picker, and never scrolls.** The row's own doc comment (`App.tsx:471-473`) says the picker was pulled out of the strip precisely so it could not scroll away with the fortieth tab; a `+` inside the scroll container would reintroduce that. It also means the button is present when no request is open, which the strip is not. |
| 9   | **The `+` is disabled, with the label "Create a collection first", when the workspace has no group to put a request in.** Matches how the sidebar's own header buttons gate on the workspace (`App.tsx:622-635`) rather than failing at the engine. |
| 10  | **The `+` opens one dialog — name and destination — committed by two buttons, `Create HTTP` and `Create gRPC`.** This keeps `Sidebar.tsx:666-670` true: there is still no protocol *control*, and the protocol is still answered by which thing you pressed. It is the same two-questions-in-one-act shape as the tree's two menu items, in the one place a menu would have cost a second click before the dialog. |
| 11  | **`Enter` in that dialog commits `Create HTTP`**, which is the accented primary. HTTP is the common case; a dialog where the obvious key does nothing is worse than one that picks the likely branch. |
| 12  | **The destination defaults to the active tab's folder, then the sidebar selection's folder, then nothing.** A fallback chain is acceptable here, and only here, because the picker is on screen and correctable — which is exactly why decision 4's no-dialog duplicate does not get one. |
| 13  | **The new `Ask` variant lives in `ui/Dialog.tsx` and carries plain data**: `destinations: readonly { id: string; label: string }[]`, not catalog nodes. One Radix root keeps one `pending` and one dismissal path (`Dialog.tsx:66-71, 74-79`), and `ui/` learns nothing about the catalog beyond the `RequestKind` string union. |
| 14  | **No `Cmd+T`, no application-menu entry.** The button is the feature; a shortcut is a separate decision about the menu, and adding one here would put a second unreviewed surface on the same dialog. |

### Consequences worth naming

**Duplicate names differently from create, and a reader will call that a bug.** After this plan,
creating `Ping` twice by hand gives two nodes both named `Ping`
(`test/mutate.test.ts:167-173`, unchanged), while duplicating `Ping` twice gives `Ping copy` and
`Ping copy 2`. Both behaviours are deliberate and they now sit side by side in one module. Decision
3 has to be readable at `duplicateRequestFile` itself, not only here, or someone unifies them and
breaks one of the two.

**This is the first mutation that reads a workspace file before writing one.** Every existing
`MutateOp` either writes a skeleton, edits in place, renames or moves. Duplicate parses the source
with the YAML Document API and re-serialises it, which means it inherits that API's guarantees about
comment preservation (decision 005) and also its failure mode: a source file that no longer
validates cannot be duplicated. That refusal is correct — the copy would be a second invalid file —
but it is a new way for a menu item to fail, so it fails with the source's own validation details.

**The copy's `order` is computed in the renderer, not the engine.** `planDuplicate` is a pure
renderer function because it needs the sorted sibling list the catalog already holds, and the engine
would have to re-derive it. That is the same division `resolveDrop` already uses, but it does mean
`{ op: "duplicate" }` with no `order` is a legitimate call that lands the copy last — which is what
the CLI or a test would get, and what `nextOrder` (`paths.ts:119-123`) means by last.

**The renumber fallback makes duplicate two round trips.** Because `applyPlan` discards `nodeId`
(`actions.ts:160-166`), the exhausted-gap case is a `reorder` through `applyPlan` and then a
`duplicate` through `mutate`. Between them the catalog rebuilds twice and the tree visibly settles
twice. The alternative — teaching `applyPlan` to return the last created node — widens a helper five
call sites share, for a case that needs 1000 requests in one folder to reach.

**Decision 12's fallback chain was chosen without asking.** "The active tab's folder" was; what
happens with no tab open was not. If landing on the sidebar selection feels wrong, the honest
alternative is an unset picker that must be answered, which costs one interaction on first use per
session.

**`ui/Dialog.tsx` grows a third variant and a domain-shaped one.** `Ask` is currently `name` and
`confirm`, both generic. `new-request` is a specific product surface living in the generic module,
justified by decision 13's single-root argument. If a fourth product-specific variant ever wants in,
that is the signal to invert it: a `panes/` dialog with `ui/` providing the shell.

---

## Phase 0 — core duplicates a request file

`packages/core/src/api/mutate.ts`:

```ts
export interface DuplicateRequestArgs {
  /** The request file to copy. A group is refused. */
  target: string;
  /** Omitted means "last", derived from the highest declared sibling order. */
  order?: number;
}

export function duplicateRequestFile(args: DuplicateRequestArgs): Promise<string>;
```

- Refuses a missing target and a non-request target — `isRequestFile` (`mutate.ts:293`) — with
  `usage`, the same shape `renameNode` uses at `:309`. The group message says duplicating a folder
  is not supported rather than that the path is wrong, because that is the true reason.
- Reads with `readDocument(target)` and mutates only `name` and `order` through `setIn`, exactly as
  `renameNode` does (`:322-323`). Not `stringify` of a parsed object: a request's `pm` scripts,
  its examples and every comment in it are the reason the user pressed duplicate, and re-serialising
  a JS value is how those are silently dropped.
- Resolves the display name first, then the path, so the two cannot drift (decision 3):

```ts
const COPY_SUFFIX = "copy";
/** The first numbered copy is 2: `Foo copy`, `Foo copy 2`. There is no `Foo copy 1`. */
const FIRST_NUMBERED_COPY = 2;
```

  `freeCopyName(dir, base)` walks `Foo copy`, `Foo copy 2`, … until
  `join(dir, name + REQUEST_SUFFIX)` does not exist, bounded by the same `COLLISION_LIMIT`
  `resolveCollision` uses (`paths.ts:71-76`) and throwing the same shaped error at the bound. It
  duplicates a little of `resolveCollision`'s loop on purpose: that function's contract is a *path*
  with a `(2)` convention, and this one needs a *name* with a ` 2` convention, which is decision 3.
- `validateRequest(file, doc)` before writing, then `writeFileAtomic(newPath, doc.toString())`.
- `order` is `args.order ?? nextOrder(siblingOrders(dirname(target)))`.
- Exported from `packages/core/src/index.ts` beside `createRequestFile` (`index.ts:43-45`) and added
  to the surface list in `test/core-surface.test.ts:19-20`, because that list is the declaration.

| Situation | Result |
| --------- | ------ |
| target is a `.request.yaml` that validates | new file, `Foo copy`, `usage` never raised |
| target is a group directory | `usage`: duplicating a collection or folder is not supported |
| target does not exist | `usage`: it may have been deleted outside the app |
| target no longer validates | the source's own validation error, unchanged |
| `Foo copy` already exists | `Foo copy 2`, both name and filename |
| more copies than `COLLISION_LIMIT` | `PremanError` naming the last name tried |

## Phase 1 — the operation crosses the wire

`packages/desktop/src/engine/protocol.ts`:

- `MutateOp` (`:70-78`) gains `| { op: "duplicate"; targetId: string; order?: number }`.

`packages/desktop/src/engine/host.ts`:

- One `case "duplicate"` in `applyMutation` (`:325`), resolving the target with `resolveWithinRoot`
  the way `rename` does (`:344-345`) and returning the created path so `mutate` maps it through
  `nodeIdFor` (`:322`) and the renderer can open it.
- Not `requireDirectory` (`:367`): the target is a file, and the refusal for a group belongs in core
  where the message can say why.

## Phase 2 — where the copy lands

`packages/desktop/src/renderer/model/order.ts`:

```ts
export interface DuplicatePlan {
  /** Written into the copy. `undefined` means "last", which core resolves. */
  readonly order: number | undefined;
  /** Run before the duplicate, and only when the gap was exhausted. */
  readonly reorderOps: readonly MutateOp[];
}

export function planDuplicate(nodes: readonly CatalogNode[], targetId: string): DuplicatePlan;
```

- Filters the target's siblings out of the pre-sorted `nodes` the same way the drop planner does,
  finds the target's position, and calls `orderBetween(target.order, next?.order)` (`:86`).
- A number means one write. `null` means the sibling list is renumbered with the existing
  `numbered`/`slotAt` helpers (`:66-76`) so the copy has a slot to sit in, and `reorderOps` carries
  that single `reorder` op.
- An empty plan is not a case here: unlike a drop, a duplicate can always be expressed — worst case
  it lands last. So this function never refuses, which is worth a comment given the module's stated
  rule 2 is "refuse rather than guess".

`packages/desktop/src/renderer/actions.ts` — a `duplicateNode(nodeId)` beside the existing helpers,
which runs `reorderOps` through `applyPlan` when non-empty and then
`mutate({ op: "duplicate", targetId, order }, { open: true })`. Two calls, for the reason named in
the consequences.

## Phase 3 — the menu item

`packages/desktop/src/renderer/panes/Sidebar.tsx`:

- `SidebarProps` gains `readonly onDuplicate: (node: CatalogNode) => void;` beside `onRename`
  (`:180`).
- `SidebarContextMenu` (`:634`) renders a `ContextItem` with `CopyIcon` reading **Duplicate**,
  inside a `!group` branch, immediately above **Rename** (`:683`) — the copy is a variant of the
  thing you are pointing at, so it belongs with rename and not with the group section's
  "New HTTP request".
- The item is absent rather than disabled on a group. There is nothing a user could do to make it
  work, and a permanently greyed row is a question the menu cannot answer.

`packages/desktop/src/renderer/App.tsx`:

- `onDuplicate={(node) => { void duplicateNode(node.id).then(onFail); }}` in the `Sidebar` props
  (`:664-668` neighbourhood), reporting failure through the same banner every other mutation uses.
- A comment at the call site recording decision 2: the file is copied, not the draft, because under
  decision 010 the draft is not the request yet.

## Phase 4 — the `+` and its dialog

`packages/desktop/src/renderer/ui/Dialog.tsx`:

- `Ask` (`:37-52`) gains:

```ts
| {
    readonly kind: "new-request";
    readonly title: string;
    readonly initial: string;
    readonly destinations: readonly { readonly id: string; readonly label: string }[];
    readonly initialDestinationId: string | null;
    readonly onConfirm: (name: string, destinationId: string, kind: RequestKind) => void;
  }
```

- `AskBody` (`:90-111`) becomes a three-way switch, and a new `NewRequestForm` holds the name and
  the destination. It reuses `Field` for the name (`Controls.tsx:221`) and `Select`/`SelectOption`
  (`Controls.tsx:376, 426`) for the destination, which is the control the environment picker already
  uses and therefore the one the row's density is tuned for.
- `Actions` (`:215-239`) is untouched; the new form renders its own footer with `Cancel`,
  `Create gRPC` as a neutral `Button`, and `Create HTTP` as the `primary` submit — which is what
  makes decision 11 fall out of the markup rather than out of a key handler.
- Submit is disabled while the trimmed name is empty or no destination is chosen, matching
  `NameForm`'s `disabled={trimmed.length === 0}` (`:189`).
- A module comment on the variant carrying decision 10 in full, quoting the tree's reasoning, so the
  next reader does not "simplify" two buttons into a toggle.

`packages/desktop/src/renderer/model/` — a pure resolver, tested without React:

```ts
export function defaultDestination(
  nodes: readonly CatalogNode[],
  activeTabNodeId: string | null,
  selectedId: string | null,
): string | null;
```

- The active tab's `parentId`, else the selection (itself if it is a group, else its `parentId`),
  else `null`. `CatalogNode.parentId` is `string | null` (`catalog.ts:57`), so the root case is a
  real branch and returns `null` rather than reaching for the first collection.

`packages/desktop/src/renderer/App.tsx`:

- `TabBar` (`:478-487`) gains an `IconButton` with `AddIcon` in the existing pinned `ml-auto` group,
  before `EnvironmentPicker` (`:482-484`). Labelled "New request"; when there are no group nodes in
  the catalog it is `disabled` and labelled "Create a collection first" (decision 9).
- Its click raises the new `Ask`, with `destinations` mapped from the catalog's group nodes — depth
  rendered into the label so a folder is distinguishable from the collection above it — and
  `initialDestinationId` from `defaultDestination`.
- `onConfirm` is the existing create path: `mutate({ op: "create-request", parentId, name, kind },
  { open: true })`, the same call the tree makes at `:656`.
- `TabBar` currently takes only `onClose`; it now needs the ask callback threaded from the component
  that owns `ask` state (`:150`), through both `TabBar` call sites (`:794`, `:821`).
- The row's doc comment (`:465-477`) gains a sentence on why the `+` is pinned beside the picker and
  not inside the strip (decision 8) — that comment is already the place this repo explains what the
  row is for.

## Phase 5 — Fixtures, tests, docs

Nothing is added to the shared fixture. `test/fixtures/ws/` keeps its exact 5-request list and group
statuses, which several suites assert, so **every case below that writes uses
`cloneFixtureWorkspace()`** — the existing `describe`s in `test/mutate.test.ts` already do.

Permanent fixture edits: none.

Cloned, via `cloneFixtureWorkspace()`:

- the duplicate cases in `test/mutate.test.ts`
- the `duplicate` op round-trip in `test/desktop.workspace.test.ts`

`test/mutate.test.ts`, a new `describe("duplicateRequestFile")`:

`givenRequestWithCommentsAndScripts_whenDuplicated_thenBothSurviveByteForByte`,
`givenRequest_whenDuplicated_thenNameAndFilenameBothSayCopy`,
`givenExistingCopy_whenDuplicatedAgain_thenNameAndFilenameBothSayCopy2`,
`givenGroup_whenDuplicated_thenUsageErrorSaysFoldersAreNotSupported`,
`givenMissingTarget_whenDuplicated_thenUsageError`,
`givenNoOrder_whenDuplicated_thenItSortsAfterEveryOrderedSibling`.

The second and third are the ones that hold decision 3, and they assert the file's `name:` line and
`basename` together — separately, either one passes while the pair drifts.

`test/core-surface.test.ts` — `duplicateRequestFile` joins the list at `:19-20`.

`test/renderer/order.test.ts`:

`givenGapBelowTheOriginal_whenPlanDuplicate_thenOneOrderAndNoReorder`,
`givenAdjacentOrders_whenPlanDuplicate_thenTheSiblingsAreRenumberedFirst`,
`givenLastSibling_whenPlanDuplicate_thenTheCopyGoesAfterIt`,
`givenSiblingWithNoDeclaredOrder_whenPlanDuplicate_thenTheCopyStillLandsBelowTheOriginal` — the
`ORDER_ABSENT` asymmetry `orderBetween`'s comment (`order.ts:78-85`) exists to describe.

`test/desktop.workspace.test.ts`:

`givenRequestNodeId_whenDuplicateOpApplied_thenCatalogShowsTheCopyBelowIt`,
`givenGroupNodeId_whenDuplicateOpApplied_thenTheHostReportsAUsageError`.

New `test/renderer/` cases for the button and the resolver:

`givenActiveTab_whenDefaultDestination_thenItIsTheTabsFolder`,
`givenNoTabButASelectedFolder_whenDefaultDestination_thenItIsTheSelection`,
`givenNoTabAndNoSelection_whenDefaultDestination_thenNull`,
`givenWorkspaceWithNoCollections_whenTabBarRendered_thenTheNewRequestButtonIsDisabled`.

Docs:

- `README.md`, wherever the sidebar's context menu and the tab row are described, gains Duplicate
  and the `+`. If the tab row is not currently described there, the `+` goes in the same section as
  the environment picker, because they now share a row and are read together.
- `docs/design-system.md` is read before the button and the `Select` land, per `AGENTS.md`, and its
  control inventory gains nothing new — the point of decision 13 and phase 4 is that both controls
  already exist.
- No ADR. Neither feature changes the process model, the synchrony of core, how files are written or
  how the perf budget is read, and decision 10 upholds `Sidebar.tsx:666-670` rather than reversing
  it. If a reviewer reads decision 3's naming divergence as weighty enough to reopen, that is the
  one candidate here for the next-numbered record.

Every phase ends with `bun run typecheck`, `bun run lint`, `bun run format:check` and `bun run test`
green.

---

## Deviations taken while implementing

**Phase 0 was already green.** The 027 work the header describes as uncommitted is committed
(`7416e3e`), `test/support/big-workspace.ts` typechecks, and the tree was clean before this plan
started.

**The copy's base name comes from the file's `name:`, not its filename.** `freeCopyName` is fed
`displayNameOf(target, doc)`, falling back to the filename when the file declares no `name` — which
`httpRequestSchema` allows, and most real HTTP files use. Duplicating a `Ping (2).request.yaml` that
still says `name: Ping` therefore gives `Ping copy`, not `Ping (2) copy`. Either base satisfies
decision 3 — the name and the path resolve from one string — and this one reads as the copy of what
the tab strip says.

**`COPY_LIMIT` is a local constant, not `paths.ts`'s `COLLISION_LIMIT`.** The plan said "the same
bound"; `COLLISION_LIMIT` is not exported and exporting it would widen `paths.ts`'s surface to
share a number. It is the same value, named beside the loop that uses it.

**`groupDestinations` joined `defaultDestination` in the new `model/destination.ts`.** Phase 4 put
the depth-rendered label mapping in `App.tsx`. It is the same pure "what goes in the picker"
question as the default, it is the predicate the `+`'s disabled state reads, and having it in the
model is what let both be tested without a window.

**`givenWorkspaceWithNoCollections_whenTabBarRendered_thenTheNewRequestButtonIsDisabled` is
asserted through its predicate instead.** `vitest.config.ts` runs one project with
`environment: "node"` and the repo has no jsdom and no testing-library; the only rendering tests
are `test/renderer/perf.app.test.ts`, which launches a built Electron behind `PREMAN_PERF=1`.
Rather than add a DOM environment for one assertion, the case is
`givenAWorkspaceWithNoCollections_whenGroupDestinations_thenTheListIsEmpty` — the exact expression
`NewRequestButton` gates on.

**The `+` subscribes to a boolean, not to the destination list.** `TabBar` re-renders on every tab
switch, so `NewRequestButton` watches only `nodes.some(kind !== "request")` — which stops on the
first node, because collections sort first — and builds the labelled list in the click handler from
`getState()`. Mapping five thousand nodes on a tab switch would spend that interaction's blocking
budget on a list nobody had asked to see.

**`TabBar` took `onFail` as well as `onAsk`.** The `+`'s `create-request` has to report failure
through the same banner every other mutation uses, and `EditorPane` already holds the `Fail` at
both call sites.

**`README.md` describes neither the context menu nor the tab row**, so both features went into one
new paragraph in the Desktop app section, as the plan's fallback directs. `docs/reference.md`'s
engine-protocol table now lists `duplicate` among the `mutate` operations.

**The dialog this plan shipped was then rebuilt, and the plan's `Create HTTP` / `Create gRPC`
footer is gone.** The `+` now makes a folder and a collection as well, which the footer could not
absorb as two more `Create …` buttons. Decision 28 has the whole argument; what it changes here is
that the `new-request` variant is now `create`, it asks the protocol first in a visible radio list,
it commits with a single `Create`, and a group is the left-hand secondary action beside it. Two of
the plan's other decisions went with it: the destination picker now leads with the workspace root,
so `defaultDestination` returns a `string` rather than `null` at the bottom of its chain, and the
`+`'s gate is a workspace being open rather than a collection existing. The pinned `+` itself, and
the fallback chain above that floor, are untouched.

---

## Out of scope

- **Duplicating a folder or a collection.** Decision 7. The recursive copy, and its story about
  nested collisions and about one click writing hundreds of files, is a separate plan.
- **Duplicating an environment.** Same shape as a request and genuinely easy, but the environments
  list is a different surface with a different menu, and nobody asked.
- **`Cmd+T` and an application-menu entry for New request.** Decision 14.
- **A scratch or untitled tab.** The adjacent fact above: it is a second kind of tab, not a button.
- **Duplicate carrying the unsaved draft.** Decision 2. The escape hatch is the one that already
  exists: save, then duplicate.
- **Duplicate-to-elsewhere ("copy to…").** A destination picker on duplicate would make it the
  dialog decision 4 refuses. Duplicate then drag is two gestures that already work.
- **Multi-select duplicate.** The sidebar has no multi-select at all; that is a tree feature, not a
  duplicate one.
- **Undo.** Delete already tells the truth that git is the only undo
  (`App.tsx:712-716`), and a stray copy is a delete away.
