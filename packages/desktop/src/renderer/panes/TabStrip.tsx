/**
 * The open-request tabs.
 *
 * Two things here are deliberate. A tab shows its method label because the whole point of
 * having six tabs open is telling them apart at a glance, and half of a Postman workspace is
 * the same noun under four verbs. And the dirty marker is a dot in the close button's place,
 * swapping to the cross on hover, because a tab that shows both is a tab with two targets
 * two pixels apart.
 */
import type { MouseEvent } from "react";

import { CloseIcon } from "@preman/desktop/renderer/ui/icons.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { isDirty, useTabsStore, type Tab } from "@preman/desktop/renderer/stores/tabs.js";
import { useNode } from "@preman/desktop/renderer/stores/catalog.js";

const MIDDLE_BUTTON = 1;
const UNSUPPORTED_LABEL = "n/a";

const METHOD_CLASS: Record<string, string> = {
  GET: "text-method-get",
  POST: "text-method-post",
  PUT: "text-method-put",
  PATCH: "text-method-patch",
  DELETE: "text-method-delete",
};

/** The strip is chrome: it stays put while the pane below it scrolls. */
const STRIP_CLASS = "flex h-tab shrink-0 items-stretch overflow-x-auto border-b border-line bg-canvas";

const TAB_CLASS = "group flex h-full min-w-32 max-w-56 shrink-0 items-center gap-1.5 border-r border-line px-2 text-xs";

/**
 * `onClose` rather than the store's own `close`: an unsaved tab has to be asked about, and the
 * strip is the wrong place to own a dialog. It reports the intent; the app decides.
 */
export function TabStrip({ onClose }: { readonly onClose: (nodeId: string) => void }): React.JSX.Element | null {
  const order = useTabsStore((state) => state.order);
  const activeId = useTabsStore((state) => state.activeId);

  if (order.length === 0) return null;

  return (
    <div className={STRIP_CLASS} role="tablist" aria-label="Open requests">
      {order.map((nodeId) => (
        <TabButton key={nodeId} nodeId={nodeId} active={nodeId === activeId} onClose={onClose} />
      ))}
    </div>
  );
}

function TabButton({
  nodeId,
  active,
  onClose,
}: {
  readonly nodeId: string;
  readonly active: boolean;
  readonly onClose: (nodeId: string) => void;
}): React.JSX.Element | null {
  const tab = useTabsStore((state) => state.tabs.get(nodeId));
  const activate = useTabsStore((state) => state.activate);

  if (tab === undefined) return null;

  // Middle click closes, which every editor with tabs has taught people to expect.
  function onMouseDown(event: MouseEvent<HTMLDivElement>): void {
    if (event.button === MIDDLE_BUTTON) {
      event.preventDefault();
      onClose(nodeId);
    }
  }

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onMouseDown={onMouseDown}
      onClick={() => {
        activate(nodeId);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") activate(nodeId);
      }}
      className={cn(TAB_CLASS, active ? "bg-panel text-ink" : "bg-canvas text-ink-dim hover:bg-hover hover:text-ink")}
    >
      <TabLabel nodeId={nodeId} title={tab.title} />
      <span className="truncate">{tab.title}</span>
      <CloseButton tab={tab} onClose={onClose} />
    </div>
  );
}

/**
 * The label comes from the catalog rather than the tab, so renaming a method in the editor
 * relabels its tab as soon as the file is saved and the catalog comes back.
 *
 * A label that only repeats the title is dropped. For gRPC the label is the last segment of the
 * method path, and naming a request after the RPC it calls is the obvious thing to do, so the
 * common case would otherwise read "Echo Echo" in a strip whose whole job is telling tabs apart.
 * When the two differ the label is real information and stays.
 */
function TabLabel({ nodeId, title }: { readonly nodeId: string; readonly title: string }): React.JSX.Element | null {
  const node = useNode(nodeId);
  if (node?.label === undefined) return null;
  if (node.label.toLowerCase() === title.toLowerCase()) return null;
  if (node.protocol === "unsupported") {
    return <span className="shrink-0 font-mono text-2xs text-ink-faint">{UNSUPPORTED_LABEL}</span>;
  }
  if (node.protocol === "grpc") {
    return <span className="max-w-20 shrink-0 truncate font-mono text-2xs text-method-grpc">{node.label}</span>;
  }
  return (
    <span className={cn("shrink-0 font-mono text-2xs uppercase", METHOD_CLASS[node.label] ?? "text-ink-dim")}>
      {node.label}
    </span>
  );
}

function CloseButton({
  tab,
  onClose,
}: {
  readonly tab: Tab;
  readonly onClose: (nodeId: string) => void;
}): React.JSX.Element {
  const dirty = isDirty(tab);
  return (
    <button
      type="button"
      aria-label={dirty ? `Close ${tab.title}, unsaved` : `Close ${tab.title}`}
      onClick={(event) => {
        event.stopPropagation();
        onClose(tab.nodeId);
      }}
      className="ml-auto grid size-4 shrink-0 place-items-center rounded-xs text-glyph hover:bg-line-strong hover:text-ink"
    >
      {dirty ? <DirtyDot /> : <CloseIcon />}
    </button>
  );
}

/**
 * Hand-drawn rather than an icon-library glyph because it is a 5px filled disc, not a symbol,
 * and it swaps to the real cross on hover.
 */
function DirtyDot(): React.JSX.Element {
  return (
    <>
      <span className="size-1.5 rounded-full bg-accent group-hover:hidden" />
      <span className="hidden group-hover:block">
        <CloseIcon />
      </span>
    </>
  );
}
