/**
 * The sidebar tree.
 *
 * Four rules hold this file together, and each one is the reason the pane is fast:
 *
 * 1. The list is flat. The engine sends `CatalogNode[]` pre-sorted in Postman order, collapse is a
 *    filter, and TanStack Virtual mounts only the viewport. A nested tree cannot be virtualized
 *    without walking it, which is why `buildCatalog` never sends one.
 * 2. A row subscribes by id. `useNode`, `useIsSelected` and `useIsCollapsed` read one entry out of
 *    the store, so selecting a row re-renders two rows rather than five thousand.
 * 3. Radix is mounted at the root, not per row. One `ContextMenu`, one `Tooltip` provider, and the
 *    row that was right-clicked is read off the event target. Five thousand Radix roots is the
 *    mistake this file exists to avoid.
 * 4. A drag is not tracked in React state. The pointer moves continuously and `setState` on every
 *    frame would reconcile the viewport sixty times a second; the plan lives in a ref and state
 *    changes only when the *discrete* answer changes, which is once per row crossed.
 */
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useRef, useState } from "react";

import type { CatalogNode, MutateOp, RequestKind } from "@preman/desktop/engine/protocol.js";

import { resolveMark, type GitDecoration, type RowMark } from "@preman/desktop/renderer/model/git.js";
import { resolveDrop, type DropSide } from "@preman/desktop/renderer/model/order.js";
import { useDensityTokens, useRemeasure } from "@preman/desktop/renderer/stores/appearance.js";
import {
  useCatalogStore,
  useGitDecoration,
  useIsCollapsed,
  useIsSelected,
  useNode,
  type CatalogState,
} from "@preman/desktop/renderer/stores/catalog.js";
import { useUnsavedMark } from "@preman/desktop/renderer/stores/tabs.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { methodClass } from "@preman/desktop/renderer/ui/method.js";
import {
  ContextContent,
  ContextItem,
  ContextMenu,
  ContextSeparator,
  ContextTrigger,
} from "@preman/desktop/renderer/ui/Menu.js";
import {
  CaretRightIcon,
  CollectionIcon,
  DeleteIcon,
  FolderIcon,
  FolderOpenIcon,
  NewFolderIcon,
  NewRequestIcon,
  RenameIcon,
  RevealIcon,
  RunnerIcon,
  SendIcon,
} from "@preman/desktop/renderer/ui/icons.js";

/** Rows rendered above and below the viewport. Three is enough to hide a fast flick at 28px. */
const OVERSCAN = 8;

/** Indent per depth level. 12px reads as a level without pushing deep names off the pane. */
const INDENT_PX = 12;

/**
 * The leading column: a request's verb, or a group's chevron and icon. Sized for `DELETE` beside a
 * caret, reserved on every row so every name in the tree starts at the same x, and right-aligned
 * so that whatever it holds sits against the name.
 *
 * One column and not two. A fixed chevron column ahead of a verb-width one put a group's caret a
 * whole `DELETE` away from its folder, which reads as the caret belonging to nothing: the caret and
 * the icon are one control - press either to expand - and they have to look like it. Right-aligning
 * the pair is what keeps that true without giving group names a different left edge to requests.
 */
const LEAD_COLUMN_PX = 64;

/** Where a between-rows drop line starts: at the destination's indent, clear of nothing else. */
const DROP_LINE_INSET_PX = 16;

const NO_TARGET = null;

/**
 * How far the pointer travels before a press becomes a drag. Below this a press is still a click,
 * which is what keeps a tree of 28px rows clickable at all.
 */
const DRAG_THRESHOLD_PX = 4;

/**
 * The share of a group row's height that reads as "beside it" at each end. 28% leaves the middle
 * 44% for "into it", which is the biggest of the three bands because it is the ambiguous one.
 */
const EDGE_RATIO = 0.28;
const HALF = 2;

/** Must equal `--z-index-drag` in app.css: `DragOverlay` writes its own inline z-index. */
const DRAG_Z_INDEX = 25;

/*
 * dnd-kit's own tween rather than a Motion spring: the pill's job is to travel to the row it landed
 * on, dnd-kit already knows both rectangles, and a spring would need the drag velocity that
 * `dropAnimation` does not expose. The curve is `--ease-out` spelled out because this option is
 * read by dnd-kit and not by CSS, so a custom property would not resolve. Decision 26.
 */
