/**
 * The whole of the renderer's access to the operating system.
 *
 * Everything here is a named capability with a fixed shape. There is no generic
 * `invoke(channel, ...args)` escape hatch, because one of those is the same thing as
 * `nodeIntegration: true` with extra steps.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  CHANNELS,
  DEFAULT_PREFERENCES,
  ENGINE_PORT_WINDOW_MESSAGE,
  TITLE_BAR_GUTTER_PX,
  type CloudWorkspaceListResult,
  type CreateWorkspaceResult,
  type DiagnosticsInfo,
  type EnginePortDelivery,
  type HostFailure,
  type MigrateResult,
  type MigrationProgress,
  type Preferences,
  type PremanBridge,
  type ResourceSample,
  type SessionSnapshot,
  type WindowChrome,
  type WindowControl,
  type WorkspaceHandle,
} from "@preman/desktop/preload/bridge.js";

const BRIDGE_KEY = "preman";
const ANY_ORIGIN = "*";
const FIRST_PORT = 0;
const FRAMELESS_PLATFORM = "darwin";
const NO_GUTTER = 0;

/**
 * The preferences, read once and synchronously, before the document has run a line of its own.
 *
 * `sendSync` blocks this process on the main one, which is normally the wrong trade. Here it buys
 * the thing an async read cannot: the renderer already has the theme when it writes its custom
 * properties, so its first frame is the right colour rather than the default one corrected a tick
 * later. It is one small object, once per window. A malformed reply is not worth failing to start
 * over, so it falls back to the defaults — the same thing a fresh install gets.
 */
