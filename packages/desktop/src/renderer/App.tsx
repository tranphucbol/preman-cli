/**
 * The window.
 *
 * One title bar, one sidebar, one editor pane. The layout never moves: the workspace picker is
 * always top-left, the environment picker always top-right, the URL bar always in the same
 * place. That is not conservatism, it is the point. A tool you reach for fifty times a day
 * should be muscle memory by the third day, and asymmetry that reads as designed on a landing
 * page reads as a bug here.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout, usePanelCallbackRef } from "react-resizable-panels";

import type { CatalogNode, GrepMatch } from "@preman/desktop/engine/protocol.js";

import { AskDialog, type Ask } from "@preman/desktop/renderer/ui/Dialog.js";
import { Button, IconButton, Select, SelectOption, TooltipProvider } from "@preman/desktop/renderer/ui/Controls.js";
import {
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
  DropdownTrigger,
} from "@preman/desktop/renderer/ui/Menu.js";
import {
  BranchIcon,
  CollectionIcon,
  ConsoleIcon,
  EnvironmentIcon,
  ICON_DEFAULTS,
  IconContext,
  NewFolderIcon,
  PickerIcon,
  SearchIcon,
  SettingsIcon,
  WarningIcon,
} from "@preman/desktop/renderer/ui/icons.js";
import { BANNER_MOTION } from "@preman/desktop/renderer/ui/Banner.js";
import { AnimatePresence, MotionRoot, m } from "@preman/desktop/renderer/ui/motion.js";
import { CommandPalette } from "@preman/desktop/renderer/panes/CommandPalette.js";
import { ConsoleDrawer } from "@preman/desktop/renderer/panes/ConsoleDrawer.js";
import { RequestEditor } from "@preman/desktop/renderer/panes/RequestEditor.js";
import { ResponsePane } from "@preman/desktop/renderer/panes/ResponsePane.js";
import { RunnerPane } from "@preman/desktop/renderer/panes/RunnerPane.js";
import { SearchPane } from "@preman/desktop/renderer/panes/SearchPane.js";
import { SettingsPane } from "@preman/desktop/renderer/panes/SettingsPane.js";
import { Sidebar } from "@preman/desktop/renderer/panes/Sidebar.js";
import { TabStrip } from "@preman/desktop/renderer/panes/TabStrip.js";
import { VariablesPane } from "@preman/desktop/renderer/panes/VariablesPane.js";
import { paletteItems, type PaletteItem } from "@preman/desktop/renderer/model/palette.js";
import { sectionFor } from "@preman/desktop/renderer/model/search.js";
import {
  applyPlan,
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
  createNewWorkspace,
  loadTab,
  openWorkspaceDialog,
  refreshWorkspaces,
  switchWorkspace,
  useSessionStore,
} from "@preman/desktop/renderer/stores/session.js";
import { useTabsStore } from "@preman/desktop/renderer/stores/tabs.js";
import { useCatalogStore } from "@preman/desktop/renderer/stores/catalog.js";
import { useOverlayStore, type Overlay } from "@preman/desktop/renderer/stores/overlay.js";
import { useRunsStore } from "@preman/desktop/renderer/stores/runs.js";
import { useSearchStore } from "@preman/desktop/renderer/stores/search.js";

const SIDEBAR_ID = "sidebar";
const EDITOR_ID = "editor";
const WORKSPACE_ID = "workspace";
const CONSOLE_ID = "console";
const REQUEST_ID = "request";
const RESPONSE_ID = "response";
const LAYOUT_ID = "preman:panes";
const SHELL_LAYOUT_ID = "preman:shell";
const EXCHANGE_LAYOUT_ID = "preman:exchange";
/** Strings without units are percentages in react-resizable-panels v4. */
const SIDEBAR_DEFAULT = "22";
const SIDEBAR_MIN = "14";
const SIDEBAR_MAX = "40";
/** The drawer starts shut, and opening it is one click on the footer. */
const CONSOLE_COLLAPSED = 0;
const CONSOLE_OPEN = "30";
const CONSOLE_MIN = "12";
const REQUEST_DEFAULT = "55";
const REQUEST_MIN = "20";
const RESPONSE_MIN = "15";
/**
 * The explicit "none" the engine now accepts, which is not the same as nobody having chosen.
 *
 * A NUL prefix rather than the empty string it used to be, for two reasons that agree: Radix
 * reserves `""` for "nothing is selected", which is the very state this value has to be distinct
 * from, and NUL is the one character a name read out of a file on disk cannot contain, so neither
 * sentinel can ever collide with a real environment.
 */