const DROP_ANIMATION = { duration: 200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" } as const;

/**
 * Replaces dnd-kit's default, which offers the space bar. There is no `KeyboardSensor` here because
 * the tree has no keyboard navigation to drag from yet, and instructions for a sensor that does not
 * exist are worse than none.
 */
const DRAG_INSTRUCTIONS = "Drag a row with the pointer to move or reorder it.";

const NO_OPS: readonly MutateOp[] = [];

const UNSUPPORTED_LABEL = "n/a";
const GRPC_LABEL = "gRPC";

/**
 * The row's mark column, and the width reserved for it on every row.
 *
 * One character at the right edge, VS Code's letters because they are the ones people already
 * read, and the column is always there so a `git stash` does not reflow every name in the tree.
 * A descendant gets a dot rather than a letter: something below this row changed, and naming
 * *which* status would be a lie when several differ.
 *
 * Unsaved work outranks git in this one slot (plan 016): while a tab has pending edits its row
 * shows the accent disc instead of its letter, and the letter returns the instant it is saved.
 * The title still names both facts when both are true, since the glyph can only show one.
 */
const GIT_COLUMN_PX = 10;
const GIT_MARK: Record<GitDecoration, { readonly glyph: string; readonly tone: string; readonly title: string }> = {
  modified: { glyph: "M", tone: "text-warn", title: "Modified in git" },
  added: { glyph: "A", tone: "text-ok", title: "Added in git" },
  deleted: { glyph: "D", tone: "text-danger", title: "Deleted in git" },
  renamed: { glyph: "R", tone: "text-accent", title: "Renamed in git" },
  untracked: { glyph: "U", tone: "text-ok", title: "Untracked in git" },
  conflicted: { glyph: "!", tone: "text-danger", title: "Conflicted in git" },
  descendant: { glyph: "•", tone: "text-ink-faint", title: "Contains changes in git" },
};
const UNSAVED_TITLE = "Unsaved changes";

const selectVisible = (state: CatalogState) => state.visibleIds;
const selectRoot = (state: CatalogState) => state.root;

/**
 * Where the drop line goes, in pixels down the virtual list.
 *
 * This is the *resolved* answer, not the pointer's: a plan that cannot be expressed produces no
 * indicator at all, so the pane never draws a line for a drop it is going to refuse.
 */
interface DropIndicator {
  readonly top: number;
  /** Left inset of the line, so it starts where the destination's names start. */
  readonly indent: number;
  /** A group being dropped into is outlined whole rather than given an edge. */
  readonly inside: boolean;
}

export interface SidebarProps {
  readonly onOpen: (node: CatalogNode) => void;
  readonly onSend: (node: CatalogNode) => void;
  /** Groups only: opens the collection runner on this node. Not a run of its own. */
  readonly onRun: (node: CatalogNode) => void;
  readonly onCreateRequest: (parentId: string, kind: RequestKind) => void;
  readonly onCreateFolder: (parentId: string) => void;
  readonly onRename: (node: CatalogNode) => void;
  readonly onDelete: (node: CatalogNode) => void;
  readonly onReveal: (node: CatalogNode) => void;
  /** In order, and possibly more than one: see `resolveDrop`. Never called with an empty list. */
  readonly onDrop: (ops: readonly MutateOp[]) => void;
}

export function Sidebar(props: SidebarProps) {
  const visibleIds = useCatalogStore(selectVisible);
  const root = useCatalogStore(selectRoot);
  const scrollRef = useRef<HTMLDivElement>(null);

  /**
   * The single context target. Radix opens on the trigger, which is the whole viewport, so the
   * pointerdown handler records which row was under the cursor before the menu opens.
   */
  const [targetId, setTargetId] = useState<string | null>(NO_TARGET);

  const [dragId, setDragId] = useState<string | null>(null);
  const [indicator, setIndicator] = useState<DropIndicator | null>(null);

  /**
   * The plan the indicator is showing, and the pointer position that produced it. Both are refs
   * because `onDragMove` fires per frame: state changes only when `signature` does, which is once
   * per row edge crossed rather than sixty times a second.
   */
  const planRef = useRef<readonly MutateOp[]>(NO_OPS);
  const signatureRef = useRef<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: DRAG_THRESHOLD_PX } }));

  const rowHeight = useDensityTokens().row;
  const virtualizer = useVirtualizer({
    count: visibleIds.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    getItemKey: (index) => visibleIds[index] ?? index,
  });
  useRemeasure(virtualizer, rowHeight);

  const captureTarget = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
    setTargetId(row?.dataset["nodeId"] ?? NO_TARGET);
  }, []);

  const clearDrag = useCallback(() => {
    planRef.current = NO_OPS;
    signatureRef.current = null;
    setDragId(null);
    setIndicator(null);
  }, []);

  const onDragStart = useCallback((event: DragStartEvent) => {
    setDragId(String(event.active.id));
  }, []);

  const onDragMove = useCallback(
    (event: DragMoveEvent) => {
      const over = event.over;
      const draggedId = String(event.active.id);
      if (over === null) {
        signatureRef.current = null;
        planRef.current = NO_OPS;
        setIndicator(null);
        return;
      }

      const overId = String(over.id);
      const catalog = useCatalogStore.getState();
      const overNode = catalog.byId.get(overId);
      if (overNode === undefined) {
        return;
      }

      // The activator is where the press landed, so plus the delta is where the pointer is now.
      const pointerY = (event.activatorEvent as PointerEvent).clientY + event.delta.y;
      const side = sideFor(over.rect, pointerY, overNode.kind !== "request");

      const signature = `${overId}:${side}`;
      if (signature === signatureRef.current) {
        return;
      }
      signatureRef.current = signature;

      const plan = resolveDrop(catalog.nodes, draggedId, { overId, side });
      planRef.current = plan.ops;
      setIndicator(
        plan.ops.length === 0 ? null : indicatorFor(plan.side, overNode, visibleIds.indexOf(overId), rowHeight),
      );
    },
    [visibleIds, rowHeight],
  );

  const onDragEnd = useCallback(
    (_event: DragEndEvent) => {
      const ops = planRef.current;
      clearDrag();
      if (ops.length === 0) {
        return;
      }
      // Expanded before the mutation lands, so the row does not appear to vanish into a shut folder.
      const destination = destinationOf(ops);
      const catalog = useCatalogStore.getState();
      if (destination !== null && catalog.collapsed.has(destination)) {
        catalog.toggle(destination);
      }
      props.onDrop(ops);
    },
    [clearDrag, props],
  );

  if (root === null) {
    return <EmptyPane message="No workspace open." hint="Open one with Cmd+Shift+O." />;
  }

  if (visibleIds.length === 0) {
    return <EmptyPane message="This workspace has no requests yet." hint="Right-click to add a collection." />;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      accessibility={{ screenReaderInstructions: { draggable: DRAG_INSTRUCTIONS } }}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={clearDrag}
    >
      <ContextMenu>
        <ContextTrigger className="min-h-0 flex-1">
          <div
            ref={scrollRef}
            onContextMenu={captureTarget}
            className="h-full overflow-x-hidden overflow-y-auto overscroll-contain"
          >
            {/*
              Keyed by the row height so a density change remounts the list instead of sliding it.
              A row animates to a new offset, and every offset moves at once when the token does;
              a remounted element has no previous transform to animate from. The key is why the
              offset below is arithmetic rather than `item.start`: the virtualizer's cache is
              thrown away in an effect, so its offsets would land one render after this key, and
              the list would slide anyway.
            */}
            <div key={rowHeight} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => (
                // Uniform rows, the same assumption `indicatorFor` already makes.
                <Row
                  key={item.key}
                  nodeId={visibleIds[item.index] ?? ""}
                  offset={item.index * rowHeight}
                  onOpen={props.onOpen}
                />
              ))}
              {indicator !== null && <DropLine indicator={indicator} />}
            </div>
          </div>
        </ContextTrigger>
        <SidebarContextMenu targetId={targetId} {...props} />
      </ContextMenu>
      {/*
        Unconditional, including a refused drop. dnd-kit animates the pill to the *dragged* node's
        own final rect, never to the row it was denied: an accepted drop travels to where the row
        landed, a refused one travels back to where it started, and a source row the virtualizer has
        since unmounted has no rect to measure, so the pill simply disappears. Gating this on
        `indicator` would disable it for every drop, not only refused ones - `clearDrag` nulls the
        indicator and the pill in the same update, so by the render dnd-kit animates, both are gone.
      */}
      <DragOverlay dropAnimation={DROP_ANIMATION} zIndex={DRAG_Z_INDEX}>
        {dragId !== null && <DragPill nodeId={dragId} refused={indicator === null} />}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * Which edge of the row the pointer is on.
 *
 * A group gets three bands, because dropping *into* it is a real answer. A request gets two split
 * at the midpoint: it holds nothing, so a middle band would be a slower way to say "after" and it
 * would make the gap above a request hard to hit.
 */