function readPreferences(): Preferences {
  try {
    const raw: unknown = ipcRenderer.sendSync(CHANNELS.readPreferences);
    if (typeof raw !== "object" || raw === null) return { ...DEFAULT_PREFERENCES };
    return { ...DEFAULT_PREFERENCES, ...(raw as Partial<Preferences>) };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * The one DOM capability a preload needs. Declared rather than pulling `lib.dom` into
 * a program that also holds the main process, which has no business having a `window`.
 */
interface TransferringWindow {
  postMessage(message: unknown, targetOrigin: string, transfer: readonly unknown[]): void;
}

/**
 * `IpcRendererEvent.ports` is `MessagePort[]`, a DOM type this program has no `lib` for. The port
 * is only ever forwarded, never used here, so the narrowest honest type is an opaque one.
 */
interface PortCarryingEvent {
  readonly ports: readonly unknown[];
}

const bridge: PremanBridge = {
  // Read here rather than over a channel: it cannot change while the window is open, and a
  // title bar that lays itself out one paint late would shift under the pointer.
  titleBarGutter: process.platform === FRAMELESS_PLATFORM ? TITLE_BAR_GUTTER_PX : NO_GUTTER,
  preferences: readPreferences(),
  onHostFailure(listener) {
    const handler = (_event: IpcRendererEvent, failure: HostFailure): void => {
      listener(failure);
    };
    ipcRenderer.on(CHANNELS.hostFailure, handler);
    return () => {
      ipcRenderer.off(CHANNELS.hostFailure, handler);
    };
  },
  listWorkspaces: () => ipcRenderer.invoke(CHANNELS.listWorkspaces) as Promise<WorkspaceHandle[]>,
  pickWorkspaceDirectory: () => ipcRenderer.invoke(CHANNELS.pickWorkspace) as Promise<string | null>,
  openWorkspace: (root: string) => ipcRenderer.invoke(CHANNELS.openWorkspace, root) as Promise<void>,
  reopening: () => ipcRenderer.invoke(CHANNELS.readReopening) as Promise<string | null>,
  createWorkspace: (name: string) =>
    ipcRenderer.invoke(CHANNELS.createWorkspace, name) as Promise<CreateWorkspaceResult>,
  forgetWorkspace: (root: string) => ipcRenderer.invoke(CHANNELS.forgetWorkspace, root) as Promise<void>,
  revealInFileManager: (target: string) => ipcRenderer.invoke(CHANNELS.revealInFileManager, target) as Promise<void>,
  pickDataFile: () => ipcRenderer.invoke(CHANNELS.pickDataFile) as Promise<string | null>,
  pickProtoFiles: () => ipcRenderer.invoke(CHANNELS.pickProtoFiles) as Promise<string[]>,
  pickProtoFolder: () => ipcRenderer.invoke(CHANNELS.pickProtoFolder) as Promise<string | null>,
  pickCheckout: (name: string, startIn: string | null) =>
    ipcRenderer.invoke(CHANNELS.pickCheckout, name, startIn) as Promise<string | null>,
  saveReport: (suggestedName: string, text: string) =>
    ipcRenderer.invoke(CHANNELS.saveReport, suggestedName, text) as Promise<string | null>,
  controlWindow: (action: WindowControl) => {
    ipcRenderer.send(CHANNELS.windowControl, action);
  },
  readSession: (root: string) => ipcRenderer.invoke(CHANNELS.readSession, root) as Promise<SessionSnapshot>,
  saveSession: (root: string, snapshot: SessionSnapshot) =>
    ipcRenderer.invoke(CHANNELS.saveSession, root, snapshot) as Promise<void>,
  savePreferences: (next: Preferences) => ipcRenderer.invoke(CHANNELS.savePreferences, next) as Promise<void>,
  setWindowChrome: (chrome: WindowChrome) => {
    ipcRenderer.send(CHANNELS.setWindowChrome, chrome);
  },
  onOpenSettings(listener) {
    const handler = (): void => {
      listener();
    };
    ipcRenderer.on(CHANNELS.openSettings, handler);
    return () => {
      ipcRenderer.off(CHANNELS.openSettings, handler);
    };
  },
  // The same unsubscribe-safe shape as `onOpenSettings` above: the renderer re-subscribes whenever
  // its callback changes identity, and a listener that could not be removed would stack.
  onCreateWorkspace(listener) {
    const handler = (): void => {
      listener();
    };
    ipcRenderer.on(CHANNELS.openCreateWorkspace, handler);
    return () => {
      ipcRenderer.off(CHANNELS.openCreateWorkspace, handler);
    };
  },
  onMigrate(listener) {
    const handler = (): void => {
      listener();
    };
    ipcRenderer.on(CHANNELS.openMigrate, handler);
    return () => {
      ipcRenderer.off(CHANNELS.openMigrate, handler);
    };
  },
  listPostmanWorkspaces: () => ipcRenderer.invoke(CHANNELS.listPostmanWorkspaces) as Promise<CloudWorkspaceListResult>,
  migratePostmanWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke(CHANNELS.migratePostmanWorkspace, workspaceId) as Promise<MigrateResult>,
  onMigrateProgress(listener) {
    const handler = (_event: IpcRendererEvent, progress: MigrationProgress): void => {
      listener(progress);
    };
    ipcRenderer.on(CHANNELS.migrateProgress, handler);
    return () => {
      ipcRenderer.off(CHANNELS.migrateProgress, handler);
    };
  },
  diagnostics: () => ipcRenderer.invoke(CHANNELS.readDiagnostics) as Promise<DiagnosticsInfo>,
  onResourceSample(listener) {
    const handler = (_event: IpcRendererEvent, sample: ResourceSample): void => {
      listener(sample);
    };
    ipcRenderer.on(CHANNELS.resourceSample, handler);
    return () => {
      ipcRenderer.off(CHANNELS.resourceSample, handler);
    };
  },
  // Deliberately not paired with the subscription above. Unsubscribing is a renderer-side fact and
  // stopping the sampler is a main-side one, and collapsing them would mean a component that
  // re-subscribes on a callback identity change also stopping and restarting main's interval —
  // which would re-prime, and throw away the first second of every re-render.
  watchResources: (watching: boolean) => {
    ipcRenderer.send(CHANNELS.watchResources, watching);
  },
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);

// The port itself goes the other way: `contextBridge` cannot carry a `MessagePort`,
// `window.postMessage` can. The renderer listens for this tag and takes `event.ports[0]`.
ipcRenderer.on(CHANNELS.enginePort, (event: IpcRendererEvent, payload: { root: string }) => {
  const port = (event as unknown as PortCarryingEvent).ports[FIRST_PORT];
  if (port === undefined) return;
  const delivery: EnginePortDelivery = { kind: ENGINE_PORT_WINDOW_MESSAGE, root: payload.root };
  (globalThis as unknown as TransferringWindow).postMessage(delivery, ANY_ORIGIN, [port]);
});
