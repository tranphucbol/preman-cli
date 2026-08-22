/**
 * The window.
 *
 * One title bar, one sidebar, one editor pane. The layout never moves: the workspace picker is
 * always top-left, the environment picker always top-right, the URL bar always in the same
 * place. That is not conservatism, it is the point. A tool you reach for fifty times a day
 * should be muscle memory by the third day, and asymmetry that reads as designed on a landing
 * page reads as a bug here.
 */
import { useCallback, useEffect, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";

import type { CatalogNode } from "@preman/desktop/engine/protocol.js";

import { AskDialog, type Ask } from "@preman/desktop/renderer/ui/Dialog.js";
import { Button, IconButton, Select, TooltipProvider } from "@preman/desktop/renderer/ui/Controls.js";
import {
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
  DropdownTrigger,
} from "@preman/desktop/renderer/ui/Menu.js";
import {
  CollectionIcon,
  ICON_DEFAULTS,
  IconContext,
  NewFolderIcon,
  PickerIcon,
  WarningIcon,
} from "@preman/desktop/renderer/ui/icons.js";
import { RequestEditor } from "@preman/desktop/renderer/panes/RequestEditor.js";
import { Sidebar } from "@preman/desktop/renderer/panes/Sidebar.js";
import { TabStrip } from "@preman/desktop/renderer/panes/TabStrip.js";
import {
  cancelRun,
  closeTab,
  discardAndClose,
  mutate,
  saveTab,
  sendNode,
  type Failure,
} from "@preman/desktop/renderer/actions.js";
import {
  connect,
  loadTab,
  openWorkspaceDialog,
  refreshWorkspaces,
  switchWorkspace,
  useSessionStore,
} from "@preman/desktop/renderer/stores/session.js";
import { useTabsStore } from "@preman/desktop/renderer/stores/tabs.js";
import { useCatalogStore } from "@preman/desktop/renderer/stores/catalog.js";
import { useRunsStore } from "@preman/desktop/renderer/stores/runs.js";

const SIDEBAR_ID = "sidebar";
const EDITOR_ID = "editor";
const LAYOUT_ID = "preman:panes";
/** Strings without units are percentages in react-resizable-panels v4. */
const SIDEBAR_DEFAULT = "22";
const SIDEBAR_MIN = "14";
const SIDEBAR_MAX = "40";
const NO_ENVIRONMENT = "";

export function App(): React.JSX.Element {
  useEffect(connect, []);
  useEffect(() => {
    void refreshWorkspaces();
  }, []);

  const [ask, setAsk] = useState<Ask | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const dismissFailure = useCallback(() => {
    setFailure(null);
  }, []);

  useSaveAndSendKeys(setFailure);

  // The library owns pane persistence, which keeps one more thing out of the app-data store.
  const layout = useDefaultLayout({ id: LAYOUT_ID, panelIds: [SIDEBAR_ID, EDITOR_ID], storage: localStorage });

  return (
    <IconContext.Provider value={ICON_DEFAULTS}>
      <TooltipProvider>
        <div className="flex h-full flex-col">
          <TitleBar />
          <HostBanner />
          <DegradedBanner />
          <FailureBanner failure={failure} onDismiss={dismissFailure} />
          <Group
            orientation="horizontal"
            className="min-h-0 flex-1"
            defaultLayout={layout.defaultLayout}
            onLayoutChanged={layout.onLayoutChanged}
          >
            <Panel
              id={SIDEBAR_ID}
              defaultSize={SIDEBAR_DEFAULT}
              minSize={SIDEBAR_MIN}
              maxSize={SIDEBAR_MAX}
              className="flex min-w-0 flex-col bg-panel"
            >
              <WorkspaceTree onAsk={setAsk} onFail={setFailure} />
            </Panel>
            {/*
              One hairline, with the hit area spilling either side of it. A visible 4px gutter
              between two panes is 4px of nothing, fifty times a day.
            */}
            <Separator className="group relative z-handle w-px shrink-0 cursor-col-resize bg-line data-[state=drag]:bg-accent">
              <span className="absolute -inset-x-1 inset-y-0 group-hover:bg-accent/40" />
            </Separator>
            <Panel id={EDITOR_ID} className="flex min-w-0 flex-col">
              <EditorPane onAsk={setAsk} onFail={setFailure} />
            </Panel>
          </Group>
        </div>
        <AskDialog
          ask={ask}
          onClose={() => {
            setAsk(null);
          }}
        />
      </TooltipProvider>
    </IconContext.Provider>
  );
}

/**
 * Cmd+S saves, Cmd+Enter sends, both bound at the window rather than in the editor.
 *
 * At the window because they must work with focus in the sidebar, in a header cell, or in
 * CodeMirror, and CodeMirror swallows keys it has a binding for.
 */
function useSaveAndSendKeys(onFail: (failure: Failure | null) => void): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!event.metaKey && !event.ctrlKey) return;
      const activeId = useTabsStore.getState().activeId;
      if (activeId === null) return;

      if (event.key === "s") {
        event.preventDefault();
        const tab = useTabsStore.getState().tabs.get(activeId);
        if (tab !== undefined) void saveTab(tab).then(onFail);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        void sendNode(activeId).then(onFail);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onFail]);
}