const NO_ENVIRONMENT = "\u0000none";
/** The placeholder's own value, so it can never be mistaken for the choice above. */
const UNCHOSEN_ENVIRONMENT = "\u0000unchosen";

/**
 * What the palette can do besides jumping to a request.
 *
 * Mostly things the window carries out with no further questions, and "New collection" is still
 * deliberately absent: the sidebar's own button is a click away from the tree it acts on.
 * `Create new workspace…` is the one prompt here, because creating a workspace has no home in the
 * tree - there is no workspace yet - so the palette, the File menu and the workspace dropdown are
 * all it has. The palette closes first, then the naming dialog opens.
 */
const PALETTE_COMMANDS: readonly PaletteItem[] = [
  { kind: "command", id: "search", label: "Search the workspace", detail: "⌘⇧F" },
  { kind: "command", id: "variables", label: "Variables", detail: "command" },
  { kind: "command", id: "console", label: "Toggle console", detail: "command" },
  { kind: "command", id: "save", label: "Save", detail: "⌘S" },
  { kind: "command", id: "send", label: "Send", detail: "⌘↵" },
  { kind: "command", id: "open-workspace", label: "Open workspace…", detail: "⌘⇧O" },
  { kind: "command", id: "create-workspace", label: "Create new workspace…", detail: "command" },
  { kind: "command", id: "settings", label: "Settings", detail: "⌘," },
];

/** The naming dialog creation opens, from all three of its entry points. */
const CREATE_WORKSPACE_ASK = {
  kind: "name",
  title: "Create new workspace",
  label: "Name",
  initial: "",
  submit: "Create",
  // Assignable because `CreateWorkspaceResult`'s success arm carries a `root` the dialog ignores:
  // it waits for `ok`, and the store has already switched the window by the time it sees one.
  onConfirm: createNewWorkspace,
} as const satisfies Ask;