function sideFor(rect: { readonly top: number; readonly height: number }, pointerY: number, holds: boolean): DropSide {
  const offset = pointerY - rect.top;
  if (!holds) {
    return offset < rect.height / HALF ? "before" : "after";
  }
  const edge = rect.height * EDGE_RATIO;
  if (offset < edge) return "before";
  if (offset > rect.height - edge) return "after";
  return "inside";
}

function indicatorFor(side: DropSide, over: CatalogNode, visibleIndex: number, rowHeight: number): DropIndicator {
  const top = visibleIndex * rowHeight;
  if (side === "inside") {
    return { top, indent: 0, inside: true };
  }
  return {
    top: side === "before" ? top : top + rowHeight,
    indent: over.depth * INDENT_PX + DROP_LINE_INSET_PX,
    inside: false,
  };
}

/** The destination parent of a plan, when the plan moves the node out of its current one. */
function destinationOf(ops: readonly MutateOp[]): string | null {
  for (const op of ops) {
    if (op.op === "move") return op.parentId;
  }
  return null;
}

/**
 * The drop affordance. A line for a gap, an outline for a group, and nothing at all for a refusal:
 * the absence of this element is how the pane says the drop will not happen.
 */
function DropLine({ indicator }: { readonly indicator: DropIndicator }) {
  if (indicator.inside) {
    return (
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 z-drag h-row rounded-xs ring-1 ring-accent ring-inset"
        style={{ top: indicator.top }}
      />
    );
  }
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute right-gutter z-drag h-0.5 -translate-y-px bg-accent"
      style={{ top: indicator.top, left: indicator.indent }}
    />
  );
}

