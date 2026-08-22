/**
 * App lifecycle, one window, the native menu, native dialogs.
 *
 * This process holds no workspace state: no catalog, no bodies, no watcher. When it
 * needs to know what a workspace contains it does not — it asks nobody, because the
 * renderer asks its own engine host over a port this file only hands over.
 */
import { existsSync, writeFileSync } from "node:fs";
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
import { createHostRegistry, type HostRegistry } from "@preman/desktop/main/hosts.js";
import { createAppStore, type AppStore } from "@preman/desktop/main/store.js";
import {
  CHANNELS,
  TITLE_BAR_HEIGHT_PX,
  TRAFFIC_LIGHT_HEIGHT_PX,
  TRAFFIC_LIGHT_INSET_PX,
  type SessionSnapshot,
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
const BACKGROUND_COLOUR = "#111214";
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
const FRAMELESS_PLATFORM = "darwin";
const HALF = 2;

// At module scope, not in `start()`: `userData` is resolved the first time it is asked for, and
// by `whenReady` that has already happened.
app.setName(APP_NAME);

let window: BrowserWindow | undefined;
let hosts: HostRegistry | undefined;
let store: AppStore | undefined;

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
function framelessOptions(): Electron.BrowserWindowConstructorOptions {
  if (process.platform !== FRAMELESS_PLATFORM) return {};
  return {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: {
      x: TRAFFIC_LIGHT_INSET_PX,
      y: (TITLE_BAR_HEIGHT_PX - TRAFFIC_LIGHT_HEIGHT_PX) / HALF,
    },
  };
}

function createWindow(): BrowserWindow {
  const saved = requireStore().read().window;
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
    backgroundColor: BACKGROUND_COLOUR,
    show: false,
    ...framelessOptions(),
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

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
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

  ipcMain.on(CHANNELS.windowControl, (_event, action: WindowControl) => {
    if (window === undefined) return;
    if (action === "close") window.close();
    else if (action === "minimise") window.minimize();
    else if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
}

function start(): void {
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
  window = createWindow();

  // Reopening the last workspace is why `activeRoot` is persisted at all. It waits for
  // `did-finish-load` because `openWorkspace` transfers a port to the renderer, and a port sent
  // to a document that has not run its script yet is a port nobody is listening on.
  window.webContents.once("did-finish-load", () => {
    const last = requireStore().read().activeRoot;
    if (last !== null && looksLikeWorkspace(last)) openWorkspace(last);
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
