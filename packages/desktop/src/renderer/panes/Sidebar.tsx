/**
 * The sidebar tree.
 *
 * Three rules hold this file together, and each one is the reason the pane is fast:
 *
 * 1. The list is flat. The engine sends `CatalogNode[]` pre-sorted in Postman order, collapse is a
 *    filter, and TanStack Virtual mounts only the viewport. A nested tree cannot be virtualized
 *    without walking it, which is why `buildCatalog` never sends one.
 * 2. A row subscribes by id. `useNode`, `useIsSelected` and `useIsCollapsed` read one entry out of
 *    the store, so selecting a row re-renders two rows rather than five thousand.
 * 3. Radix is mounted at the root, not per row. One `ContextMenu`, one `Tooltip` provider, and the
 *    row that was right-clicked is read off the event target. Five thousand Radix roots is the
 *    mistake this file exists to avoid.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useRef, useState } from "react";

import type { CatalogNode, RequestKind } from "@preman/desktop/engine/protocol.js";

import {
  useCatalogStore,
  useIsCollapsed,
  useIsSelected,
  useNode,
  type CatalogState,
} from "@preman/desktop/renderer/stores/catalog.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import {
  ContextContent,
  ContextItem,
  ContextMenu,
  ContextSeparator,
  ContextTrigger,
} from "@preman/desktop/renderer/ui/Menu.js";
import {
  CaretDownIcon,
  CaretRightIcon,
  CollectionIcon,
  DeleteIcon,
  FolderIcon,
  FolderOpenIcon,
  NewFolderIcon,
  NewRequestIcon,
  RenameIcon,
  RevealIcon,
  SendIcon,
} from "@preman/desktop/renderer/ui/icons.js";

/** Must equal `--spacing-row` in app.css. Fixed, so the virtualizer needs no measurement pass. */
const ROW_HEIGHT = 28;

/** Rows rendered above and below the viewport. Three is enough to hide a fast flick at 28px. */
const OVERSCAN = 8;

/** Indent per depth level. 12px reads as a level without pushing deep names off the pane. */
const INDENT_PX = 12;

/** The chevron column, reserved on every row so names line up whether or not one is drawn. */
const CHEVRON_PX = 16;
/**
 * The verb column, sized for `DELETE`. It sits to the left of the name, where Postman puts it,
 * so the eye reads protocol then name in one movement instead of travelling to a ragged right edge.
 * Group icons share the width so every name in the tree starts at the same x.
 */
const LABEL_COLUMN_PX = 42;

const NO_TARGET = null;

const UNSUPPORTED_LABEL = "n/a";
const GRPC_LABEL = "gRPC";

/** Verb to token. A row cannot invent a colour, and an unknown verb falls through to plain ink. */
const METHOD_CLASS: Record<string, string> = {
  GET: "text-method-get",
  POST: "text-method-post",
  PUT: "text-method-put",
  PATCH: "text-method-patch",
  DELETE: "text-method-delete",
};

const selectVisible = (state: CatalogState) => state.visibleIds;
const selectRoot = (state: CatalogState) => state.root;

export interface SidebarProps {
  readonly onOpen: (node: CatalogNode) => void;
  readonly onSend: (node: CatalogNode) => void;
  readonly onCreateRequest: (parentId: string, kind: RequestKind) => void;
  readonly onCreateFolder: (parentId: string) => void;
  readonly onRename: (node: CatalogNode) => void;
  readonly onDelete: (node: CatalogNode) => void;
  readonly onReveal: (node: CatalogNode) => void;
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

  const virtualizer = useVirtualizer({
    count: visibleIds.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (index) => visibleIds[index] ?? index,
  });

  const captureTarget = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
    setTargetId(row?.dataset["nodeId"] ?? NO_TARGET);
  }, []);

  if (root === null) {
    return <EmptyPane message="No workspace open." hint="Open one with Cmd+Shift+O." />;
  }

  if (visibleIds.length === 0) {
    return <EmptyPane message="This workspace has no requests yet." hint="Right-click to add a collection." />;
  }

  return (
    <ContextMenu>
      <ContextTrigger className="min-h-0 flex-1">
        <div
          ref={scrollRef}
          onContextMenu={captureTarget}
          className="h-full overflow-x-hidden overflow-y-auto overscroll-contain"
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => (
              <Row key={item.key} nodeId={visibleIds[item.index] ?? ""} top={item.start} onOpen={props.onOpen} />
            ))}
          </div>
        </div>
      </ContextTrigger>
      <SidebarContextMenu targetId={targetId} {...props} />
    </ContextMenu>
  );
}

/**
 * One row. Subscribed by id, so a selection change repaints the row that lost it and the row that
 * gained it. Absolutely positioned by the virtualizer's offset rather than laid out in flow,
 * because a transform per row is one composite and a reflow per row is not.
 */
function Row({
  nodeId,
  top,
  onOpen,
}: {
  readonly nodeId: string;
  readonly top: number;
  readonly onOpen: (node: CatalogNode) => void;
}) {
  const node = useNode(nodeId);
  const selected = useIsSelected(nodeId);
  const collapsed = useIsCollapsed(nodeId);

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
      data-node-id={nodeId}
      role="treeitem"
      aria-level={node.depth + 1}
      aria-selected={selected}
      aria-expanded={group ? !collapsed : undefined}
      tabIndex={-1}
      onClick={activate}
      className={cn(
        "absolute inset-x-0 flex h-row items-center gap-1.5 pr-gutter",
        selected ? "bg-selected" : "hover:bg-hover",
      )}
      style={{ top, paddingLeft: node.depth * INDENT_PX }}
    >
      <span className="flex shrink-0 items-center justify-center" style={{ width: CHEVRON_PX }}>
        {group ? (
          collapsed ? (
            <CaretRightIcon className="text-glyph" />
          ) : (
            <CaretDownIcon className="text-glyph" />
          )
        ) : null}
      </span>

      {/* One fixed column for both, so every name in the tree starts at the same x. */}
      <span className="flex shrink-0 items-center justify-end overflow-hidden" style={{ width: LABEL_COLUMN_PX }}>
        {group ? <NodeIcon node={node} collapsed={collapsed} /> : <MethodLabel node={node} />}
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
    </div>
  );
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
  return (
    <span className={cn("font-mono text-2xs uppercase", METHOD_CLASS[node.label] ?? "text-ink-dim")}>{node.label}</span>
  );
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