/**
 * What follows the cursor. Refusal is carried here as well as by the missing line, because the
 * pointer is what the user is watching and a dimmed pill is readable without looking away from it.
 */
function DragPill({ nodeId, refused }: { readonly nodeId: string; readonly refused: boolean }) {
  const node = useNode(nodeId);
  if (node === undefined) {
    return null;
  }
  return (
    <div
      className={cn(
        "flex h-row max-w-64 items-center rounded-sm border bg-control px-2 text-xs shadow-float",
        refused ? "border-line text-ink-faint" : "border-accent text-ink",
      )}
    >
      <span className="truncate">{node.name}</span>
    </div>
  );
}

/**
 * One row. Subscribed by id, so a selection change repaints the row that lost it and the row that
 * gained it. Absolutely positioned by the virtualizer's offset rather than laid out in flow,
 * because a transform per row is one composite and a reflow per row is not - and it is a transform
 * rather than `top`, which is what makes the offset animatable at all. Decision 26.
 */
function Row({
  nodeId,
  offset,
  onOpen,
}: {
  readonly nodeId: string;
  readonly offset: number;
  readonly onOpen: (node: CatalogNode) => void;
}) {
  const node = useNode(nodeId);
  const selected = useIsSelected(nodeId);
  const collapsed = useIsCollapsed(nodeId);
  const git = useGitDecoration(nodeId);
  const unsaved = useUnsavedMark(nodeId);

  // Both, on the same element and the same id: a row is a thing you can pick up and a place you can
  // put one, and the pair is what lets `pointerWithin` name a row without a separate hit target.
  const { attributes, listeners, isDragging, setNodeRef: setDragRef } = useDraggable({ id: nodeId });
  const { setNodeRef: setDropRef } = useDroppable({ id: nodeId });
  const setRef = useCallback(
    (element: HTMLElement | null) => {
      setDragRef(element);
      setDropRef(element);
    },
    [setDragRef, setDropRef],
  );

  if (node === undefined) {
    return null;
  }

  const group = node.kind !== "request";
  const unsupported = node.protocol === "unsupported";

  const activate = () => {
    useCatalogStore.getState().select(nodeId);
    if (group) {
      useCatalogStore.getState().toggle(nodeId);
      return;
    }
    onOpen(node);
  };

  return (
    <div
      ref={setRef}
      data-node-id={nodeId}
      role="treeitem"
      aria-level={node.depth + 1}
      aria-selected={selected}
      aria-expanded={group ? !collapsed : undefined}
      // Only the two dnd-kit adds. Its `role` and `tabIndex` would overwrite the tree semantics
      // above with a generic button, which is a worse trade than losing a keyboard affordance the
      // pane does not offer anyway.
      aria-roledescription={attributes["aria-roledescription"]}
      aria-describedby={attributes["aria-describedby"]}
      tabIndex={-1}
      onClick={activate}
      {...listeners}
      className={cn(
        "absolute inset-x-0 top-0 flex h-row items-center gap-1.5 pr-gutter",
        // Only a toggle moves a row. The offset is an absolute position in the list, so scrolling
        // does not change it - the scroll container moves and the offsets do not - and a row
        // scrolled into view is a fresh element with nothing to animate from. That leaves expand
        // and collapse as the only thing this transition can ever run on.
        "transition-transform duration-(--duration-panel) ease-out",
        selected ? "bg-selected" : "hover:bg-hover",
        // The row stays in place and fades: the pill under the cursor is the thing being moved, and
        // a row that vanished would collapse the list under the pointer mid-drag.
        isDragging && "opacity-40",
      )}
      style={{ transform: `translateY(${offset}px)`, paddingLeft: node.depth * INDENT_PX }}
    >
      {/* One fixed column for all three, so every name in the tree starts at the same x. */}
      <span className="flex shrink-0 items-center justify-end gap-1 overflow-hidden" style={{ width: LEAD_COLUMN_PX }}>
        {group ? (
          <>
            {/*
              One element that turns rather than two that swap. Inside a row rendered up to 200
              times this is strictly less reconciliation work than the conditional element type it
              replaces, and `transform` on an `<svg>` is compositor work. The list below it still
              appears and disappears instantly: rows are absolutely positioned off a JS number and
              the collapse is a store-level filter, so there is no height here to interpolate.
            */}
            <CaretRightIcon
              className={cn(
                "text-glyph transition-transform duration-(--duration-glyph) ease-out",
                !collapsed && "rotate-90",
              )}
            />
            <NodeIcon node={node} collapsed={collapsed} />
          </>
        ) : (
          <MethodLabel node={node} />
        )}
      </span>

      <span
        className={cn(
          "min-w-0 flex-1 truncate text-xs",
          group && "font-medium",
          unsupported ? "text-ink-faint" : "text-ink",
        )}
      >
        {node.name}
      </span>

      <NodeMark decoration={git} unsaved={unsaved} />
    </div>
  );
}