export function App(): React.JSX.Element {
  useEffect(connect, []);
  useEffect(() => {
    void refreshWorkspaces();
  }, []);
  // The app menu's own Settings item. It cannot open the pane itself — the menu lives in the main
  // process and the pane is a piece of renderer state — so it sends, and this is where it lands.
  useEffect(() => window.preman.onOpenSettings(useOverlayStore.getState().showSettings), []);

  const [ask, setAsk] = useState<Ask | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const dismissFailure = useCallback(() => {
    setFailure(null);
  }, []);
  const dismissPalette = useCallback(() => {
    setPaletteOpen(false);
  }, []);

  // One callback for the dropdown, the File menu and the palette. Three ways in, one dialog: a
  // second copy of this would eventually be the copy that opened a differently-worded prompt.
  const showCreateWorkspace = useCallback(() => {
    setAsk(CREATE_WORKSPACE_ASK);
  }, []);
  // Same shape as Settings above, and for the same reason: the menu lives in the main process and
  // the dialog is renderer state, so the menu sends and this is where it lands.
  useEffect(() => window.preman.onCreateWorkspace(showCreateWorkspace), [showCreateWorkspace]);

  // The library owns pane persistence, which keeps one more thing out of the app-data store.
  const layout = useDefaultLayout({ id: LAYOUT_ID, panelIds: [SIDEBAR_ID, EDITOR_ID], storage: localStorage });
  const shell = useDefaultLayout({ id: SHELL_LAYOUT_ID, panelIds: [WORKSPACE_ID, CONSOLE_ID], storage: localStorage });

  /*
   * The console drawer is always mounted and collapsed to nothing, never conditionally
   * rendered. A panel that unmounts loses its size, so every reopen would guess a new one;
   * collapsing keeps the drawer's height across a whole session and across restarts.
   *
   * `resize` rather than `expand`: `expand` restores the panel's most recent size, and on the
   * first open of a fresh install there is no such size to restore.
   */
  const [consolePanel, setConsolePanel] = usePanelCallbackRef();
  const [consoleOpen, setConsoleOpen] = useState(false);
  const toggleConsole = useCallback(() => {
    if (consolePanel === null) return;
    if (consolePanel.isCollapsed()) consolePanel.resize(CONSOLE_OPEN);
    else consolePanel.collapse();
  }, [consolePanel]);

  useShortcuts(setFailure, setPaletteOpen);

  const runCommand = useCallback(
    (id: string) => {
      switch (id) {
        case "search":
          useSearchStore.getState().show();
          return;
        case "variables":
          useOverlayStore.getState().showVariables();
          return;
        case "console":
          toggleConsole();
          return;
        case "save":
          void saveActiveTab().then(setFailure);
          return;
        case "send":
          void sendActiveTab().then(setFailure);
          return;
        case "open-workspace":
          void openWorkspaceDialog();
          return;
        case "create-workspace":
          showCreateWorkspace();
          return;
        case "settings":
          useOverlayStore.getState().showSettings();
          return;
      }
    },
    [showCreateWorkspace, toggleConsole],
  );

  return (
    <IconContext.Provider value={ICON_DEFAULTS}>
      <TooltipProvider>
        {/* Motion's boundary sits inside the tooltip provider and outside everything else, so
         * both presence surfaces are within it and neither Radix nor a pane has to know it is
         * there. Decision 26. */}
        <MotionRoot>
          <div className="flex h-full flex-col">
            <TitleBar onCreateWorkspace={showCreateWorkspace} />
            <HostBanner />
            <DegradedBanner />
            <FailureBanner failure={failure} onDismiss={dismissFailure} />
            <Group
              orientation="vertical"
              className="min-h-0 flex-1"
              defaultLayout={shell.defaultLayout}
              onLayoutChanged={shell.onLayoutChanged}
            >
              <Panel id={WORKSPACE_ID} className="flex min-h-0 flex-col">
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
              </Panel>
              <Separator className="group relative z-handle h-px shrink-0 cursor-row-resize bg-line data-[state=drag]:bg-accent">
                <span className="absolute inset-x-0 -inset-y-1 group-hover:bg-accent/40" />
              </Separator>
              <Panel
                id={CONSOLE_ID}
                collapsible
                collapsedSize={CONSOLE_COLLAPSED}
                defaultSize={CONSOLE_COLLAPSED}
                minSize={CONSOLE_MIN}
                className="flex min-h-0 flex-col"
                onResize={(size) => {
                  setConsoleOpen(size.inPixels > CONSOLE_COLLAPSED);
                }}
                panelRef={setConsolePanel}
              >
                <ConsoleDrawer onClose={toggleConsole} />
              </Panel>
            </Group>
            <StatusBar consoleOpen={consoleOpen} onToggleConsole={toggleConsole} />
          </div>
          <AskDialog
            ask={ask}
            onClose={() => {
              setAsk(null);
            }}
          />
          <Palette open={paletteOpen} onDismiss={dismissPalette} onCommand={runCommand} />
        </MotionRoot>
      </TooltipProvider>
    </IconContext.Provider>
  );
}

/**
 * The window's shortcuts, bound at the window rather than in the panes that use them.
 *
 * At the window because they must work with focus in the sidebar, in a header cell, or in
 * CodeMirror, and CodeMirror swallows keys it has a binding for.
 *
 * The palette and search do not need an open tab; save and send do, and they are the only two
 * that check. A `Cmd+K` that did nothing because no file happened to be open would be the kind
 * of shortcut people stop pressing.
 */
