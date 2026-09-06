/**
 * The rows above every open document, and the three states a document can be in instead.
 *
 * These were `RequestEditor`'s until a group became something you can open too. None of them knows
 * what kind of document it is sitting above: where the file lives, that it moved under us, that it
 * is gone, that it is still loading, that it would not parse - a folder's definition and a request
 * answer all five the same way, so the answer is written once here rather than twice.
 */

import { Fragment, type ReactNode } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { loadTab } from "@preman/desktop/renderer/stores/session.js";
import { useAncestors, useNode } from "@preman/desktop/renderer/stores/catalog.js";
import { useTabsStore, type SubTab, type Tab } from "@preman/desktop/renderer/stores/tabs.js";
import { Button } from "@preman/desktop/renderer/ui/Controls.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { CaretRightIcon, CollectionIcon, GLYPH_CLASS, WarningIcon } from "@preman/desktop/renderer/ui/icons.js";
import { BANNER_MOTION, Banner } from "@preman/desktop/renderer/ui/Banner.js";
import { AnimatePresence, m } from "@preman/desktop/renderer/ui/motion.js";

const ORPHANED_MESSAGE = "This file is gone from disk. Saving will write it back.";
const CHANGED_ON_DISK = "This file changed on disk while you were editing it.";
const DELETED_ON_DISK = "This file was deleted while you were editing it.";

/** Where the open document is, and whatever is currently wrong with it. */
export function DocumentChrome({ tab }: { readonly tab: Tab }) {
  return (
    <>
      <Breadcrumb nodeId={tab.nodeId} />
      <AnimatePresence>
        {tab.conflicted ? <ConflictBanner nodeId={tab.nodeId} orphaned={tab.orphaned} /> : null}
      </AnimatePresence>
      <AnimatePresence>
        {tab.orphaned ? <Banner tone="danger" message={ORPHANED_MESSAGE} detail={tab.saved?.file ?? ""} /> : null}
      </AnimatePresence>
    </>
  );
}

/**
 * Where this document lives, above the bar that acts on it.
 *
 * The tab strip can only afford the name, and a workspace has four requests called `Create` in
 * four collections. This is the row that says which one is open - the same answer the sidebar
 * gives by position, written out for the times the sidebar is scrolled somewhere else or shut.
 *
 * Read-only on purpose. Postman makes the crumbs links, but a click target in the row directly
 * above Send, on a name that is also a directory on disk, buys a navigation the sidebar already
 * does and risks a rename nobody asked for.
 *
 * Renders nothing once the node is gone: an orphaned tab has a banner two rows down that says so
 * properly, and a breadcrumb pointing into a tree that no longer contains it would be a lie.
 */
function Breadcrumb({ nodeId }: { readonly nodeId: string }) {
  const node = useNode(nodeId);
  const ancestors = useAncestors(nodeId);
  if (node === undefined) return null;

  return (
    <nav
      aria-label="Location"
      className="flex h-tab shrink-0 items-center gap-1.5 border-b border-line px-gutter text-sm"
    >
      <CollectionIcon className="shrink-0 text-ink-dim" />
      {ancestors.map((crumb) => (
        <Fragment key={crumb.id}>
          <span className="min-w-0 truncate text-ink-dim">{crumb.name}</span>
          <CaretRightIcon className={cn("shrink-0", GLYPH_CLASS)} />
        </Fragment>
      ))}
      <span className="min-w-0 truncate font-medium text-ink">{node.name}</span>
    </nav>
  );
}

/**
 * `orphaned` removes `Take theirs`, because on a file that is gone there is no theirs to take: the
 * button would discard the edits and then fail the re-read, so the one press that cannot be undone
 * would also be the one that achieves nothing. `Keep mine` stays, and the orphan banner below this
 * one says what saving would then do.
 */
function ConflictBanner({ nodeId, orphaned }: { readonly nodeId: string; readonly orphaned: boolean }) {
  return (
    // Its own bar rather than a `Banner`, because it offers two answers to a question rather than
    // the one action a `Banner` takes, and they sit centred against a single line instead of top-
    // aligned against a stack. It arrives the same way, or the two bars stacked here would
    // disagree about what a notice is.
    <m.div
      {...BANNER_MOTION}
      className="flex shrink-0 items-center gap-2 border-b border-warn/40 bg-warn/10 px-gutter py-1.5"
    >
      <WarningIcon className="shrink-0 text-warn" />
      <span className="text-xs text-ink">{orphaned ? DELETED_ON_DISK : CHANGED_ON_DISK}</span>
      <div className="ml-auto flex gap-1.5">
        {orphaned ? null : (
          <Button
            onClick={() => {
              // Discard first, so the re-read is not itself treated as a conflict.
              useTabsStore.getState().discard(nodeId);
              void loadTab(nodeId);
            }}
          >
            Take theirs
          </Button>
        )}
        <Button
          onClick={() => {
            useTabsStore.getState().keepMine(nodeId);
          }}
        >
          Keep mine
        </Button>
      </div>
    </m.div>
  );
}

/** A sub-tab's content, sized to the frame so the pane inside it can scroll. */
export function SubTabPane({ value, children }: { readonly value: SubTab; readonly children: ReactNode }) {
  return (
    <Tabs.Content value={value} className="flex min-h-0 flex-1 flex-col focus:outline-none">
      {children}
    </Tabs.Content>
  );
}

export function Notice({ message }: { readonly message: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-gutter">
      <p className="text-xs text-ink-faint">{message}</p>
    </div>
  );
}

/** Named for what it is rather than `Failure`, which `actions.ts` already uses for the type. */
export function LoadFailure({ title, details }: { readonly title: string; readonly details: readonly string[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-gutter">
      <p className="text-xs text-danger">{title}</p>
      {details.map((line) => (
        <p key={line} className="font-mono text-2xs text-ink-dim">
          {line}
        </p>
      ))}
    </div>
  );
}