/**
 * The row's mark, or the space it would take. Rendered even when there is nothing to say, so the
 * names in a decorated tree sit exactly where they sat in an undecorated one.
 *
 * No longer only a git mark (hence the rename): `resolveMark` decides whether this row's own
 * unsaved edits or its git status wins the one glyph the column has room for.
 */
function NodeMark({
  decoration,
  unsaved,
}: {
  readonly decoration: GitDecoration | undefined;
  readonly unsaved: boolean;
}) {
  const mark = resolveMark(unsaved, decoration);
  return (
    <span
      className="shrink-0 text-center font-mono text-2xs leading-none"
      style={{ width: GIT_COLUMN_PX }}
      title={mark === undefined ? undefined : titleFor(mark)}
    >
      {mark === undefined ? null : mark.kind === "unsaved" ? (
        <span className="inline-block size-1.5 rounded-full bg-accent" role="img" aria-label={UNSAVED_TITLE} />
      ) : (
        <span className={GIT_MARK[mark.decoration].tone}>{GIT_MARK[mark.decoration].glyph}</span>
      )}
    </span>
  );
}

/** Composes both facts when both are true, since the glyph can only ever show one of them. */
function titleFor(mark: RowMark): string {
  if (mark.kind === "git") return GIT_MARK[mark.decoration].title;
  const gitTitle = mark.decoration === undefined ? undefined : GIT_MARK[mark.decoration].title;
  return gitTitle === undefined ? UNSAVED_TITLE : `${UNSAVED_TITLE} · ${gitTitle}`;
}