function useShortcuts(onFail: (failure: Failure | null) => void, onPalette: (open: boolean) => void): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!event.metaKey && !event.ctrlKey) return;

      // `key` reports the character produced, so it is `F` with shift held and `K` with caps lock
      // on. Folding the case once is the difference between a shortcut and a shortcut that works
      // unless the user left caps lock on.
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

      if (key === "k") {
        event.preventDefault();
        onPalette(true);
        return;
      }
      if (event.shiftKey && key === "f") {
        event.preventDefault();
        useSearchStore.getState().show();
        return;
      }
      // The platform shortcut for preferences on both platforms this ships to. Bound here as well
      // as in the app menu because the menu item only fires when the menu bar has the key, and on
      // Windows and Linux there is no application menu holding it.
      if (key === ",") {
        event.preventDefault();
        useOverlayStore.getState().showSettings();
        return;
      }

      const activeId = useTabsStore.getState().activeId;
      if (activeId === null) return;

      if (key === "s") {
        event.preventDefault();
        void saveActiveTab().then(onFail);
        return;
      }
      if (key === "Enter") {
        event.preventDefault();
        void sendActiveTab().then(onFail);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onFail, onPalette]);
}

/**
 * Save or send whatever is in front of the user.
 *
 * Hoisted out of the key handler because the palette invokes the same two commands, and two copies
 * of "which tab did they mean" is how one of them ends up saving a tab that is no longer active.
 */
async function saveActiveTab(): Promise<Failure | null> {
  const { activeId, tabs } = useTabsStore.getState();
  if (activeId === null) return null;
  const tab = tabs.get(activeId);
  return tab === undefined ? null : saveTab(tab);
}

async function sendActiveTab(): Promise<Failure | null> {
  const { activeId } = useTabsStore.getState();
  return activeId === null ? null : sendNode(activeId);
}

/**
 * The palette's sources, assembled here because this is the only place that has all three: the
 * catalog's requests, the catalog's environments, and the commands the window can carry out.
 */
function Palette({
  open,
  onDismiss,
  onCommand,
}: {
  readonly open: boolean;
  readonly onDismiss: () => void;
  readonly onCommand: (id: string) => void;
}): React.JSX.Element {
  const nodes = useCatalogStore((state) => state.nodes);
  const environments = useCatalogStore((state) => state.environments);
  const items = useMemo(() => paletteItems(PALETTE_COMMANDS, environments, nodes), [environments, nodes]);

  return (
    <CommandPalette
      open={open}
      items={items}
      label="Command palette"
      placeholder="Go to a request, switch environment, run a command"
      onDismiss={onDismiss}
      onChoose={(item) => {
        if (item.kind === "command") {
          onCommand(item.id);
          return;
        }
        if (item.kind === "environment") {
          useSessionStore.getState().setEnvironment(item.id);
          return;
        }
        const node = useCatalogStore.getState().byId.get(item.id);
        if (node === undefined) return;
        useCatalogStore.getState().select(node.id);
        useTabsStore.getState().open(node);
        void loadTab(node.id);
      }}
    />
  );
}

/**
 * The window's title bar, because the window has no other one.
 *
 * The whole row drags, so the two pickers opt back out: a control inside a drag region is a
 * handle, not a control. The leading gutter is whatever the window's own controls need, which on
 * a framed platform is nothing.
 *
 * The environment picker is not here. It sits in the tab bar, one row down: which environment is
 * selected is a fact about the request you are about to send, so it belongs beside the request you
 * are looking at rather than in the window's own chrome. What is left is the workspace picker,
 * which is a fact about the whole window and is the one thing that does belong here.
 *
 * `h-bar` and not `h-tab`, because the row is the one the traffic lights are centred in: its
 * height is duplicated as `TITLE_BAR_HEIGHT_PX`.
 */
