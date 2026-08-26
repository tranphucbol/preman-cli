/**
 * App lifecycle, one window, the native menu, native dialogs.
 *
 * This process holds no workspace state: no catalog, no bodies, no watcher. When it
 * needs to know what a workspace contains it does not — it asks nobody, because the
 * renderer asks its own engine host over a port this file only hands over.
 */
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";
// The only engine module this process imports at startup, and it is thirty lines of declarations.
// Everything migration needs is behind the `import()` in `migration()` below.
import { PremanError } from "@preman/core/errors.js";
import type * as MigrationApi from "@preman/core/api/migrate.js";
import { createHostRegistry, type HostRegistry } from "@preman/desktop/main/hosts.js";
import { createAppStore, type AppStore } from "@preman/desktop/main/store.js";
import { createWorkspace } from "@preman/desktop/main/workspaces.js";
import { markPhase, PHASES } from "@preman/desktop/engine/protocol.js";
import {
  CHANNELS,
  TRAFFIC_LIGHT_HEIGHT_PX,
  TRAFFIC_LIGHT_INSET_PX,
  type CloudWorkspaceListResult,
  type MigrateFailure,
  type MigrateResult,
  type Preferences,
  type SessionSnapshot,
  type WindowChrome,
  type WindowControl,
  type WorkspaceHandle,
} from "@preman/desktop/preload/bridge.js";

/**
 * Set before anything reads `app.getPath("userData")`. Unpackaged, Electron names the app after
 * its own binary, so `bun run desktop` and an installed build would keep their state in different
 * directories and disagree about which workspaces exist.
 */
const APP_NAME = "preman";
const MIN_WIDTH = 900;
const MIN_HEIGHT = 560;
const DEV_SERVER_ENV_VAR = "PREMAN_DEV_SERVER";
const PRELOAD_FILE = "../preload/preload.cjs";
const RENDERER_FILE = "../renderer/index.html";
const ENGINE_FILE = "../engine/entry.js";
const ICON_FILE = "icon.png";
const WORKSPACE_MARKERS = [join(".postman", "resources.yaml"), join("postman", "collections")];
const DIALOG_TITLE = "Open a Postman workspace";
const DATA_DIALOG_TITLE = "Choose iteration data";
const DATA_FILTER_NAME = "Iteration data";
/** What core's `loadIterationData` reads. Offering more would only produce a refusal later. */
const ITERATION_DATA_EXTENSIONS = ["json", "csv"] as const;
const REPORT_DIALOG_TITLE = "Export run report";
const REPORT_ENCODING = "utf8";
const MIGRATE_DIALOG_TITLE = "Choose an empty directory for the migrated workspace";
const MIGRATE_DIALOG_BUTTON = "Migrate here";
/**
 * Postman Desktop's application data, under the same parent Electron gives this app: macOS's
 * `Application Support`, Windows's `%APPDATA%`, `~/.config` elsewhere. Asked rather than guessed,
 * which is the one advantage the window has over the CLI's `defaultPostmanAppData`.
 */
const POSTMAN_APP_DATA_DIR = "Postman";
/** A rejection with no sentence in it. Better than reporting `undefined` to the user. */
const UNEXPECTED_MIGRATION_FAILURE = "The migration did not finish.";
const FRAMELESS_PLATFORM = "darwin";
const HALF = 2;

// At module scope, not in `start()`: `userData` is resolved the first time it is asked for, and
// by `whenReady` that has already happened.
app.setName(APP_NAME);

let window: BrowserWindow | undefined;
let hosts: HostRegistry | undefined;
let store: AppStore | undefined;

/**
 * The workspace this launch decided to reopen, if any. Module scope rather than a local in
 * `start()` because the renderer asks for it: the window has to be able to say "opening" before
 * any engine port exists, and this is the only process that knows.
 *
 * Never cleared. It is a fact about the launch, not about the current session, and the renderer
 * drops its own copy the moment a port arrives - so an answer that outlives the reopen is answered
 * to nobody.
 */
let reopening: string | null = null;

/** Resolved against the built `dist/main/`, so dev and packaged agree on layout. */
function distPath(relative: string): string {
  return join(import.meta.dirname, relative);
}

/**
 * The app icon, or nothing. An unreadable icon is a cosmetic loss, not a reason to refuse to
 * start, and `nativeImage` reports that as an empty image rather than by throwing.
 */