function TitleBar(): React.JSX.Element {
  return (
    <header className="flex h-tab shrink-0 items-center gap-2 border-b border-line bg-canvas px-2">
      <WorkspacePicker />
      <div className="flex-1" />
      <EnvironmentPicker />
    </header>
  );
}

function WorkspacePicker(): React.JSX.Element {
  const workspaces = useSessionStore((state) => state.workspaces);
  const root = useSessionStore((state) => state.root);
  const active = workspaces.find((workspace) => workspace.root === root);

  return (
    <DropdownMenu>
      <DropdownTrigger>
        <button
          type="button"
          className="flex h-control items-center gap-1.5 rounded-sm px-1.5 text-xs text-ink hover:bg-hover"
        >
          <CollectionIcon />
          <span className="max-w-48 truncate font-medium">{active?.name ?? "No workspace"}</span>
          <PickerIcon className="text-glyph" />
        </button>
      </DropdownTrigger>
      <DropdownContent>
        {workspaces.length > 0 && <DropdownLabel>Recent</DropdownLabel>}
        {workspaces.map((workspace) => (
          <DropdownItem
            key={workspace.root}
            onSelect={() => {
              void switchWorkspace(workspace.root);
            }}
          >
            {workspace.name}
          </DropdownItem>
        ))}
        {workspaces.length > 0 && <DropdownSeparator />}
        <DropdownItem
          shortcut="⌘⇧O"
          onSelect={() => {
            void openWorkspaceDialog();
          }}
        >
          Open workspace…
        </DropdownItem>
      </DropdownContent>
    </DropdownMenu>
  );
}

/**
 * The environment selector.
 *
 * Top-right, matching Postman, and a plain select rather than a menu because it is a choice
 * from a short list with no actions attached to it.
 *
 * There is deliberately no "No environment" entry. Core has no way to say "explicitly none": an
 * absent `env` means "you pick", so the option would either be a lie (one environment, silently
 * used) or a dead end (several, and the run fails on ambiguity). The placeholder only appears
 * while a choice is genuinely outstanding.
 */
function EnvironmentPicker(): React.JSX.Element | null {
  const environments = useCatalogStore((state) => state.environments);
  const environment = useSessionStore((state) => state.environment);
  const setEnvironment = useSessionStore((state) => state.setEnvironment);

  if (environments.length === 0) return null;

  return (
    <Select
      aria-label="Environment"
      value={environment ?? NO_ENVIRONMENT}
      onChange={(event) => {
        setEnvironment(event.target.value === NO_ENVIRONMENT ? null : event.target.value);
      }}
    >
      {environment === null && <option value={NO_ENVIRONMENT}>Select environment</option>}
      {environments.map((candidate) => (
        <option key={candidate.file} value={candidate.name}>
          {candidate.name}
        </option>
      ))}
    </Select>
  );
}

type Fail = (failure: Failure | null) => void;

function WorkspaceTree({
  onAsk,
  onFail,
}: {
  readonly onAsk: (ask: Ask) => void;
  readonly onFail: Fail;
}): React.JSX.Element {
  const root = useCatalogStore((state) => state.root);

  function askName(title: string, submit: string, initial: string, onConfirm: (name: string) => void): void {
    onAsk({ kind: "name", title, label: "Name", initial, submit, onConfirm });
  }

  function open(node: CatalogNode): void {
    useTabsStore.getState().open({ id: node.id, name: node.name, kind: node.kind });
    void loadTab(node.id);
  }

  return (
    <>
      <div className="flex h-tab shrink-0 items-center gap-1 border-b border-line px-2">
        {/* Sentence case. Uppercase wide-tracking labels are a decoration this pane has not earned. */}
        <span className="text-xs font-medium text-ink-dim">Collections</span>
        <div className="flex-1" />
        <IconButton
          label="New collection"
          disabled={root === null}
          onClick={() => {
            askName("New collection", "Create", "", (name) => {
              void mutate({ op: "create-collection", name }).then(onFail);
            });
          }}
        >
          <NewFolderIcon />
        </IconButton>
      </div>
      <Sidebar
        onOpen={open}
        onSend={(node) => {
          open(node);
          void sendNode(node.id).then(onFail);
        }}
        onCreateRequest={(parentId, kind) => {
          askName(kind === "grpc-request" ? "New gRPC request" : "New HTTP request", "Create", "", (name) => {
            void mutate({ op: "create-request", parentId, name, kind }, { open: true }).then(onFail);
          });
        }}
        onCreateFolder={(parentId) => {
          askName("New folder", "Create", "", (name) => {
            void mutate({ op: "create-folder", parentId, name }).then(onFail);
          });
        }}
        onRename={(node) => {
          askName(`Rename ${node.name}`, "Rename", node.name, (name) => {
            void mutate({ op: "rename", targetId: node.id, name }).then(onFail);
          });
        }}
        onDelete={(node) => {
          onAsk({
            kind: "confirm",
            title: `Delete ${node.name}?`,
            body: deleteWarning(node),
            submit: "Delete",
            onConfirm: () => {
              void mutate({ op: "delete", targetId: node.id }).then(onFail);
            },
          });
        }}
        onReveal={(node) => {
          void window.preman.revealInFileManager(node.file);
        }}
      />
    </>
  );
}