function TitleBar({ onCreateWorkspace }: { readonly onCreateWorkspace: () => void }): React.JSX.Element {
  const gutter = window.preman.titleBarGutter;
  return (
    <header
      className="flex h-bar shrink-0 items-center gap-2 border-b border-line bg-canvas px-2 drag-region"
      // Unset on a framed platform, so the class's own padding stands rather than being zeroed.
      style={gutter > 0 ? { paddingLeft: gutter } : undefined}
    >
      <div className="flex items-center no-drag">
        <WorkspacePicker onCreateWorkspace={onCreateWorkspace} />
      </div>
      <div className="flex-1" />
      {/* `no-drag` is not decoration here: the whole header is a drag region, and a button inside
          one is a place the window moves from rather than a button. */}
      <div className="flex items-center no-drag">
        <IconButton
          label="Settings"
          onClick={() => {
            useOverlayStore.getState().showSettings();
          }}
        >
          <SettingsIcon />
        </IconButton>
      </div>
    </header>
  );
}

/**
 * The tab strip and the environment picker, sharing one row.
 *
 * One row and not two because they are read together: the tab says which request, the picker says
 * against what. Splitting them cost a whole row of height to say half a sentence each.
 *
 * The row is drawn here rather than inside `TabStrip` for two reasons. The strip scrolls
 * horizontally and the picker must not scroll with it, so the strip cannot be the row. And the
 * strip renders nothing at all when no file is open, whereas the picker is always true.
 *
 * `h-tab`, because everything in the row is a 26px chrome control: the picker asks for the chrome
 * tier, and a select is the one control that has to say which tier it is in.
 */
function TabBar({ onClose }: { readonly onClose: (nodeId: string) => void }): React.JSX.Element {
  return (
    <div className="flex h-tab shrink-0 items-stretch border-b border-line bg-canvas">
      <TabStrip onClose={onClose} />
      <div className="ml-auto flex shrink-0 items-center gap-1 px-2">
        <EnvironmentPicker />
      </div>
    </div>
  );
}

function WorkspacePicker({ onCreateWorkspace }: { readonly onCreateWorkspace: () => void }): React.JSX.Element {
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
        {/*
          Directly below opening one, and no separator between them: they are the two answers to
          "which workspace" for someone who is not already in the list above.
        */}
        <DropdownItem onSelect={onCreateWorkspace}>Create new workspace…</DropdownItem>
      </DropdownContent>
    </DropdownMenu>
  );
}

/**
 * The environment selector, and the way into the variable manager beside it.
 *
 * Top-right of the tab bar, and a select rather than a menu because every row in it is a value.
 * The two look alike on purpose and are not the same control: this one reports what is currently
 * true and the workspace picker beside it issues commands. The manager is a separate button for
 * exactly that reason - a list where one row is a command and the rest are values is the kind of
 * control people press by accident.
 *
 * "No environment" is a real option, and saying so is what Phase 6 bought. Core now takes `null`
 * to mean an explicit none, distinct from an absent `env` that leaves the choice open, so the
 * option is neither a lie about a sole environment being used silently nor a dead end on
 * ambiguity. The placeholder only appears while nobody has chosen at all.
 */