function appIcon(): Electron.NativeImage | undefined {
  const image = nativeImage.createFromPath(distPath(ICON_FILE));
  return image.isEmpty() ? undefined : image;
}

function requireStore(): AppStore {
  if (store === undefined) throw new Error("the app store is not ready");
  return store;
}

function requireHosts(): HostRegistry {
  if (hosts === undefined) throw new Error("the host registry is not ready");
  return hosts;
}

/**
 * Refuse a directory that is not a workspace here, in the dialog, rather than letting
 * the engine host spawn and fail. `findWorkspace` walks up; this deliberately does not,
 * because the user picked exactly this directory.
 */
function looksLikeWorkspace(root: string): boolean {
  return WORKSPACE_MARKERS.some((marker) => existsSync(join(root, marker)));
}

/**
 * macOS only, and deliberately: `hiddenInset` takes the native bar away and leaves the traffic
 * lights, so the app gets a row back without owing the user a hand-drawn close button. Every other
 * platform keeps its frame until someone can test a frameless build on it. The renderer learns how
 * much room the lights need through `titleBarGutter`, not by asking what platform it is on.
 */
function framelessOptions(barHeightPx: number): Electron.BrowserWindowConstructorOptions {
  if (process.platform !== FRAMELESS_PLATFORM) return {};
  return {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: trafficLightPosition(barHeightPx),
  };
}

/** Centred in the bar, whatever height the density made the bar. */
function trafficLightPosition(barHeightPx: number): Electron.Point {
  return { x: TRAFFIC_LIGHT_INSET_PX, y: Math.round((barHeightPx - TRAFFIC_LIGHT_HEIGHT_PX) / HALF) };
}

/**
 * Repaint the window itself, which no stylesheet can reach.
 *
 * `backgroundColor` is what Chromium shows before and around the document — behind an overscroll,
 * and for the frame between the window appearing and the first paint. Left at the dark default
 * under a light theme it is a white app in a black frame, which is exactly the flash the
 * synchronous preference read exists to avoid.
 */
function applyWindowChrome(chrome: WindowChrome): void {
  if (window === undefined) return;
  window.setBackgroundColor(chrome.canvas);
  if (process.platform === FRAMELESS_PLATFORM) window.setWindowButtonPosition(trafficLightPosition(chrome.barHeightPx));
}

function createWindow(): BrowserWindow {
  const { window: saved, preferences } = requireStore().read();
  const icon = appIcon();
  const created = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(saved.x === null || saved.y === null ? {} : { x: saved.x, y: saved.y }),
    // Windows and Linux take the icon from the window; macOS takes it from the dock, set in
    // `start()`. Passing it here as well is harmless there and is what the other two read.
    ...(icon === undefined ? {} : { icon }),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    // The stored copy of the theme's canvas, not a constant: this is decided before any script
    // runs, so it is the one appearance value the main process has to be told rather than shown.
    backgroundColor: preferences.canvas,
    show: false,
    ...framelessOptions(preferences.barHeightPx),
    webPreferences: {
      preload: distPath(PRELOAD_FILE),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // No remote content is ever loaded, so nothing needs to reach the network.
      webviewTag: false,
    },
  });

  created.once("ready-to-show", () => {
    created.show();
    markPhase(PHASES.mainWindowShown);
  });

  // `ready-to-show` never fires if the document never paints, and a window that stays hidden is
  // indistinguishable from an app that did not start. Say what went wrong and show it anyway.
  created.webContents.on("did-fail-load", (_event, code, description, url) => {
    process.stderr.write(`preman: the renderer failed to load ${url}: ${description} (${String(code)})\n`);
    created.show();
  });
  created.webContents.on("render-process-gone", (_event, details) => {
    process.stderr.write(`preman: the renderer process is gone: ${details.reason}\n`);
  });

  created.on("close", () => {
    const bounds = created.getBounds();
    requireStore().update((state) => {
      state.window = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    });
  });

  const devServer = process.env[DEV_SERVER_ENV_VAR];
  if (devServer === undefined) void created.loadFile(distPath(RENDERER_FILE));
  else void created.loadURL(devServer);

  return created;
}

/**
 * Settings, in the place each platform keeps it. macOS puts it in the app menu under About, which
 * means spelling that submenu out instead of taking the `appMenu` role wholesale; everywhere else
 * it belongs in File. The accelerator is the same on both, and the renderer binds it too — a menu
 * item is a discoverability affordance, not the only way in.
 */