/** Says what is actually about to happen, including that git is the only undo. */
function deleteWarning(node: CatalogNode): string {
  return node.kind === "request"
    ? "The request file is removed from disk. preman has no undo for this, so recover it with git if you need to."
    : "The directory and everything inside it is removed from disk. preman has no undo for this, so recover it with git if you need to.";
}

function EditorPane({
  onAsk,
  onFail,
}: {
  readonly onAsk: (ask: Ask) => void;
  readonly onFail: Fail;
}): React.JSX.Element {
  const tab = useTabsStore((state) => (state.activeId === null ? undefined : state.tabs.get(state.activeId)));
  const nodeId = tab?.nodeId;
  const run = useRunsStore((state) => {
    if (nodeId === undefined) return undefined;
    return [...state.requests.values()].find((request) => request.nodeId === nodeId && request.status === "running");
  });

  return (
    <>
      <TabStrip
        onClose={(id) => {
          // `closeTab` closes a clean tab outright and hands back a dirty one, so the only tab
          // that ever reaches a dialog is a tab with work in it.
          const unsaved = closeTab(id);
          if (unsaved === null) return;
          onAsk({
            kind: "confirm",
            title: `Close ${unsaved.title}?`,
            body: "This request has unsaved changes. Closing the tab discards them.",
            submit: "Discard changes",
            onConfirm: () => {
              discardAndClose(id);
            },
          });
        }}
      />
      {tab === undefined ? (
        <EmptyEditor />
      ) : (
        <RequestEditor
          tab={tab}
          running={run !== undefined}
          onSend={() => {
            void sendNode(tab.nodeId).then(onFail);
          }}
          onCancel={() => {
            if (run !== undefined) void cancelRun(run.runId).then(onFail);
          }}
          onSave={() => {
            void saveTab(tab).then(onFail);
          }}
        />
      )}
    </>
  );
}

function EmptyEditor(): React.JSX.Element {
  return (
    <div className="grid flex-1 place-items-center p-8">
      <div className="max-w-xs text-center">
        <p className="text-sm text-ink-dim">No request open.</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-faint">
          Pick one from the sidebar, or press Cmd+Shift+O to open a workspace.
        </p>
      </div>
    </div>
  );
}

function HostBanner(): React.JSX.Element | null {
  const hostFailure = useSessionStore((state) => state.hostFailure);
  if (hostFailure === null) return null;
  return (
    <Banner tone="danger" message={hostFailure.message} details={hostFailure.details}>
      <Button
        onClick={() => {
          void switchWorkspace(hostFailure.root);
        }}
      >
        Retry
      </Button>
    </Banner>
  );
}

function DegradedBanner(): React.JSX.Element | null {
  const degraded = useSessionStore((state) => state.degraded);
  const setDegraded = useSessionStore((state) => state.setDegraded);
  if (degraded === null) return null;
  return (
    <Banner tone="warn" message={degraded} details={[]}>
      <Button
        onClick={() => {
          setDegraded(null);
        }}
      >
        Dismiss
      </Button>
    </Banner>
  );
}

function FailureBanner({
  failure,
  onDismiss,
}: {
  readonly failure: Failure | null;
  readonly onDismiss: () => void;
}): React.JSX.Element | null {
  if (failure === null) return null;
  return (
    <Banner tone="danger" message={failure.message} details={failure.details}>
      <Button onClick={onDismiss}>Dismiss</Button>
    </Banner>
  );
}

/**
 * One banner shape for every failure.
 *
 * `details` is rendered rather than summarised because it is carried the whole way from core's
 * `PremanError`, the CLI prints it, and a GUI that drops it is worse than the CLI.
 */
function Banner({
  tone,
  message,
  details,
  children,
}: {
  readonly tone: "danger" | "warn";
  readonly message: string;
  readonly details: readonly string[];
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const palette =
    tone === "danger" ? "border-danger/30 bg-danger/10 text-danger" : "border-warn/30 bg-warn/10 text-warn";
  return (
    <div role="alert" className={`flex shrink-0 items-start gap-2 border-b px-3 py-2 text-xs ${palette}`}>
      <span className="mt-0.5 shrink-0">
        <WarningIcon />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{message}</p>
        {details.map((detail) => (
          <p key={detail} className="mt-0.5 leading-relaxed text-ink-dim">
            {detail}
          </p>
        ))}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