function EnvironmentPicker(): React.JSX.Element {
  const environments = useCatalogStore((state) => state.environments);
  const environment = useSessionStore((state) => state.environment);
  const setEnvironment = useSessionStore((state) => state.setEnvironment);
  const showVariables = useOverlayStore((state) => state.showVariables);

  return (
    <>
      {environments.length > 0 && (
        <Select
          tier="chrome"
          aria-label="Environment"
          value={environment === undefined ? UNCHOSEN_ENVIRONMENT : (environment ?? NO_ENVIRONMENT)}
          onValueChange={(value) => {
            setEnvironment(value === NO_ENVIRONMENT ? null : value);
          }}
        >
          {/*
            A distinct value from "No environment", and disabled, because the two are different
            answers: nobody has chosen yet, versus the user chose none. Only reachable with two or
            more environments, since one is adopted the moment the catalog arrives.
          */}
          {environment === undefined && (
            <SelectOption value={UNCHOSEN_ENVIRONMENT} disabled>
              Select environment
            </SelectOption>
          )}
          <SelectOption value={NO_ENVIRONMENT}>No environment</SelectOption>
          {environments.map((candidate) => (
            <SelectOption key={candidate.file} value={candidate.name}>
              {candidate.name}
            </SelectOption>
          ))}
        </Select>
      )}
      {/* Shown even with no environments: globals are variables too, and this is where they read. */}
      <IconButton label="Variables" onClick={showVariables}>
        <EnvironmentIcon />
      </IconButton>
    </>
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
  const searching = useSearchStore((state) => state.showing);
  const toggleSearch = useSearchStore((state) => state.toggle);

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
        <span className="text-xs font-medium text-ink-dim">{searching ? "Search" : "Collections"}</span>
        <div className="flex-1" />
        <IconButton label="Search (Cmd+Shift+F)" active={searching} disabled={root === null} onClick={toggleSearch}>
          <SearchIcon />
        </IconButton>
        <IconButton
          label="New collection"
          disabled={root === null || searching}
          onClick={() => {
            askName("New collection", "Create", "", (name) => {
              void mutate({ op: "create-collection", name }).then(onFail);
            });
          }}
        >
          <NewFolderIcon />
        </IconButton>
      </div>
      {/*
        Swapped, not stacked. The results replace the tree because both want the whole pane, and
        they are two answers to "which request" rather than two things you read together.
      */}
      {searching ? (
        <SearchPane onOpen={openMatch} />
      ) : (
        <Sidebar
          onOpen={open}
          onSend={(node) => {
            open(node);
            void sendNode(node.id).then(onFail);
          }}
          onRun={(node) => {
            useCatalogStore.getState().select(node.id);
            useOverlayStore.getState().showRunner(node.id);
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
          onDrop={(ops) => {
            void applyPlan(ops).then(onFail);
          }}
        />
      )}
    </>
  );
}

/**
 * Follow a search hit: the file it is in, on the section it is in.
 *
 * The section and not the field. The engine can say which key matched, but the editor's controls
 * are uncontrolled and commit on blur, so driving focus into one of them would mean holding a
 * "focus this next" flag through a load. Landing on the right sub-tab with the value in view is
 * the honest version, and for anything the sub-tabs do not cover `sectionFor` lands on YAML,
 * where the matched line is literally visible.
 */
function openMatch(match: GrepMatch): void {
  const node = useCatalogStore.getState().byId.get(match.nodeId);
  if (node === undefined) return;
  useCatalogStore.getState().select(node.id);
  useTabsStore.getState().open(node);
  const section = sectionFor(match.fieldPath);
  if (section !== undefined) useTabsStore.getState().setSubTab(node.id, section);
  void loadTab(node.id);
}

/** Says what is actually about to happen, including that git is the only undo. */
function deleteWarning(node: CatalogNode): string {
  return node.kind === "request"
    ? "The request file is removed from disk. preman has no undo for this, so recover it with git if you need to."
    : "The directory and everything inside it is removed from disk. preman has no undo for this, so recover it with git if you need to.";
}

/**
 * The one strip of chrome along the bottom. It exists for the console toggle: a drawer with no
 * visible handle is a feature nobody finds, and the footer is where every tool in this family
 * puts it.
 */
function StatusBar({
  consoleOpen,
  onToggleConsole,
}: {
  readonly consoleOpen: boolean;
  readonly onToggleConsole: () => void;
}): React.JSX.Element {
  const lines = useRunsStore((state) => state.console.length + state.sideRequests.length);
  const branch = useCatalogStore((state) => state.branch);
  return (
    <div className="flex h-tab shrink-0 items-center gap-2 border-t border-line bg-panel px-2">
      {/*
        The branch, because the tree's marks are meaningless without it: an `M` on every row is
        alarming until you notice you are on a branch where that is expected. Absent rather than
        blank when the workspace is not in a repository, since there is nothing to say.
      */}
      {branch !== null && (
        <span className="flex items-center gap-1 text-2xs text-ink-faint">
          <BranchIcon />
          <span className="max-w-48 truncate font-mono">{branch}</span>
        </span>
      )}
      <div className="flex-1" />
      {lines > 0 && !consoleOpen && <span className="text-2xs text-ink-faint">{String(lines)}</span>}
      <IconButton label="Console" active={consoleOpen} onClick={onToggleConsole}>
        <ConsoleIcon />
      </IconButton>
    </div>
  );
}

/*
 * The crossfade between two overlays. Opacity only: the pane fills a region whose edges do not
 * move, so there is nothing for a translate to explain. The curve is `--ease-out` and the duration
 * is shorter than any token because this one is a swap and not an arrival; both numbers are
 * restated here for the same reason `BANNER_MOTION` restates its own - a custom property is not
 * readable from a Motion transition. Decision 26.
 */
const OVERLAY_HIDDEN = { opacity: 0 } as const;
const OVERLAY_SHOWN = { opacity: 1 } as const;
const OVERLAY_TIMING = { duration: 0.14, ease: [0.23, 1, 0.32, 1] } as const;

function EditorPane({
  onAsk,
  onFail,
}: {
  readonly onAsk: (ask: Ask) => void;
  readonly onFail: Fail;
}): React.JSX.Element {
  const tab = useTabsStore((state) => (state.activeId === null ? undefined : state.tabs.get(state.activeId)));
  const overlay = useOverlayStore((state) => state.overlay);
  const dismiss = useOverlayStore((state) => state.dismiss);
  const nodeId = tab?.nodeId;
  const run = useRunsStore((state) => {
    if (nodeId === undefined) return undefined;
    return [...state.requests.values()].find((request) => request.nodeId === nodeId && request.status === "running");
  });
  const exchange = useDefaultLayout({
    id: EXCHANGE_LAYOUT_ID,
    panelIds: [REQUEST_ID, RESPONSE_ID],
    storage: localStorage,
  });

  /*
   * The runner, the variable manager and settings replace the editor rather than joining the tab
   * strip. None is a file: no unsaved bytes, no dirty dot, nothing to persist as a draft. The strip
   * stays visible above them so returning to what you were editing is one click and no closing.
   */
  if (overlay !== null) {
    return (
      <>
        <TabBar onClose={closeTabOrAsk(onAsk)} />
        {/*
          `mode="wait"` so the two panes never overlap: a settings pane cross-dissolved over a
          runner pane is a double exposure, and here it would also mean two CodeMirror instances
          alive at once. `initial={false}` so the first overlay of a session appears with no fade -
          it was opened by a keystroke or a menu item and the user is already looking at where it
          will be. Keyed on `kind` and not on the object, because the runner variant carries a
          `nodeId` and keying on the object would remount the runner every render.
        */}
        <AnimatePresence mode="wait" initial={false}>
          <m.div
            key={overlay.kind}
            className="flex min-h-0 flex-1 flex-col"
            initial={OVERLAY_HIDDEN}
            animate={OVERLAY_SHOWN}
            exit={OVERLAY_HIDDEN}
            transition={OVERLAY_TIMING}
          >
            <OverlayPane overlay={overlay} onDismiss={dismiss} />
          </m.div>
        </AnimatePresence>
      </>
    );
  }

  return (
    <>
      <TabBar onClose={closeTabOrAsk(onAsk)} />
      {tab === undefined ? (
        <EmptyEditor />
      ) : (
        // The request above, what came back below. Split rather than tabbed because the whole
        // job is comparing the two, and a tab strip that hides one of them makes you click to
        // remember what you sent.
        <Group
          orientation="vertical"
          className="min-h-0 flex-1"
          defaultLayout={exchange.defaultLayout}
          onLayoutChanged={exchange.onLayoutChanged}
        >
          <Panel id={REQUEST_ID} defaultSize={REQUEST_DEFAULT} minSize={REQUEST_MIN} className="flex min-h-0 flex-col">
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
              onAsk={onAsk}
              onFail={onFail}
            />
          </Panel>
          <Separator className="group relative z-handle h-px shrink-0 cursor-row-resize bg-line data-[state=drag]:bg-accent">
            <span className="absolute inset-x-0 -inset-y-1 group-hover:bg-accent/40" />
          </Separator>
          <Panel id={RESPONSE_ID} minSize={RESPONSE_MIN} className="flex min-h-0 flex-col">
            <ResponsePane nodeId={tab.nodeId} />
          </Panel>
        </Group>
      )}
    </>
  );
}

/**
 * Which of the three non-file panes is up. Exhaustive on `kind`, so a fourth one is a type error
 * here rather than a blank editor area at runtime.
 */
function OverlayPane({
  overlay,
  onDismiss,
}: {
  readonly overlay: Overlay;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  switch (overlay.kind) {
    case "variables":
      return <VariablesPane onDismiss={onDismiss} />;
    case "runner":
      return <RunnerPane nodeId={overlay.nodeId} onDismiss={onDismiss} />;
    case "settings":
      return <SettingsPane onDismiss={onDismiss} />;
  }
}

/**
 * Closing a tab, with the one question worth asking.
 *
 * `closeTab` closes a clean tab outright and hands back a dirty one, so the only tab that ever
 * reaches a dialog is a tab with work in it. Hoisted because the tab strip is rendered twice -
 * once over the editor and once over an overlay - and a second copy of this would eventually be
 * the copy that forgot to ask.
 */
function closeTabOrAsk(onAsk: (ask: Ask) => void): (nodeId: string) => void {
  return (nodeId) => {
    const unsaved = closeTab(nodeId);
    if (unsaved === null) return;
    onAsk({
      kind: "confirm",
      title: `Close ${unsaved.title}?`,
      body: "This request has unsaved changes. Closing the tab discards them.",
      submit: "Discard changes",
      onConfirm: () => {
        discardAndClose(nodeId);
      },
    });
  };
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

/*
 * The three banners are conditional renders, so the `return null` lives inside `AnimatePresence`
 * rather than above it: a component that has already returned null has nothing mounted for the
 * exit to run on. Not `mode="popLayout"` - that measures layout on the child on its way out.
 */
function HostBanner(): React.JSX.Element {
  const hostFailure = useSessionStore((state) => state.hostFailure);
  return (
    <AnimatePresence>
      {hostFailure === null ? null : (
        <Banner tone="danger" message={hostFailure.message} details={hostFailure.details}>
          <Button
            onClick={() => {
              void switchWorkspace(hostFailure.root);
            }}
          >
            Retry
          </Button>
        </Banner>
      )}
    </AnimatePresence>
  );
}

function DegradedBanner(): React.JSX.Element {
  const degraded = useSessionStore((state) => state.degraded);
  const setDegraded = useSessionStore((state) => state.setDegraded);
  return (
    <AnimatePresence>
      {degraded === null ? null : (
        <Banner tone="warn" message={degraded} details={[]}>
          <Button
            onClick={() => {
              setDegraded(null);
            }}
          >
            Dismiss
          </Button>
        </Banner>
      )}
    </AnimatePresence>
  );
}

function FailureBanner({
  failure,
  onDismiss,
}: {
  readonly failure: Failure | null;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  return (
    <AnimatePresence>
      {failure === null ? null : (
        <Banner tone="danger" message={failure.message} details={failure.details}>
          <Button onClick={onDismiss}>Dismiss</Button>
        </Banner>
      )}
    </AnimatePresence>
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
    <m.div
      role="alert"
      {...BANNER_MOTION}
      className={`flex shrink-0 items-start gap-2 border-b px-3 py-2 text-xs ${palette}`}
    >
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
    </m.div>
  );
}