const SETTINGS_ITEM: MenuItemConstructorOptions = {
  label: "Settings…",
  accelerator: "CmdOrCtrl+,",
  click: () => {
    window?.webContents.send(CHANNELS.openSettings);
  },
};

function appMenu(): MenuItemConstructorOptions[] {
  if (process.platform !== "darwin") return [];
  return [
    {
      role: "appMenu",
      submenu: [
        { role: "about" },
        { type: "separator" },
        SETTINGS_ITEM,
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
  ];
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...appMenu(),
    {
      label: "File",
      submenu: [
        {
          label: "Open Workspace…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => {
            void openWorkspaceDialog();
          },
        },
        // No accelerator: creating a workspace is a once-in-a-while action, and the menu plus the
        // command palette make it findable without spending another global key combination.
        {
          label: "Create New Workspace…",
          click: () => {
            // Sends rather than asks: Electron has no native text-input dialog, so the name is
            // collected by the one renderer dialog the dropdown and the palette also open.
            window?.webContents.send(CHANNELS.openCreateWorkspace);
          },
        },
        // Sends for the same reason the item above it does: the list of cloud workspaces and the
        // report of what was migrated are both renderer state, and neither is a native dialog.
        {
          label: "Migrate from Postman…",
          click: () => {
            window?.webContents.send(CHANNELS.openMigrate);
          },
        },
        ...(process.platform === "darwin" ? [] : [{ type: "separator" as const }, SETTINGS_ITEM]),
        { type: "separator" },
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openWorkspaceDialog(): Promise<string | null> {
  const parent = window;
  if (parent === undefined) return null;
  const picked = await dialog.showOpenDialog(parent, {
    title: DIALOG_TITLE,
    properties: ["openDirectory", "createDirectory"],
  });
  const root = picked.filePaths[0];
  if (picked.canceled || root === undefined) return null;

  if (!looksLikeWorkspace(root)) {
    await dialog.showMessageBox(parent, {
      type: "warning",
      message: "That directory is not a Postman workspace",
      detail: `Expected ${WORKSPACE_MARKERS.join(" or ")} inside:\n${root}`,
    });
    return null;
  }
  return root;
}

/**
 * A file for the runner to iterate over. Filtered to what `loadIterationData` accepts, so
 * the dialog cannot hand the engine a file it is going to refuse.
 */
async function pickDataFileDialog(): Promise<string | null> {
  const parent = window;
  if (parent === undefined) return null;
  const picked = await dialog.showOpenDialog(parent, {
    title: DATA_DIALOG_TITLE,
    properties: ["openFile"],
    filters: [{ name: DATA_FILTER_NAME, extensions: [...ITERATION_DATA_EXTENSIONS] }],
  });
  const file = picked.filePaths[0];
  return picked.canceled || file === undefined ? null : file;
}

/**
 * Write an already-rendered report wherever the user says. The bytes come from the engine
 * and the path from the dialog, so the renderer never names a file system location.
 */
async function saveReportDialog(suggestedName: string, text: string): Promise<string | null> {
  const parent = window;
  if (parent === undefined) return null;
  const picked = await dialog.showSaveDialog(parent, { title: REPORT_DIALOG_TITLE, defaultPath: suggestedName });
  if (picked.canceled || picked.filePath === undefined) return null;

  writeFileSync(picked.filePath, text, REPORT_ENCODING);
  return picked.filePath;
}

/**
 * Where a migrated workspace goes. `createDirectory` is offered because an empty directory is
 * exactly what `applyPlan` insists on, and making one in the dialog is the shortest way to it.
 */
async function migrateDestinationDialog(): Promise<string | null> {
  const parent = window;
  if (parent === undefined) return null;
  const picked = await dialog.showOpenDialog(parent, {
    title: MIGRATE_DIALOG_TITLE,
    buttonLabel: MIGRATE_DIALOG_BUTTON,
    properties: ["openDirectory", "createDirectory"],
  });
  const root = picked.filePaths[0];
  return picked.canceled || root === undefined ? null : root;
}

function postmanAppData(): string {
  return join(app.getPath("appData"), POSTMAN_APP_DATA_DIR);
}

/**
 * The migration half of the engine, loaded the first time someone asks for it.
 *
 * A deep import rather than `@preman/core`, because the barrel would bring `@grpc/grpc-js` into a
 * bundle that externalises nothing. Dynamic rather than static, because zod is most of what this
 * subtree weighs and a statically imported one took `dist/main/main.js` from 31 kB to 410 kB — four
 * hundred kilobytes parsed on every cold start for a feature most installs run once, if ever. This
 * is also why the two handlers below are the only callers: `import()` in a third place would be a
 * third chunk boundary to reason about.
 */
function migration(): Promise<typeof MigrationApi> {
  return import("@preman/core/api/migrate.js");
}

/**
 * A thrown engine error turned into a value the renderer can draw.
 *
 * `details[]` is carried through rather than folded into the message: "Postman Desktop does not
 * appear to be running" is the failure and "open Postman Desktop and sign in, then try again" is
 * the advice, and a pane that ran them together would be a pane that had to re-split them.
 */
function migrationFailure(cause: unknown): MigrateFailure {
  if (cause instanceof PremanError) {
    return { status: "failed", message: cause.message, details: [...cause.details] };
  }
  return {
    status: "failed",
    message: cause instanceof Error ? cause.message : UNEXPECTED_MIGRATION_FAILURE,
    details: [],
  };
}

function openWorkspace(root: string): void {
  const contents = window?.webContents;
  if (contents === undefined) return;

  const previous = requireStore().read().activeRoot;
  if (previous !== null && previous !== root) requireHosts().release(previous);

  requireStore().update((state) => {
    state.activeRoot = root;
  });
  const workspace = requireStore().workspaceFor(root);
  requireStore().update(() => {
    workspace.lastOpenedAt = Date.now();
  });
  requireHosts().open(root, contents);
}

function registerIpc(): void {
  ipcMain.handle(CHANNELS.listWorkspaces, (): WorkspaceHandle[] => requireStore().handles());

  ipcMain.handle(CHANNELS.pickWorkspace, () => openWorkspaceDialog());

  ipcMain.handle(CHANNELS.openWorkspace, (_event: IpcMainInvokeEvent, root: string) => {
    openWorkspace(root);
  });

  // Registered before `start()` decides, which costs nothing: the rest of `start()` runs in the
  // same turn, so the value is settled long before a renderer exists to ask for it.
  ipcMain.handle(CHANNELS.readReopening, (): string | null => reopening);

  // The home directory is resolved here, never in the renderer and never by a shell: `~` is
  // documentation, and a renderer that could name a destination would be a renderer with a path.
  // Creation stops at the directories; the renderer opens the result over `openWorkspace`, so
  // there is no creation-specific host lifecycle.
  ipcMain.handle(CHANNELS.createWorkspace, (_event: IpcMainInvokeEvent, name: string) =>
    createWorkspace(homedir(), name),
  );

  // Both migration handlers live here rather than in an engine host: there is no workspace to host
  // yet, and the credential they need is harvested from Postman Desktop, not from a workspace.
  ipcMain.handle(CHANNELS.listPostmanWorkspaces, async (): Promise<CloudWorkspaceListResult> => {
    try {
      const { listCloudWorkspaces } = await migration();
      return { status: "listed", workspaces: await listCloudWorkspaces({ postmanAppData: postmanAppData() }) };
    } catch (cause) {
      return migrationFailure(cause);
    }
  });

  // The destination comes from the dialog, never from the renderer. Opening the result goes through
  // `openWorkspace`, the same path a recent workspace takes, so migrating adds no host lifecycle.
  ipcMain.handle(
    CHANNELS.migratePostmanWorkspace,
    async (_event: IpcMainInvokeEvent, workspaceId: string): Promise<MigrateResult> => {
      const target = await migrateDestinationDialog();
      if (target === null) return { status: "cancelled" };

      try {
        const { migrateCloudWorkspace } = await migration();
        const outcome = await migrateCloudWorkspace({
          postmanAppData: postmanAppData(),
          workspace: workspaceId,
          target,
          dryRun: false,
          // Sent as it arrives, unthrottled: core already reports about a hundred times over the
          // whole migration rather than once per read, so there is nothing here worth coalescing
          // and a coalescer would be one more place the last report could be the one dropped.
          onProgress: (progress) => {
            window?.webContents.send(CHANNELS.migrateProgress, progress);
          },
        });
        return { status: "migrated", outcome };
      } catch (cause) {
        return migrationFailure(cause);
      }
    },
  );

  ipcMain.handle(CHANNELS.forgetWorkspace, (_event: IpcMainInvokeEvent, root: string) => {
    requireHosts().release(root);
    requireStore().update((state) => {
      state.workspaces = state.workspaces.filter((workspace) => workspace.root !== root);
      if (state.activeRoot === root) state.activeRoot = null;
    });
  });

  ipcMain.handle(CHANNELS.revealInFileManager, (_event: IpcMainInvokeEvent, target: string) => {
    shell.showItemInFolder(target);
  });

  ipcMain.handle(CHANNELS.pickDataFile, () => pickDataFileDialog());

  ipcMain.handle(CHANNELS.saveReport, (_event: IpcMainInvokeEvent, suggestedName: string, text: string) =>
    saveReportDialog(suggestedName, text),
  );

  ipcMain.handle(CHANNELS.readSession, (_event: IpcMainInvokeEvent, root: string): SessionSnapshot =>
    requireStore().sessionFor(root),
  );

  ipcMain.handle(CHANNELS.saveSession, (_event: IpcMainInvokeEvent, root: string, snapshot: SessionSnapshot) => {
    requireStore().saveSession(root, snapshot);
  });

  // `on` with `returnValue`, not `handle`: this is the one blocking call in the app, and it is
  // blocking on purpose. The renderer reads it in the preload, before the document has a script,
  // so that the first frame it paints is already the right colour. See `docs/decisions/022`.
  ipcMain.on(CHANNELS.readPreferences, (event) => {
    event.returnValue = requireStore().read().preferences;
  });

  ipcMain.handle(CHANNELS.savePreferences, (_event: IpcMainInvokeEvent, next: Preferences) => {
    requireStore().update((state) => {
      state.preferences = next;
    });
  });

  ipcMain.on(CHANNELS.setWindowChrome, (_event, chrome: WindowChrome) => {
    applyWindowChrome(chrome);
  });

  ipcMain.on(CHANNELS.windowControl, (_event, action: WindowControl) => {
    if (window === undefined) return;
    if (action === "close") window.close();
    else if (action === "minimise") window.minimize();
    else if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
}

function start(): void {
  // Not this process's true beginning: `app.whenReady()` has already happened, and the fifty-odd
  // milliseconds of spawn before any JavaScript runs are excluded from the cold-start row for the
  // same reason. `timeOrigin`, which `readPhases` reports, is the earlier anchor.
  markPhase(PHASES.mainStart);

  // Unpackaged, the dock shows Electron's own icon: only `app.dock` can correct that, and only
  // after `whenReady`. A packaged build takes its icon from the bundle and ignores this.
  const dockIcon = appIcon();
  if (app.dock !== undefined && dockIcon !== undefined) app.dock.setIcon(dockIcon);

  store = createAppStore(app.getPath("userData"));
  hosts = createHostRegistry({
    entryFile: distPath(ENGINE_FILE),
    onFailure: (failure) => window?.webContents.send(CHANNELS.hostFailure, failure),
  });

  registerIpc();
  buildMenu();

  // Reopening the last workspace is why `activeRoot` is persisted at all. The port transfer waits
  // for `did-finish-load`, because a port sent to a document that has not run its script yet is a
  // port nobody is listening on — but the fork does not. Spawning the host here overlaps a Node
  // process starting with Chromium starting, which is a quarter of a second of the cold start that
  // was previously spent queueing behind the window.
  //
  // Above `createWindow` and not below it: reading the icon, constructing the BrowserWindow and
  // `loadFile` measured 400-520ms on a cold start, and every one of those milliseconds was the
  // engine not yet reading its own bundle off the same disk. Nothing here touches the window.
  const last = requireStore().read().activeRoot;
  reopening = last !== null && looksLikeWorkspace(last) ? last : null;
  if (reopening !== null) requireHosts().prewarm(reopening);
  markPhase(PHASES.mainPrewarm);

  window = createWindow();

  window.webContents.once("did-finish-load", () => {
    if (reopening !== null) openWorkspace(reopening);
  });

  window.on("closed", () => {
    window = undefined;
  });
}

app.on("window-all-closed", () => {
  hosts?.closeAll();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (window === undefined) window = createWindow();
});

app.on("before-quit", () => {
  hosts?.closeAll();
});

void app.whenReady().then(start);