/**
 * Groups only. A request row carries its verb instead: an icon repeated on every request row says
 * nothing the tree structure has not already said, and it costs the name the width it takes.
 */
function NodeIcon({ node, collapsed }: { readonly node: CatalogNode; readonly collapsed: boolean }) {
  if (node.kind === "collection") {
    return <CollectionIcon className="text-ink-dim" />;
  }
  return collapsed ? <FolderIcon className="text-ink-dim" /> : <FolderOpenIcon className="text-ink-dim" />;
}

/**
 * The verb. gRPC reads `gRPC` rather than the method tail: the tail can be any length, so it either
 * truncates to nothing useful or it widens the column for every row in the tree. The request name
 * already says which method it is, and the full path is one click away in the editor.
 */
function MethodLabel({ node }: { readonly node: CatalogNode }) {
  if (node.protocol === "unsupported") {
    return <span className="font-mono text-2xs text-ink-faint">{UNSUPPORTED_LABEL}</span>;
  }
  if (node.protocol === "grpc") {
    return <span className="font-mono text-2xs text-method-grpc">{GRPC_LABEL}</span>;
  }
  if (node.label === undefined) {
    return null;
  }
  return <span className={cn("font-mono text-2xs uppercase", methodClass(node.label))}>{node.label}</span>;
}

/**
 * The one menu. Its items are computed from `targetId` at open time rather than bound per row,
 * which is what lets a single Radix root serve the whole tree.
 */
function SidebarContextMenu({ targetId, ...props }: { readonly targetId: string | null } & SidebarProps) {
  // Subscribed rather than read imperatively: the menu can be open while the watcher renames the
  // node under it, and a menu offering "Delete" on a stale name is worse than a menu that closed.
  const node = useNode(targetId ?? "");
  if (node === undefined) {
    return null;
  }

  const group = node.kind !== "request";
  const runnable = !group && node.protocol !== "unsupported";

  return (
    <ContextContent>
      {runnable && (
        <>
          <ContextItem icon={<SendIcon />} shortcut="Enter" onSelect={() => props.onSend(node)}>
            Send
          </ContextItem>
          <ContextSeparator />
        </>
      )}
      {group && (
        <>
          {/*
            Opens the runner rather than starting a run. A collection run takes an iteration count,
            a data file and a bail flag, and firing one off from a context menu with all three
            defaulted is how you find out you needed them afterwards.
          */}
          <ContextItem icon={<RunnerIcon />} onSelect={() => props.onRun(node)}>
            Run…
          </ContextItem>
          <ContextSeparator />
          {/*
            Two items rather than one item and a picker. The protocol decides which fields the
            request even has, so it is not a setting you change later, and a dialog that asks
            for a name and a protocol is two questions where one item answers both.
          */}
          <ContextItem icon={<NewRequestIcon />} onSelect={() => props.onCreateRequest(node.id, "http-request")}>
            New HTTP request
          </ContextItem>
          <ContextItem icon={<NewRequestIcon />} onSelect={() => props.onCreateRequest(node.id, "grpc-request")}>
            New gRPC request
          </ContextItem>
          <ContextItem icon={<NewFolderIcon />} onSelect={() => props.onCreateFolder(node.id)}>
            New folder
          </ContextItem>
          <ContextSeparator />
        </>
      )}
      <ContextItem icon={<RenameIcon />} onSelect={() => props.onRename(node)}>
        Rename
      </ContextItem>
      <ContextItem icon={<RevealIcon />} onSelect={() => props.onReveal(node)}>
        Reveal in Finder
      </ContextItem>
      <ContextSeparator />
      <ContextItem danger icon={<DeleteIcon />} onSelect={() => props.onDelete(node)}>
        Delete
      </ContextItem>
    </ContextContent>
  );
}

function EmptyPane({ message, hint }: { readonly message: string; readonly hint: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-xs text-ink-dim">{message}</p>
      <p className="text-2xs text-ink-faint">{hint}</p>
    </div>
  );
}
